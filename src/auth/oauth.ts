import { randomBytes, createHash } from 'node:crypto'
import { oauthProvider, redirectUri, type ProviderName, type Site } from '../config.js'

// OAuth 2.0 Authorization Code flow with PKCE. The code→token exchange happens here
// (server-side), so the client secret never reaches the browser.

export interface PkceState {
  state: string
  codeVerifier: string
}

export interface OAuthIdentity {
  sub: string
  email: string | null
  displayName: string | null
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

// Yandex OAuth answers a share of requests with 429 or a 5xx when it is busy — after the Yandex Cloud
// outage of 2026-10-11 about one in three, so a sign-in that tried once failed for a third of the
// players. A refusal like that is not about the request, so the same request is sent again after a
// short pause; anything else (400 invalid_grant and friends) is the answer and is returned at once.
// An authorization code survives a refused exchange: Yandex never processed it.
const RETRY_DELAYS_MS = [400, 1000, 2000]

export async function fetchRetrying(url: string, init: RequestInit, delays = RETRY_DELAYS_MS): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetch(url, init)
      if (res.status !== 429 && res.status < 500) return res
    } catch (e) {
      if (attempt >= delays.length) throw e
    }
    if (attempt >= delays.length) return res as Response
    await res?.body?.cancel().catch(() => {})
    await new Promise((r) => setTimeout(r, delays[attempt]))
  }
}

export function createPkceState(): PkceState {
  return {
    state: b64url(randomBytes(24)),
    codeVerifier: b64url(randomBytes(48)),
  }
}

// `site` picks which api host's /callback Yandex sends the user back to (host-aware, see
// config.ts siteForHost) — it must be one of the Redirect URIs registered for the OAuth app.
export function buildAuthUrl(provider: ProviderName, pkce: PkceState, site?: Site): string {
  const p = oauthProvider(provider)
  const challenge = b64url(createHash('sha256').update(pkce.codeVerifier).digest())
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: redirectUri(provider, site),
    scope: p.scope,
    state: pkce.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...p.authParams,
  })
  return `${p.authUrl}?${params.toString()}`
}

// `site` must resolve to the same host the authorize step used — the token exchange's
// redirect_uri has to match the authorize-time value. Both derive from the request Host, and
// the callback always arrives on the host named in redirect_uri, so they agree by construction.
export async function exchangeCode(
  provider: ProviderName,
  code: string,
  codeVerifier: string,
  site?: Site,
): Promise<string> {
  const p = oauthProvider(provider)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(provider, site),
    client_id: p.clientId,
    client_secret: p.clientSecret,
    code_verifier: codeVerifier,
  })
  const res = await fetchRetrying(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new OAuthError(`Token exchange failed (${provider}): ${res.status}`)
  }
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new OAuthError(`No access_token in token response (${provider})`)
  return json.access_token
}

export async function fetchIdentity(
  provider: ProviderName,
  accessToken: string,
): Promise<OAuthIdentity> {
  const p = oauthProvider(provider)
  // Yandex expects the "OAuth" auth scheme (not "Bearer").
  const res = await fetchRetrying(p.userInfoUrl, {
    headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new OAuthError(`Userinfo failed (${provider}): ${res.status}`)
  const data = (await res.json()) as Record<string, unknown>

  const sub = String(data['id'] ?? '')
  if (!sub) throw new OAuthError('Yandex userinfo missing id')
  return {
    sub,
    email: (data['default_email'] as string) || null,
    displayName: (data['display_name'] as string) || (data['real_name'] as string) || null,
  }
}

export class OAuthError extends Error {}
