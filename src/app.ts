import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { corsOrigin } from './config.js'
import { authRoutes } from './routes/auth.js'
import { broadcastRoutes } from './routes/broadcast.js'
import { gameRoutes } from './routes/games.js'
import { meRoutes } from './routes/me.js'
import { rosterRoutes } from './routes/rosters.js'

// Runtime-agnostic Hono app. Exposed via app.fetch(Request) — the YC adapter and the local
// Node server both drive it the same way.
export const app = new Hono()

app.use(
  '*',
  cors({
    origin: corsOrigin,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
    maxAge: 600,
  }),
)

app.get('/health', (c) => c.json({ status: 'ok' }))

app.route('/auth', authRoutes)
// NOT Bearer-gated as a module: /broadcast/:token is the public read the OBS overlay polls
// (the unguessable token is the credential); the live push inside carries its own requireAuth.
app.route('/broadcast', broadcastRoutes)
app.route('/games', gameRoutes)
app.route('/rosters', rosterRoutes)
app.route('/me', meRoutes)

app.notFound((c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  // Never leak internals to the client; log server-side for diagnostics.
  console.error('[wh11ed-api] unhandled error:', err)
  return c.json({ error: 'internal_error' }, 500)
})
