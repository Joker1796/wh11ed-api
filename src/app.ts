import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { corsOrigin } from './config.js'
import { authRoutes } from './routes/auth.js'
import { broadcastRoutes } from './routes/broadcast.js'
import { feedbackRoutes } from './routes/feedback.js'
import { gameRoutes } from './routes/games.js'
import { meRoutes } from './routes/me.js'
import { partyRoutes } from './routes/party.js'
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

app.route('/auth', authRoutes)
// NOT Bearer-gated as a module: /broadcast/:token is the public read the OBS overlay polls
// (the unguessable token is the credential); the live push inside carries its own requireAuth.
app.route('/broadcast', broadcastRoutes)
// Public bug reports (anonymous unless a Bearer rides along) — see routes/feedback.ts.
app.route('/feedback', feedbackRoutes)
app.route('/games', gameRoutes)
// A live game shared by several phones. NOT Bearer-gated as a module: POST /party creates one
// with an account JWT, POST /party/join is public (the invite is the credential), and the rest
// speaks with per-party member tokens — see routes/party.ts.
app.route('/party', partyRoutes)
app.route('/rosters', rosterRoutes)
app.route('/me', meRoutes)

app.notFound((c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  // Never leak internals to the client; log server-side for diagnostics.
  console.error('[wh11ed-api] unhandled error:', err)
  return c.json({ error: 'internal_error' }, 500)
})
