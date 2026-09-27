import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { corsOrigin } from './config.js'
import { authRoutes } from './routes/auth.js'
import { broadcastRoutes } from './routes/broadcast.js'
import { changelogRoutes } from './routes/changelog.js'
import { feedbackRoutes } from './routes/feedback.js'
import { gameRoutes } from './routes/games.js'
import { meRoutes } from './routes/me.js'
import { partyRoutes } from './routes/party.js'
import { prefsRoutes } from './routes/prefs.js'
import { rosterRoutes } from './routes/rosters.js'

// Runtime-agnostic Hono app. Exposed via app.fetch(Request) — the YC adapter and the local
// Node server both drive it the same way.
export const app = new Hono()

const appCors = cors({
  origin: corsOrigin,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  credentials: true,
  maxAge: 600,
})
// The public broadcast read is third-party-embeddable BY DESIGN: custom HTML/CSS overlays
// live on other origins (or OBS-local files) and fetch it directly. Open CORS, no
// credentials, ETag exposed so a polling client can send If-None-Match. Everything else —
// including /broadcast/live — keeps the allowlist+credentials policy above.
const openCors = cors({
  origin: '*',
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['If-None-Match'],
  exposeHeaders: ['ETag'],
  maxAge: 86400,
})
app.use('*', (c, next) => {
  const p = c.req.path
  const isPublicBroadcast = p.startsWith('/broadcast/') && !p.startsWith('/broadcast/live/')
  return isPublicBroadcast ? openCors(c, next) : appCors(c, next)
})

app.get('/health', (c) => c.json({ status: 'ok' }))

// THE STAND'S ONE CONVENIENCE, and it exists only when asked for: with DEV_JWT=1 in the
// environment (docker-compose.yml sets it; nothing in production does) this hands out the same
// week-long token `npm run dev:jwt` prints, so the frontend's test sign-in can fetch it instead
// of a human pasting it into localStorage. The route is not REGISTERED without the flag — not
// guarded inside, not 403'd: it is simply not there, so a misconfiguration cannot expose it.
// The token is meaningless against production anyway (a different signing key), but a route
// that mints tokens has no business existing there at all.
if (process.env.DEV_JWT === '1') {
  app.get('/dev/jwt', async (c) => {
    const { sign } = await import('hono/jwt')
    const { config } = await import('./config.js')
    const now = Math.floor(Date.now() / 1000)
    const token = await sign({ sub: 'dev-host', iat: now, exp: now + 7 * 86_400 }, config.jwtSigningKey, 'HS256')
    return c.json({ token })
  })
}

app.route('/auth', authRoutes)
// NOT Bearer-gated as a module: /broadcast/:token is the public read the OBS overlay polls
// (the unguessable token is the credential); the live push inside carries its own requireAuth.
app.route('/broadcast', broadcastRoutes)
// The release-notes archive: public, read-only — see routes/changelog.ts.
app.route('/changelog', changelogRoutes)
// Public bug reports (anonymous unless a Bearer rides along) — see routes/feedback.ts.
app.route('/feedback', feedbackRoutes)
app.route('/games', gameRoutes)
// A live game shared by several phones. NOT Bearer-gated as a module: POST /party creates one
// with an account JWT, POST /party/join is public (the invite is the credential), and the rest
// speaks with per-party member tokens — see routes/party.ts.
app.route('/party', partyRoutes)
app.route('/prefs', prefsRoutes)
app.route('/rosters', rosterRoutes)
app.route('/me', meRoutes)

app.notFound((c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  // Never leak internals to the client; log server-side for diagnostics.
  console.error('[wh11ed-api] unhandled error:', err)
  return c.json({ error: 'internal_error' }, 500)
})
