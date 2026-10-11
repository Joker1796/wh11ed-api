// Fill the local stand's database with the players of stand/players.json and their data, through
// the same repo functions the API uses — a seed that went around them could hide a broken query.
//
//   npm run stand:seed            add what is missing (re-runnable: everything is an upsert)
//   npm run stand:reset           drop everything, migrate from scratch, seed
//
// Refuses to touch anything but a database on this machine or in the stand's compose network:
// `--reset` drops the whole schema.
import { readFileSync } from 'node:fs'
import { db, closeDb } from '../src/db/driver.js'
import { migrate } from '../src/db/schema.js'
import { upsertUser } from '../src/db/users.repo.js'
import { upsertRoster, tombstoneRoster } from '../src/db/rosters.repo.js'
import { upsertGame } from '../src/db/games.repo.js'
import { writePrefsScope, listPrefs } from '../src/db/prefs.repo.js'
import { insertFeedback } from '../src/db/feedback.repo.js'
import { upsertChangelog } from '../src/db/changelog.repo.js'
import { upsertBroadcast, updateBroadcastPayload } from '../src/db/broadcasts.repo.js'
import { parseRoster, extractMetadata as rosterMeta } from '../src/domain/roster.js'
import { parseGame, extractMetadata as gameMeta } from '../src/domain/game.js'
import { versionRank } from '../src/domain/changelog.js'
import { config } from '../src/config.js'

const host = new URL(config.databaseUrl).hostname
if (!['localhost', '127.0.0.1', 'postgres'].includes(host)) {
  console.error(`Refusing to seed ${host}: the seed is for the local stand only.`)
  process.exit(2)
}

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T
const players = read<{ id: string; name: string; email: string }[]>('./players.json')
const rosters = read<Record<string, unknown>[]>('./fixtures/rosters.json')
const games = read<Record<string, unknown>[]>('./fixtures/games.json')

const uid = (playerId: string) => `yandex:${playerId}`
const [alice, bob] = players.map((p) => uid(p.id))
const now = new Date().toISOString()

if (process.argv.includes('--reset')) {
  await db().unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  console.log('Schema dropped.')
}
const applied = await migrate()
if (applied.length) console.log(`Migrations: ${applied.join(', ')}`)

for (const p of players) {
  await upsertUser({ userId: uid(p.id), email: p.email, displayName: p.name, nowIso: now })
}

// Alice: all three lists. Bob: the Havocs list, and a tombstone — a list he deleted on another
// device, which a second device must learn about instead of re-uploading.
for (const raw of rosters) {
  const { roster, json } = parseRoster(raw)
  await upsertRoster({ userId: alice!, meta: rosterMeta(roster), json, nowIso: now })
}
const havocs = rosters.find((r) => r.id === 'stand-havocs')!
{
  const { roster, json } = parseRoster(havocs)
  await upsertRoster({ userId: bob!, meta: rosterMeta(roster), json, nowIso: now })
  const gone = parseRoster({ ...havocs, id: 'stand-deleted', name: 'Удалённый список' })
  await upsertRoster({ userId: bob!, meta: rosterMeta(gone.roster), json: gone.json, nowIso: now })
  await tombstoneRoster({ userId: bob!, rosterId: 'stand-deleted', deletedAtMs: Date.parse('2026-10-05T10:00:00Z'), nowIso: now })
}

for (const raw of games) {
  const { game, json } = parseGame(raw)
  await upsertGame({ userId: alice!, meta: gameMeta(game), json, nowIso: now })
}

// Alice's pinned factions — the `@factions` row, the shape useUserPrefs.js writes. Written once:
// a second seed must not bump the version under a device that already merged it.
if (!(await listPrefs(alice!)).some((s) => s.scope === '@factions')) {
  const at = Date.parse('2026-10-01T12:00:00Z')
  const doc = { fav: { 'space-marines': { at }, 'imperial-agents': { at } } }
  await writePrefsScope({
    userId: alice!, scope: '@factions', expectedVersion: 0, json: JSON.stringify(doc),
    updatedAtMs: at, nowIso: now, maxScopes: config.maxPrefsScopesPerUser,
  })
}

// The bug-report inbox `npm run feedback:list` reads: one anonymous, one signed in, one with a
// list attached.
const reports = [
  { id: 'stand-fb-1', user: null, route: '/ru/rules', message: 'Опечатка в правиле 04.01: «оружия» вместо «оружие».', att: null },
  { id: 'stand-fb-2', user: alice!, route: '/ru/roster', message: 'После удаления отряда очки не пересчитались, пока не обновил страницу.', att: null },
  { id: 'stand-fb-3', user: bob!, route: '/ru/roster/stand-havocs', message: 'Havocs: не даёт взять четыре тяжёлых болтера.', att: havocs },
]
for (const r of reports) {
  await db()`DELETE FROM feedback WHERE feedback_id = ${r.id}`
  await insertFeedback({
    feedbackId: r.id, createdAt: now, userId: r.user, appVersion: '2.7.21', route: r.route, message: r.message,
    contextJson: JSON.stringify({ ua: 'stand', errors: [] }), attachmentJson: r.att ? JSON.stringify({ roster: r.att }) : null,
  })
}

// Two archived release notes, so the changelog page has an "older" page to load.
await upsertChangelog(
  [
    { version: '2.0.1', date: '2026-07-20', en: ['A stand note, older.'], ru: ['Запись стенда, старая.'] },
    { version: '2.0.0', date: '2026-07-15', en: [{ h: 'Stand' }, 'A stand note.'], ru: [{ h: 'Стенд' }, 'Запись стенда.'] },
  ].map((e) => ({ rank: versionRank(e.version), version: e.version, date: e.date, en: JSON.stringify(e.en), ru: JSON.stringify(e.ru) })),
)

// A live broadcast with a fixed token: http://localhost:8787/broadcast/stand-broadcast-0001 answers.
await upsertBroadcast({ userId: alice!, gameId: 'stand-game-3', token: 'stand-broadcast-0001', nowIso: now, expiresAt: new Date(Date.now() + 7 * 86_400_000) })
await updateBroadcastPayload({
  userId: alice!, gameId: 'stand-game-3', nowIso: now, expiresAt: new Date(Date.now() + 7 * 86_400_000),
  json: JSON.stringify({ round: 3, players: [{ name: 'Алиса', vp: 31 }, { name: 'Боб', vp: 18 }] }),
})

const count = async (t: string) => (await db()`SELECT COUNT(*)::int AS n FROM ${db()(t)}`)[0]!.n
console.log(
  `Seeded: ${await count('users')} users, ${await count('rosters')} rosters, ${await count('games')} games, ` +
    `${await count('feedback')} reports, ${await count('changelog')} archived notes, 1 broadcast.`,
)
await closeDb()
