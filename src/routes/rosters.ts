import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth, type AuthVars } from '../auth/middleware.js'
import { parseRoster, extractMetadata, RosterPayloadError, rosterIdSchema } from '../domain/roster.js'
import { config } from '../config.js'
import {
  listRosters,
  getRosterBlob,
  upsertRoster,
  tombstoneRoster,
  purgeOldTombstones,
  countRosters,
} from '../db/rosters.repo.js'

// Army-list sync. Same four-route shape as /games, with two deliberate differences:
//
//   - GET / returns METADATA ONLY (no blobs). Entering the roster screen costs exactly one small
//     request, and the client then downloads only the lists whose updatedAt actually moved.
//   - DELETE leaves a TOMBSTONE instead of removing the row, and GET / reports it. Without that,
//     a second device still holding the list would see "the cloud doesn't have this one" and
//     helpfully upload it again.
export const rosterRoutes = new Hono<{ Variables: AuthVars }>()

rosterRoutes.use('*', requireAuth)

const listQuerySchema = z.object({
  // Tombstones share the budget with live lists, hence the roomy default.
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

// The deleting client's own clock, on the same scale as a roster's `updatedAt` so the two can be
// compared. Absent (an older client) → the server's clock, which is close enough for a delete.
const deleteQuerySchema = z.object({
  at: z.coerce.number().int().nonnegative().optional(),
})

// How long a tombstone is kept. Longer than any plausible "phone in a drawer" gap, because the
// device that outlives it re-uploads the list it never learned was deleted.
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000

rosterRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse({ limit: c.req.query('limit') })
  if (!parsed.success) return c.json({ error: 'bad_query' }, 400)
  const rosters = await listRosters(c.var.userId, parsed.data.limit)
  return c.json({ rosters })
})

rosterRoutes.get('/:id', async (c) => {
  const idParsed = rosterIdSchema.safeParse(c.req.param('id'))
  if (!idParsed.success) return c.json({ error: 'bad_id' }, 400)
  const blob = await getRosterBlob(c.var.userId, idParsed.data)
  if (!blob) return c.json({ error: 'not_found' }, 404)
  return c.json(blob)
})

rosterRoutes.put('/:id', async (c) => {
  const idParsed = rosterIdSchema.safeParse(c.req.param('id'))
  if (!idParsed.success) return c.json({ error: 'bad_id' }, 400)
  const id = idParsed.data
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  let roster, json
  try {
    ;({ roster, json } = parseRoster(raw))
  } catch (e) {
    if (e instanceof RosterPayloadError) return c.json({ error: 'payload_too_large' }, 413)
    return c.json({ error: 'invalid_roster' }, 422)
  }
  if (roster.id !== id) return c.json({ error: 'id_mismatch' }, 422)

  // Enforce the per-user cap, but always allow overwriting an existing roster.
  const existing = await getRosterBlob(c.var.userId, id)
  if (!existing) {
    const count = await countRosters(c.var.userId)
    if (count >= config.maxRostersPerUser) return c.json({ error: 'quota_exceeded' }, 409)
  }

  await upsertRoster({
    userId: c.var.userId,
    meta: extractMetadata(roster),
    json,
    nowIso: new Date().toISOString(),
  })
  return c.json({ ok: true, rosterId: id })
})

rosterRoutes.delete('/:id', async (c) => {
  const idParsed = rosterIdSchema.safeParse(c.req.param('id'))
  if (!idParsed.success) return c.json({ error: 'bad_id' }, 400)
  const atParsed = deleteQuerySchema.safeParse({ at: c.req.query('at') })
  if (!atParsed.success) return c.json({ error: 'bad_query' }, 400)
  const now = Date.now()
  await tombstoneRoster({
    userId: c.var.userId,
    rosterId: idParsed.data,
    deletedAtMs: atParsed.data.at ?? now,
    nowIso: new Date(now).toISOString(),
  })
  // Deleting is rare, so it is also where the old tombstones get swept — no scheduled job.
  await purgeOldTombstones(c.var.userId, now - TOMBSTONE_TTL_MS)
  return c.body(null, 204)
})
