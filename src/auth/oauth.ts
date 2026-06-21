import { randomBytes, createHash } from 'node:crypto'
import { oauthProvider, redirectUri, type ProviderName } from '../config.js'

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

export function createPkceState(): PkceState {
  return {
    state: b64url(randomBytes(24)),
    codeVerifier: b64url(randomBytes(48)),
  }
}

export function buildAuthUrl(provider: ProviderName, pkce: PkceState): string {
  const p = oauthProvider(provider)
  const challenge = b64url(createHash('sha256').update(pkce.codeVerifier).digest())
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: redirectUri(provider),
    scope: p.scope,
    state: pkce.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (provider === 'google') {
    // Request a refresh-less, consent-light login; we only need identity.
    params.set('access_type', 'online')
    params.set('prompt', 'select_account')
  }
  return `${p.authUrl}?${params.toString()}`
}

export async function exchangeCode(
  provider: ProviderName,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const p = oauthProvider(provider)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(provider),
    client_id: p.clientId,
    client_secret: p.clientSecret,
    code_verifier: codeVerifier,
  })
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
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
  // Yandex expects the "OAuth" auth scheme; Google (OIDC) expects "Bearer".
  const scheme = provider === 'yandex' ? 'OAuth' : 'Bearer'
  const res = await fetch(p.userInfoUrl, {
    headers: { Authorization: `${scheme} ${accessToken}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new OAuthError(`Userinfo failed (${provider}): ${res.status}`)
  const data = (await res.json()) as Record<string, unknown>

  if (provider === 'yandex') {
    const sub = String(data['id'] ?? '')
    if (!sub) throw new OAuthError('Yandex userinfo missing id')
    return {
      sub,
      email: (data['default_email'] as string) || null,
      displayName: (data['display_name'] as string) || (data['real_name'] as string) || null,
    }
  }
  // Google / OIDC
  const sub = String(data['sub'] ?? '')
  if (!sub) throw new OAuthError('Google userinfo missing sub')
  return {
    sub,
    email: (data['email'] as string) || null,
    displayName: (data['name'] as string) || null,
  }
}

export class OAuthError extends Error {}
