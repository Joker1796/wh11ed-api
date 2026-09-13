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

// ── Protecting the read ───────────────────────────────────────────────────────────────────
// The gateway's budget is 600 requests a MINUTE for the whole API — logins and sync included —
// and one overlay at our own 2-second cadence spends 30 of them. So the public read carries
// two brakes of its own.
//
// 1. A warm-instance micro-cache: every viewer of one game shares a single YDB read per
//    second, instead of one each. It is deliberately shorter than the poll interval, so
//    nobody ever sees state older than the tick they asked on.
const READ_TTL_MS = 1000
type CachedRead = { at: number; row: { payload: unknown | null; updatedAt: string | null } | null }
const readCache = new Map<string, CachedRead>()

async function readBroadcast(token: string, now: number) {
  const hit = readCache.get(token)
  if (hit && now - hit.at < READ_TTL_MS) return hit.row
  const row = await getBroadcastByToken(token)
  readCache.set(token, { at: now, row })
  if (readCache.size > 5000) readCache.clear() // an unbounded map is the only way this bites
  return row
}

// 2. A per-IP ceiling, generous enough for a hand-built overlay polling twice a second and
//    tight enough that a runaway one cannot spend the whole gateway budget. Warm-instance
//    memory, like the feedback route's: an abuse fence, not an accounting system.
const RATE_WINDOW_MS = 60 * 1000
const MAX_READS_PER_MIN = 120
const readHits = new Map<string, number[]>()
function readThrottled(ip: string, now: number): boolean {
  const hits = (readHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS)
  if (hits.length >= MAX_READS_PER_MIN) {
    readHits.set(ip, hits)
    return true
  }
  hits.push(now)
  readHits.set(ip, hits)
  if (readHits.size > 10000) readHits.clear()
  return false
}

// The public read-only state — what OBS polls every couple of seconds. ETag/304 keep the idle
// polls nearly free: the ETag is the row's updated_at, so an unchanged game costs no body.
broadcastRoutes.get('/:token', async (c) => {
  const parsed = broadcastTokenSchema.safeParse(c.req.param('token'))
  if (!parsed.success) return c.json({ error: 'bad_token' }, 400)

  const now = Date.now()
  const ip = (c.req.header('X-Forwarded-For') || '').split(',')[0]?.trim() || 'unknown'
  if (readThrottled(ip, now)) {
    c.header('Retry-After', '1')
    return c.json({ error: 'too_many' }, 429)
  }

  const row = await readBroadcast(parsed.data, now)
  if (!row) return c.json({ error: 'not_found' }, 404)

  const etag = `"${row.updatedAt || 'empty'}"`
  // A second of freshness, not none: a browser coalesces a burst on its own, and the data is
  // at most that stale anyway. An overlay that insists on bypassing it still gets its 304.
  c.header('Cache-Control', 'public, max-age=1')
  c.header('ETag', etag)
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
  return c.json({ payload: row.payload, updatedAt: row.updatedAt })
})
