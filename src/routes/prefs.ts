import { Hono } from 'hono'
import { requireAuth, type AuthVars } from '../auth/middleware.js'
import { config } from '../config.js'
import {
  prefsScopeSchema,
  prefsPutSchema,
  parsePrefsData,
  prefsEtag,
  PrefsPayloadError,
} from '../domain/prefs.js'
import { listPrefs, writePrefsScope } from '../db/prefs.repo.js'

// A player's own marks — pinned factions, favourite datasheets, the model collection. Two routes,
// and the shape of both follows from one product fact: these are tiny things touched one tap at a
// time, on several devices, and the player was promised that nothing they mark is ever lost.
//
//   GET /            everything, in one request. The scarce resource is REQUESTS (the gateway's
//                    per-minute budget), not bytes: a whole shelf is a few kilobytes, while
//                    fetching it faction by faction would turn one visit into six. An ETag over
//                    the (scope, version) pairs makes a visit that changed nothing free.
//   PUT /:scope      one faction (or the pinned list), carrying the version it merged from. A
//                    stale write is refused with the row that beat it, not silently applied —
//                    merging happens on the client, and a blind overwrite is exactly how another
//                    device's marks would disappear.
//
// The server never looks inside a scope's data. Which mark belongs to which datasheet, what to do
// when an id is renamed or a unit leaves the game — all of that needs the rules data, which only
// the client has.
export const prefsRoutes = new Hono<{ Variables: AuthVars }>()

prefsRoutes.use('*', requireAuth)

prefsRoutes.get('/', async (c) => {
  const scopes = await listPrefs(c.var.userId)
  const etag = prefsEtag(scopes)
  c.header('ETag', etag)
  // Private: this is one account's data behind a Bearer, and no shared cache may keep it.
  c.header('Cache-Control', 'private, no-cache')
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
  return c.json({ scopes })
})

prefsRoutes.put('/:scope', async (c) => {
  const scopeParsed = prefsScopeSchema.safeParse(c.req.param('scope'))
  if (!scopeParsed.success) return c.json({ error: 'bad_scope' }, 400)

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const bodyParsed = prefsPutSchema.safeParse(raw)
  if (!bodyParsed.success) return c.json({ error: 'invalid_prefs' }, 422)

  let json: string
  try {
    ;({ json } = parsePrefsData(bodyParsed.data.data))
  } catch (e) {
    if (e instanceof PrefsPayloadError) return c.json({ error: 'payload_too_large' }, 413)
    return c.json({ error: 'invalid_prefs' }, 422)
  }

  const now = Date.now()
  const result = await writePrefsScope({
    userId: c.var.userId,
    scope: scopeParsed.data,
    expectedVersion: bodyParsed.data.version,
    json,
    updatedAtMs: now,
    nowIso: new Date(now).toISOString(),
    maxScopes: config.maxPrefsScopesPerUser,
  })

  if (result.ok) return c.json({ ok: true, scope: scopeParsed.data, version: result.version })
  if (result.reason === 'quota') return c.json({ error: 'quota_exceeded' }, 409)
  // 409 with the winner attached: the client re-merges against `current` and PUTs again.
  return c.json({ error: 'version_conflict', current: result.current }, 409)
})
