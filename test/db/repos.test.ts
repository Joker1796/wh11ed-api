import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { freshSchema, db, closeDb } from './setup.js'
import { getUser, upsertUser } from '../../src/db/users.repo.js'
import { countRosters, listRosters, upsertRoster, tombstoneRoster, purgeOldTombstones, getRosterBlob } from '../../src/db/rosters.repo.js'
import { countGames, listGames, upsertGame, getGameBlob, deleteGame } from '../../src/db/games.repo.js'
import { listPrefs, writePrefsScope } from '../../src/db/prefs.repo.js'
import { createSession, rotateSession } from '../../src/auth/sessions.js'
import { upsertBroadcast, updateBroadcastPayload, getBroadcastByToken } from '../../src/db/broadcasts.repo.js'
import { insertFeedback, listFeedback, deleteFeedback } from '../../src/db/feedback.repo.js'
import { listChangelog, upsertChangelog, getChangelogByRanks } from '../../src/db/changelog.repo.js'
import { sweepExpired } from '../../src/db/sweep.js'
import { versionRank } from '../../src/domain/changelog.js'

// The SQL itself — the one layer the unit tests (in-memory repos, mocked modules) never reach.
// Each case pins a behaviour the YDB code had and the frontend relies on, so the port is checked
// against the contract, not against itself.

beforeEach(freshSchema)
after(closeDb)

const NOW = '2026-10-11T12:00:00.000Z'
const roster = (id: string, updatedAt: number) => ({
  rosterId: id, name: id, faction: 'space-marines', updatedAt, points: 500, unitCount: 3,
})

describe('users', () => {
  it('keeps the first sign-in date and refreshes the names', async () => {
    await upsertUser({ userId: 'yandex:1', email: 'a@x', displayName: 'A', nowIso: '2026-01-01T00:00:00Z' })
    await upsertUser({ userId: 'yandex:1', email: 'b@x', displayName: null, nowIso: NOW })
    assert.deepEqual(await getUser('yandex:1'), {
      user_id: 'yandex:1', email: 'b@x', display_name: null, created_at: '2026-01-01T00:00:00Z',
    })
  })
})

describe('rosters', () => {
  it('lists newest first with tombstones, and the quota counts only live lists', async () => {
    await upsertRoster({ userId: 'u', meta: roster('a', 1_000), json: '{"id":"a"}', nowIso: NOW })
    await upsertRoster({ userId: 'u', meta: roster('b', 3_000), json: '{"id":"b"}', nowIso: NOW })
    await upsertRoster({ userId: 'u', meta: roster('c', 2_000), json: '{"id":"c"}', nowIso: NOW })
    await tombstoneRoster({ userId: 'u', rosterId: 'c', deletedAtMs: 4_000, nowIso: NOW })
    const list = await listRosters('u', 10)
    assert.deepEqual(list.map((r) => r.rosterId), ['c', 'b', 'a'])
    assert.deepEqual(list[0], { rosterId: 'c', deleted: true, deletedAt: 4_000 })
    assert.equal(await countRosters('u'), 2)
    assert.equal(await getRosterBlob('u', 'c'), null, 'a tombstone carries no list')
  })

  it('a delete of an id the cloud never held conjures nothing', async () => {
    await tombstoneRoster({ userId: 'u', rosterId: 'ghost', deletedAtMs: 5, nowIso: NOW })
    assert.deepEqual(await listRosters('u', 10), [])
  })

  it('a save after the delete brings the list back to life', async () => {
    await upsertRoster({ userId: 'u', meta: roster('a', 1_000), json: '{"id":"a"}', nowIso: NOW })
    await tombstoneRoster({ userId: 'u', rosterId: 'a', deletedAtMs: 2_000, nowIso: NOW })
    await upsertRoster({ userId: 'u', meta: roster('a', 3_000), json: '{"id":"a","v":2}', nowIso: NOW })
    const [a] = await listRosters('u', 10)
    assert.equal('deleted' in a!, false)
    assert.deepEqual(await getRosterBlob('u', 'a'), { id: 'a', v: 2 })
  })

  it('sweeps only tombstones older than the cutoff', async () => {
    for (const [id, at] of [['old', 1_000], ['new', 9_000]] as const) {
      await upsertRoster({ userId: 'u', meta: roster(id, 500), json: '{}', nowIso: NOW })
      await tombstoneRoster({ userId: 'u', rosterId: id, deletedAtMs: at, nowIso: NOW })
    }
    await upsertRoster({ userId: 'u', meta: roster('live', 500), json: '{}', nowIso: NOW })
    await purgeOldTombstones('u', 5_000)
    assert.deepEqual((await listRosters('u', 10)).map((r) => r.rosterId).sort(), ['live', 'new'])
  })
})

describe('games', () => {
  it('upserts in place, lists by finish time, deletes', async () => {
    const meta = (id: string, finishedAt: string) => ({ gameId: id, createdAt: NOW, finishedAt, resultSummary: '40–35', players: [] })
    await upsertGame({ userId: 'u', meta: meta('g1', '2026-10-01T00:00:00Z'), json: '{"v":1}', nowIso: NOW })
    await upsertGame({ userId: 'u', meta: meta('g2', '2026-10-05T00:00:00Z'), json: '{}', nowIso: NOW })
    await upsertGame({ userId: 'u', meta: meta('g1', '2026-10-01T00:00:00Z'), json: '{"v":2}', nowIso: NOW })
    assert.equal(await countGames('u'), 2)
    assert.deepEqual((await listGames('u', 10)).map((g) => g.gameId), ['g2', 'g1'])
    assert.deepEqual(await getGameBlob('u', 'g1'), { v: 2 })
    await deleteGame('u', 'g1')
    assert.equal(await countGames('u'), 1)
  })
})

