// Move release notes into the archive table: `npm run changelog:publish -- <entries.json>`.
// Needs the same YDB env as `npm run migrate`.
//
// The file is a JSON array of entries exactly as the frontend's src/data/changelog.js holds them
// ({ version, date, en, ru }). The frontend's deploy calls this with the entries it is about to
// drop from its own file, and drops them ONLY if this exits 0 — so the order below matters: every
// entry is validated before anything is written, and everything written is read back and compared
// before success is reported. Idempotent: running it again rewrites the same rows.
import { readFileSync } from 'node:fs'
import { ChangelogEntryError, toStored, type StoredEntry } from '../src/domain/changelog.js'
import { getChangelogByRanks, upsertChangelog } from '../src/db/changelog.repo.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: npm run changelog:publish -- <entries.json>')
  process.exit(2)
}

let raw: unknown
try {
  raw = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`✗ cannot read ${file}: ${(e as Error).message}`)
  process.exit(1)
}
if (!Array.isArray(raw)) {
  console.error(`✗ ${file} is not a JSON array of entries`)
  process.exit(1)
}

let entries: StoredEntry[]
try {
  entries = raw.map(toStored)
} catch (e) {
  if (e instanceof ChangelogEntryError) {
    console.error(`✗ ${e.message} — nothing written`)
    process.exit(1)
  }
  throw e
}
const ranks = entries.map((e) => e.rank)
if (new Set(ranks).size !== ranks.length) {
  console.error('✗ the same version appears twice — nothing written')
  process.exit(1)
}
if (!entries.length) {
  console.log('Nothing to publish.')
  process.exit(0)
}

await upsertChangelog(entries)

const back = new Map((await getChangelogByRanks(ranks)).map((r) => [r.rank, r]))
const wrong = entries.filter((e) => {
  const r = back.get(e.rank)
  return !r || r.version !== e.version || r.date !== e.date || r.en !== e.en || r.ru !== e.ru
})
if (wrong.length) {
  console.error(`✗ read-back differs for ${wrong.map((e) => e.version).join(', ')}`)
  process.exit(1)
}
console.log(`✓ published ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: ${entries.map((e) => e.version).join(', ')}`)
process.exit(0)
