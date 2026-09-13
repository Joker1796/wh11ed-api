import { Hono } from 'hono'
import { requireAuth, type AuthVars } from '../auth/middleware.js'
import { gameIdSchema } from '../domain/game.js'
import {
  broadcastTokenSchema,
  parseBroadcastPayload,
  broadcastExpiry,
  BroadcastPayloadError,
} from '../domain/broadcast.js'
import { getBroadcast, getBroadcastByToken, updateBroadcastPayload } from '../db/broadcasts.repo.js'

// Live-game broadcast. Deliberately mounted WITHOUT a module-wide requireAuth: GET /:token is
// the public read the OBS overlay polls — the unguessable token is the whole credential (an
// unlisted-link model; enable/disable/regenerate live under /games/:id/broadcast). The one
// write here carries its own requireAuth.
export const broadcastRoutes = new Hono<{ Variables: AuthVars }>()

// The phone pushing the live state. 404 (not 201) when the broadcast isn't enabled: pushing is
// meaningless without a token to watch it through, and creating a row here would resurrect a
// link the user explicitly revoked.
broadcastRoutes.put('/live/:gameId', requireAuth, async (c) => {
  const idParsed = gameIdSchema.safeParse(c.req.param('gameId'))
  if (!idParsed.success) return c.json({ error: 'bad_id' }, 400)
  const gameId = idParsed.data

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  let json: string
  try {
    ;({ json } = parseBroadcastPayload(raw))
  } catch (e) {
    if (e instanceof BroadcastPayloadError) return c.json({ error: 'payload_too_large' }, 413)
    return c.json({ error: 'invalid_payload' }, 422)
  }

  const existing = await getBroadcast(c.var.userId, gameId)
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const now = new Date()
  await updateBroadcastPayload({
    userId: c.var.userId,
    gameId,
    json,
    nowIso: now.toISOString(),
    expiresAt: broadcastExpiry(now.getTime()),
  })
  return c.json({ ok: true })
})

// The public read-only state — what OBS polls every couple of seconds. ETag/304 keep the idle
// polls nearly free: the ETag is the row's updated_at, so an unchanged game costs no body.
broadcastRoutes.get('/:token', async (c) => {
  const parsed = broadcastTokenSchema.safeParse(c.req.param('token'))
  if (!parsed.success) return c.json({ error: 'bad_token' }, 400)
  const row = await getBroadcastByToken(parsed.data)
  if (!row) return c.json({ error: 'not_found' }, 404)

  const etag = `"${row.updatedAt || 'empty'}"`
  c.header('Cache-Control', 'no-store')
  c.header('ETag', etag)
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
  return c.json({ payload: row.payload, updatedAt: row.updatedAt })
})