describe('prefs', () => {
  const write = (expectedVersion: number, json: string) =>
    writePrefsScope({ userId: 'u', scope: '@factions', expectedVersion, json, updatedAtMs: 1, nowIso: NOW, maxScopes: 2 })

  it('refuses a write based on an old version and hands back the row that beat it', async () => {
    assert.deepEqual(await write(0, '{"a":1}'), { ok: true, version: 1 })
    const stale = await write(0, '{"b":1}')
    assert.equal(stale.ok, false)
    assert.deepEqual(stale.ok === false && stale.reason === 'stale' && stale.current.data, { a: 1 })
  })

  it('two devices writing the same version at once: exactly one wins', async () => {
    const results = await Promise.all([write(0, '{"from":"phone"}'), write(0, '{"from":"tablet"}')])
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal((await listPrefs('u'))[0]!.version, 1)
  })

  it('a new scope past the quota is refused', async () => {
    for (const scope of ['s1', 's2']) {
      await writePrefsScope({ userId: 'u', scope, expectedVersion: 0, json: '{}', updatedAtMs: 1, nowIso: NOW, maxScopes: 2 })
    }
    const third = await writePrefsScope({ userId: 'u', scope: 's3', expectedVersion: 0, json: '{}', updatedAtMs: 1, nowIso: NOW, maxScopes: 2 })
    assert.deepEqual(third, { ok: false, reason: 'quota' })
  })
})

describe('sessions', () => {
  it('rotates on refresh, and a replayed old token burns the session', async () => {
    const first = await createSession('yandex:1')
    const rotated = await rotateSession(first)
    assert.equal(rotated?.userId, 'yandex:1')
    assert.notEqual(rotated?.newCookie, first)
    assert.equal(await rotateSession(first), null, 'the old secret is refused')
    assert.equal(await rotateSession(rotated!.newCookie), null, 'and the session is gone with it')
  })
})

describe('broadcasts and the sweep', () => {
  it('serves a live token, never an expired one, and the sweep removes what expired', async () => {
    const future = new Date(Date.now() + 60_000)
    const past = new Date(Date.now() - 60_000)
    await upsertBroadcast({ userId: 'u', gameId: 'g', token: 'live', nowIso: NOW, expiresAt: future })
    await updateBroadcastPayload({ userId: 'u', gameId: 'g', json: '{"r":1}', nowIso: NOW, expiresAt: future })
    await upsertBroadcast({ userId: 'u', gameId: 'old', token: 'dead', nowIso: NOW, expiresAt: past })
    assert.deepEqual((await getBroadcastByToken('live'))?.payload, { r: 1 })
    assert.equal(await getBroadcastByToken('dead'), null)
    const swept = await sweepExpired()
    assert.equal(swept.broadcasts, 1)
  })

  it('regenerating a broadcast kills the old token and its payload', async () => {
    const exp = new Date(Date.now() + 60_000)
    await upsertBroadcast({ userId: 'u', gameId: 'g', token: 't1', nowIso: NOW, expiresAt: exp })
    await updateBroadcastPayload({ userId: 'u', gameId: 'g', json: '{"secret":1}', nowIso: NOW, expiresAt: exp })
    await upsertBroadcast({ userId: 'u', gameId: 'g', token: 't2', nowIso: NOW, expiresAt: exp })
    assert.equal(await getBroadcastByToken('t1'), null)
    assert.deepEqual(await getBroadcastByToken('t2'), { payload: null, updatedAt: NOW })
  })
})

describe('feedback and the changelog archive', () => {
  it('deletes only the ids that exist and says which', async () => {
    for (const id of ['f1', 'f2']) {
      await insertFeedback({ feedbackId: id, createdAt: NOW, userId: null, appVersion: null, route: null, message: 'm', contextJson: null, attachmentJson: null })
    }
    assert.deepEqual(await deleteFeedback(['f1', 'nope']), ['f1'])
    assert.deepEqual((await listFeedback(10)).map((f) => f.feedback_id), ['f2'])
  })

  it('pages the archive by version number, ranks coming back as numbers', async () => {
    const entry = (version: string) => ({ rank: versionRank(version), version, date: '2026-01-01', en: '[]', ru: '[]' })
    await upsertChangelog(['2.9.9', '2.10.0', '2.1.0'].map(entry))
    const page = await listChangelog(null, 2)
    assert.deepEqual(page.map((e) => e.version), ['2.10.0', '2.9.9', '2.1.0'], 'limit + 1 rows, numeric order')
    assert.equal(typeof page[0]!.rank, 'number')
    const next = await listChangelog(page[1]!.rank, 2)
    assert.deepEqual(next.map((e) => e.version), ['2.1.0'])
    assert.equal((await getChangelogByRanks([versionRank('2.10.0')])).length, 1)
  })
})

// Keep `db` referenced so the import (which also sets the env) is not elided.
void db
