import { Hono } from 'hono'
import { getSignedCookie, setSignedCookie, setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { config, isProviderName, type ProviderName } from '../config.js'
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

authRoutes.get('/:provider/login', async (c) => {
  const provider = c.req.param('provider')
  if (!isProviderName(provider)) return c.json({ error: 'unknown_provider' }, 404)

  const pkce = createPkceState()
  await setSignedCookie(
    c,
    STATE_COOKIE,
    JSON.stringify({ ...pkce, provider }),
    config.jwtSigningKey,
    { httpOnly: true, secure: isSecure(), sameSite: 'Lax', path: '/auth', maxAge: 600 },
  )
  return c.redirect(buildAuthUrl(provider, pkce))
})

authRoutes.get('/:provider/callback', async (c) => {
  const provider = c.req.param('provider')
  if (!isProviderName(provider)) return c.json({ error: 'unknown_provider' }, 404)

  const err = c.req.query('error')
  if (err) return c.redirect(`${config.appAfterLoginUrl}?error=${encodeURIComponent(err)}`)

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.json({ error: 'missing_code_or_state' }, 400)

  const rawCookie = await getSignedCookie(c, config.jwtSigningKey, STATE_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/auth' })
  if (!rawCookie) return c.json({ error: 'missing_state_cookie' }, 400)

  let saved: { state: string; codeVerifier: string; provider: ProviderName }
  try {
    saved = JSON.parse(rawCookie)
  } catch {
    return c.json({ error: 'bad_state_cookie' }, 400)
  }
  if (saved.provider !== provider || saved.state !== state) {
    return c.json({ error: 'state_mismatch' }, 400)
  }

  try {
    const providerToken = await exchangeCode(provider, code, saved.codeVerifier)
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
      // The SPA (wh11ed.ru) and API (api.wh11ed.ru) are different origins, so the refresh fetch is
      // cross-origin — the cookie must be SameSite=None (+Secure) to be sent. CSRF is still covered
      // by the originAllowed() allow-list and by /games being Bearer-only. Lax in local http dev,
      // where None+insecure would be rejected by the browser.
      sameSite: isSecure() ? 'None' : 'Lax',
      path: '/auth',
      domain: config.cookieDomain || undefined,
      maxAge: config.refreshTokenTtl,
    })
    return c.redirect(config.appAfterLoginUrl)
  } catch (e) {
    if (e instanceof OAuthError) return c.json({ error: 'oauth_failed' }, 502)
    throw e
  }
})

authRoutes.post('/refresh', async (c) => {
  if (!originAllowed(c.req.header('Origin'))) return c.json({ error: 'forbidden_origin' }, 403)
  const cookieValue = getCookie(c, REFRESH_COOKIE)
  if (!cookieValue) return c.json({ error: 'no_session' }, 401)

  const rotated = await rotateSession(cookieValue)
  if (!rotated) {
    deleteCookie(c, REFRESH_COOKIE, { path: '/auth', domain: config.cookieDomain || undefined })
    return c.json({ error: 'invalid_session' }, 401)
  }
  setCookie(c, REFRESH_COOKIE, rotated.newCookie, {
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'Strict',
    path: '/auth',
    domain: config.cookieDomain || undefined,
    maxAge: config.refreshTokenTtl,
  })
  const { token, expiresIn } = await issueAccessToken(rotated.userId)
  return c.json({ accessToken: token, expiresIn })
})

authRoutes.post('/logout', async (c) => {
  if (!originAllowed(c.req.header('Origin'))) return c.json({ error: 'forbidden_origin' }, 403)
  const cookieValue = getCookie(c, REFRESH_COOKIE)
  if (cookieValue) await destroySessionByCookie(cookieValue)
  deleteCookie(c, REFRESH_COOKIE, { path: '/auth', domain: config.cookieDomain || undefined })
  return c.body(null, 204)
})
