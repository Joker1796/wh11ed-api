import { before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { prefsEtag, parsePrefsData, prefsScopeSchema, PrefsPayloadError, GLOBAL_SCOPE } from '../src/domain/prefs.js'
import type { PrefsScopeRow } from '../src/domain/prefs.js'

// The prefs routes against an IN-MEMORY repo: what a player's marks do when two devices save at
// the same moment, which is the whole reason this endpoint is not a last-write-wins blob. The
// repo's YQL is the one thing this cannot cover; its contract (one row per scope, a version that
// every write bumps, a read-and-write in one transaction) is re-stated here in a few lines.

process.env.JWT_SIGNING_KEY ||= 'test-signing-key-test-signing-key'
process.env.API_BASE_URL ||= 'http://localhost:8787'
process.env.APP_AFTER_LOGIN_URL ||= 'http://localhost:5173/tracker/auth-callback'

interface Row { version: number; updatedAt: number; json: string }
const store = new Map<string, Map<string, Row>>()

const rowsOf = (userId: string) => store.get(userId) ?? new Map<string, Row>()

const fakeRepo = {
  async listPrefs(userId: string): Promise<PrefsScopeRow[]> {
    return [...rowsOf(userId)].map(([scope, r]) => ({
      scope,
      version: r.version,
      updatedAt: r.updatedAt,
      data: JSON.parse(r.json) as Record<string, unknown>,
    }))
  },
  async writePrefsScope(input: {
    userId: string
    scope: string
    expectedVersion: number
    json: string
    updatedAtMs: number
    maxScopes: number
  }) {
    const rows = store.get(input.userId) ?? new Map<string, Row>()
    store.set(input.userId, rows)
    const row = rows.get(input.scope)
    const version = row?.version ?? 0
    if (version !== input.expectedVersion) {
      return {
        ok: false as const,
        reason: 'stale' as const,
        current: {
          scope: input.scope,
          version,
          updatedAt: row?.updatedAt ?? 0,
          data: row ? (JSON.parse(row.json) as Record<string, unknown>) : {},
        },
      }
    }
    if (!row && rows.size >= input.maxScopes) return { ok: false as const, reason: 'quota' as const }
    rows.set(input.scope, { version: version + 1, updatedAt: input.updatedAtMs, json: input.json })
    return { ok: true as const, version: version + 1 }
  },
}

mock.module(new URL('../src/db/prefs.repo.ts', import.meta.url).href, { namedExports: fakeRepo })

let app: Hono
let jwt: string
before(async () => {
  const { prefsRoutes } = await import('../src/routes/prefs.js')
  const { issueAccessToken } = await import('../src/auth/jwt.js')
  app = new Hono().route('/prefs', prefsRoutes)
  jwt = (await issueAccessToken('user-1')).token
})

const put = (scope: string, body: unknown) =>
  app.request(`/prefs/${scope}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  })

const get = (headers: Record<string, string> = {}) =>
  app.request('/prefs', { headers: { Authorization: `Bearer ${jwt}`, ...headers } })

describe('prefs domain', () => {
  it('accepts a faction slug and the pinned-faction scope, and nothing else', () => {
    assert.equal(prefsScopeSchema.safeParse('grey-knights').success, true)
    assert.equal(prefsScopeSchema.safeParse(GLOBAL_SCOPE).success, true)
    assert.equal(prefsScopeSchema.safeParse('Grey Knights').success, false)
    assert.equal(prefsScopeSchema.safeParse('../rosters').success, false)
    assert.equal(prefsScopeSchema.safeParse('@anything-else').success, false)
  })

  it('caps a scope by bytes', () => {
    const fat = { marks: 'x'.repeat(70 * 1024) }
    assert.throws(() => parsePrefsData(fat), PrefsPayloadError)
  })

  it('identifies the whole collection by its (scope, version) pairs, order-independently', () => {
    const a = prefsEtag([{ scope: 'orks', version: 2 }, { scope: GLOBAL_SCOPE, version: 9 }])
    const b = prefsEtag([{ scope: GLOBAL_SCOPE, version: 9 }, { scope: 'orks', version: 2 }])
    assert.equal(a, b)
    assert.notEqual(a, prefsEtag([{ scope: 'orks', version: 3 }, { scope: GLOBAL_SCOPE, version: 9 }]))
    assert.equal(prefsEtag([]), '"empty"')
  })
})

describe('prefs routes', () => {
  it('needs a token', async () => {
    const res = await app.request('/prefs')
    assert.equal(res.status, 401)
  })

  it('starts empty, then hands back what was written', async () => {
    const empty = await get()
    assert.equal(empty.status, 200)
    assert.deepEqual((await empty.json()) as unknown, { scopes: [] })

    const wrote = await put('grey-knights', { version: 0, data: { 'strike-squad': { own: 1, at: 100 } } })
    assert.equal(wrote.status, 200)
    assert.deepEqual((await wrote.json()) as unknown, { ok: true, scope: 'grey-knights', version: 1 })

    const res = await get()
    const body = (await res.json()) as { scopes: PrefsScopeRow[] }
    assert.equal(body.scopes.length, 1)
    assert.equal(body.scopes[0]!.scope, 'grey-knights')
    assert.equal(body.scopes[0]!.version, 1)
    assert.deepEqual(body.scopes[0]!.data, { 'strike-squad': { own: 1, at: 100 } })
  })

  it('costs nothing when nothing moved', async () => {
    const first = await get()
    const etag = first.headers.get('ETag')!
    assert.ok(etag)
    const again = await get({ 'If-None-Match': etag })
    assert.equal(again.status, 304)
    assert.equal(await again.text(), '')

    await put('grey-knights', { version: 1, data: { 'strike-squad': { own: 1, at: 100 }, purgation: { own: 1, at: 200 } } })
    const moved = await get({ 'If-None-Match': etag })
    assert.equal(moved.status, 200)
  })

  it('refuses a write merged from a version that has been overtaken, and hands back the winner', async () => {
    // Two phones read version 2. The first saves; the second must not be allowed to write over it.
    const slow = await put('grey-knights', { version: 2, data: { purgation: { own: 1, at: 200 } } })
    assert.equal(slow.status, 200)

    const stale = await put('grey-knights', { version: 2, data: { paladins: { own: 1, at: 300 } } })
    assert.equal(stale.status, 409)
    const body = (await stale.json()) as { error: string; current: PrefsScopeRow }
    assert.equal(body.error, 'version_conflict')
    assert.equal(body.current.version, 3)
    // The loser is handed what beat it, so its retry merges rather than guesses.
    assert.deepEqual(body.current.data, { purgation: { own: 1, at: 200 } })

    const retry = await put('grey-knights', { version: 3, data: { purgation: { own: 1, at: 200 }, paladins: { own: 1, at: 300 } } })
    assert.equal(retry.status, 200)
  })

  it('keeps one faction out of another, and the pinned list out of both', async () => {
    await put('orks', { version: 0, data: { boyz: { own: 1, at: 400 } } })
    await put(GLOBAL_SCOPE, { version: 0, data: { pinned: ['orks', 'grey-knights'], at: 500 } })
    const body = (await (await get()).json()) as { scopes: PrefsScopeRow[] }
    const bySlug = Object.fromEntries(body.scopes.map((s) => [s.scope, s.data]))
    assert.deepEqual(bySlug['orks'], { boyz: { own: 1, at: 400 } })
    assert.deepEqual(bySlug['@factions'], { pinned: ['orks', 'grey-knights'], at: 500 })
    assert.ok('grey-knights' in bySlug)
  })

  it('rejects a scope that is not a faction, a body that is not a document, and an oversized one', async () => {
    assert.equal((await put('..%2Frosters', { version: 0, data: {} })).status, 400)
    assert.equal((await put('orks', { data: {} })).status, 422)
    assert.equal((await put('orks', { version: 1, data: [1, 2, 3] })).status, 422)
    assert.equal((await put('orks', { version: 1, data: { x: 'y'.repeat(70 * 1024) } })).status, 413)
  })
})
