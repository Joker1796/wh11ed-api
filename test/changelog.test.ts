import { before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { ChangelogEntryError, fromStored, pageLimit, toStored, versionRank } from '../src/domain/changelog.js'

// The release-notes archive: the entry shape the frontend's changelog.js holds, and the public
// page read against an in-memory repo (the YQL itself is verified on the stand — see CLAUDE.md).

const entry = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  date: '2026-09-01',
  en: [{ h: 'Roster builder' }, 'A note.'],
  ru: [{ h: 'Конструктор' }, 'Пункт.'],
  ...extra,
})

describe('versionRank', () => {
  it('orders versions as numbers, not strings', () => {
    assert.ok(versionRank('2.10.0') > versionRank('2.9.9'))
    assert.ok(versionRank('3.0.0') > versionRank('2.999.999'))
    assert.equal(versionRank('2.7.4'), 2_007_004)
  })
  it('rejects what is not a version', () => {
    assert.throws(() => versionRank('2.7'))
    assert.throws(() => versionRank('v2.7.4'))
  })
})

describe('toStored / fromStored', () => {
  it('round-trips an entry exactly', () => {
    const e = entry('2.6.0')
    assert.deepEqual(fromStored(toStored(e)), e)
  })

  // The frontend renders both locales from the same positions.
  it('refuses locales that are not parallel', () => {
    assert.throws(() => toStored(entry('2.6.0', { ru: ['Пункт.'] })), ChangelogEntryError)
    assert.throws(() => toStored(entry('2.6.0', { ru: ['Заголовок стал пунктом', 'Пункт.'] })), ChangelogEntryError)
  })

  it('refuses unknown fields and malformed dates', () => {
    assert.throws(() => toStored(entry('2.6.0', { extra: 1 })), ChangelogEntryError)
    assert.throws(() => toStored(entry('2.6.0', { date: '27.09.2026' })), ChangelogEntryError)
  })

  it('names the entry it refused', () => {
    assert.throws(() => toStored(entry('2.6.0', { en: [] })), /entry 2\.6\.0/)
  })
})

describe('pageLimit', () => {
  it('defaults, bounds and rejects', () => {
    assert.equal(pageLimit(undefined), 10)
    assert.equal(pageLimit('5'), 5)
    assert.equal(pageLimit('0'), null)
    assert.equal(pageLimit('21'), null)
    assert.equal(pageLimit('ten'), null)
  })
})

// ── GET /changelog against an in-memory table ────────────────────────────────────────────────
const table = ['2.1.0', '2.2.0', '2.9.9', '2.10.0', '2.10.1'].map((v) => ({ ...toStored(entry(v)) }))
const fakeRepo = {
  async listChangelog(beforeRank: number | null, limit: number) {
    return table
      .filter((r) => beforeRank == null || r.rank < beforeRank)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit + 1)
  },
  async upsertChangelog() {},
  async getChangelogByRanks() { return [] },
}
mock.module(new URL('../src/db/changelog.repo.ts', import.meta.url).href, { namedExports: fakeRepo })

let app: Hono
before(async () => {
  const { changelogRoutes } = await import('../src/routes/changelog.js')
  app = new Hono()
  app.route('/changelog', changelogRoutes)
})

describe('GET /changelog', () => {
  it('pages newest first, in version order, and says whether more remain', async () => {
    const first = await app.request('/changelog?limit=2')
    assert.equal(first.status, 200)
    const a = await first.json() as { entries: { version: string }[]; more: boolean }
    assert.deepEqual(a.entries.map((e) => e.version), ['2.10.1', '2.10.0'])
    assert.equal(a.more, true)

    const next = await app.request('/changelog?limit=2&before=2.10.0')
    const b = await next.json() as { entries: { version: string }[]; more: boolean }
    assert.deepEqual(b.entries.map((e) => e.version), ['2.9.9', '2.2.0'])
    assert.equal(b.more, true)

    const last = await app.request('/changelog?limit=2&before=2.2.0')
    const c = await last.json() as { entries: { version: string }[]; more: boolean }
    assert.deepEqual(c.entries.map((e) => e.version), ['2.1.0'])
    assert.equal(c.more, false)
  })

  it('returns the notes as the frontend wrote them, and lets a cache keep the page', async () => {
    const res = await app.request('/changelog?limit=1')
    assert.match(res.headers.get('Cache-Control') || '', /max-age=3600/)
    const { entries } = await res.json() as { entries: unknown[] }
    assert.deepEqual(entries[0], entry('2.10.1'))
  })

  it('rejects a malformed cursor or page size', async () => {
    assert.equal((await app.request('/changelog?before=latest')).status, 400)
    assert.equal((await app.request('/changelog?limit=500')).status, 400)
  })
})
