import { Hono } from 'hono'
import { getSignedCookie, setSignedCookie, setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { afterLogin, config, isProviderName, returnOrigin, siteForHost, type ProviderName, type Site } from '../config.js'
import {
  buildAuthUrl,
  createPkceState,
  exchangeCode,
  fetchIdentity,
  OAuthError,
} from '../auth/oauth.js'
import { upsertUser } from '../db/users.repo.js'
import { createSession, rotateSession, destroySessionByCookie } from '../auth/sessions.js'
import { issueAccessToken } from '../auth/jwt.js'

const STATE_COOKIE = 'oauth_state'
const REFRESH_COOKIE = 'rt'

// Lazy (don't touch env at module load): cookies are Secure only over HTTPS.
function isSecure(): boolean {
  return config.apiBaseUrl.startsWith('https')
}

export const authRoutes = new Hono()

// Reject state-changing requests whose Origin isn't allow-listed (defence-in-depth for the
// cookie-bearing endpoints).
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true // non-browser / same-origin server calls
  return config.allowedOrigins.includes(origin)
}

// Host-aware site for this request (see config.ts siteForHost): cookies, the post-login
// redirect and the OAuth redirect_uri are all built for the domain the request came in on,
// so login works on both the old and the new domain during the migration.
function siteOf(c: { req: { header(name: string): string | undefined } }): Site {
  return siteForHost(c.req.header('Host'))
}

authRoutes.get('/:provider/login', async (c) => {
  const provider = c.req.param('provider')
  if (!isProviderName(provider)) return c.json({ error: 'unknown_provider' }, 404)

  const pkce = createPkceState()
  const site = siteOf(c)
  // A site other than this API's own may ask to be sent back to (the tracker's beta on its
  // subdomain, 2026-10-08) — only an allow-listed https origin, never an arbitrary URL.
  const back = returnOrigin(c.req.query('return'))
  await setSignedCookie(
    c,
    STATE_COOKIE,
    JSON.stringify({ ...pkce, provider, ...(back ? { back } : {}) }),
    config.jwtSigningKey,
    { httpOnly: true, secure: isSecure(), sameSite: 'Lax', path: '/auth', maxAge: 600 },
  )
  return c.redirect(buildAuthUrl(provider, pkce, site))
})

authRoutes.get('/:provider/callback', async (c) => {
  const provider = c.req.param('provider')
  if (!isProviderName(provider)) return c.json({ error: 'unknown_provider' }, 404)

  const site = siteOf(c)
  const rawCookie = await getSignedCookie(c, config.jwtSigningKey, STATE_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/auth' })
  let saved: { state: string; codeVerifier: string; provider: ProviderName; back?: string } | null = null
  if (rawCookie) {
    try {
      saved = JSON.parse(rawCookie)
    } catch {
      saved = null
    }
  }
  // A login that fails goes back to the site it started from, with its reason (`?error=`), and
  // leaves a line in the log. Until 2026-10-09 our own failures answered with bare JSON — a
  // player whose login came back in another browser (the Yandex app on Android) saw a page of
  // code — and Yandex's refusals (`unauthorized_client` for child and organisation accounts)
  // reached the site but nobody, us included, ever learned of them.
  const fail = (reason: string) => {
    const ua = (c.req.header('user-agent') || '').slice(0, 160)
    console.warn(`[auth] ${provider} login failed: ${reason} | ua: ${ua}`)
    return c.redirect(`${afterLogin(site, saved?.back)}?error=${encodeURIComponent(reason)}`)
  }

  const err = c.req.query('error')
  if (err) return fail(err)

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return fail('missing_code_or_state')
  if (!rawCookie) return fail('missing_state_cookie')
  if (!saved) return fail('bad_state_cookie')
  if (saved.provider !== provider || saved.state !== state) return fail('state_mismatch')

  try {
    const providerToken = await exchangeCode(provider, code, saved.codeVerifier, site)
    const identity = await fetchIdentity(provider, providerToken)
    const userId = `${provider}:${identity.sub}`
    await upsertUser({
      userId,
      email: identity.email,
      displayName: identity.displayName,
      nowIso: new Date().toISOString(),
    })
    const cookieValue = await createSession(userId)
    setCookie(c, REFRESH_COOKIE, cookieValue, {
      httpOnly: true,
      secure: isSecure(),
      // SameSite=None (+Secure) is DELIBERATE and load-bearing: an earlier Strict broke the
      // deployed login/refresh flow, so do NOT change it back. CSRF is still covered by the
      // originAllowed() allow-list and by /games being Bearer-only. Lax in local http dev, where
      // None+insecure would be rejected by the browser.
      sameSite: isSecure() ? 'None' : 'Lax',
      path: '/auth',
      domain: site.cookieDomain || undefined,
      maxAge: config.refreshTokenTtl,
    })
    return c.redirect(afterLogin(site, saved.back))
  } catch (e) {
    if (e instanceof OAuthError) {
      console.warn(`[auth] ${e.message}`)
      return fail('oauth_failed')
    }
    throw e
  }
})

authRoutes.post('/refresh', async (c) => {
  if (!originAllowed(c.req.header('Origin'))) return c.json({ error: 'forbidden_origin' }, 403)
  const cookieValue = getCookie(c, REFRESH_COOKIE)
  if (!cookieValue) return c.json({ error: 'no_session' }, 401)

  const site = siteOf(c)
  const rotated = await rotateSession(cookieValue)
  if (!rotated) {
    deleteCookie(c, REFRESH_COOKIE, { path: '/auth', domain: site.cookieDomain || undefined })
    return c.json({ error: 'invalid_session' }, 401)
  }
  setCookie(c, REFRESH_COOKIE, rotated.newCookie, {
    httpOnly: true,
    secure: isSecure(),
    // NB: the login callback issues this cookie SameSite=None (see there); this re-set uses
    // Strict. The asymmetry is harmless because the SPA and API are the same site, and login
    // works as deployed — don't "normalize" the two without re-testing the real refresh flow.
    sameSite: 'Strict',
    path: '/auth',
    domain: site.cookieDomain || undefined,
    maxAge: config.refreshTokenTtl,
  })
  const { token, expiresIn } = await issueAccessToken(rotated.userId)
  return c.json({ accessToken: token, expiresIn })
})

authRoutes.post('/logout', async (c) => {
  if (!originAllowed(c.req.header('Origin'))) return c.json({ error: 'forbidden_origin' }, 403)
  const cookieValue = getCookie(c, REFRESH_COOKIE)
  if (cookieValue) await destroySessionByCookie(cookieValue)
  deleteCookie(c, REFRESH_COOKIE, { path: '/auth', domain: siteOf(c).cookieDomain || undefined })
  return c.body(null, 204)
})
