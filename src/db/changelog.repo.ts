import { db } from './driver.js'
import type { StoredEntry } from '../domain/changelog.js'

export interface ChangelogRow {
  rank: number
  version: string
  date: string | null
  en: string | null
  ru: string | null
}

// A page of the archive, newest first: entries ranked below `beforeRank` (all of them when null).
// One more than asked is read, so the caller can tell whether a further page exists without a
// second query.
// `rank` is a bigint column, which the driver hands back as a string; callers compare numbers.
const toRow = (r: ChangelogRow): ChangelogRow => ({ ...r, rank: Number(r.rank) })

export async function listChangelog(beforeRank: number | null, limit: number): Promise<ChangelogRow[]> {
  const rows = await db()<ChangelogRow[]>`
    SELECT rank, version, date, en, ru FROM changelog
    WHERE rank < ${beforeRank ?? 0xffffffff}
    ORDER BY rank DESC LIMIT ${limit + 1}`
  return rows.map(toRow)
}

// Idempotent by version: publishing the same entry twice rewrites the row in place, so a deploy
// that failed after this step can simply run again. One statement per entry — a publish is one
// entry per release (43 once, at the first move), not worth a batched struct list.
export async function upsertChangelog(entries: StoredEntry[]): Promise<void> {
  for (const e of entries) {
    await db()`
      INSERT INTO changelog (rank, version, date, en, ru) VALUES (${e.rank}, ${e.version}, ${e.date}, ${e.en}, ${e.ru})
      ON CONFLICT (rank) DO UPDATE SET version = EXCLUDED.version, date = EXCLUDED.date, en = EXCLUDED.en, ru = EXCLUDED.ru`
  }
}

// Read-back for the publish check: the stored rows for exactly these versions.
export async function getChangelogByRanks(ranks: number[]): Promise<ChangelogRow[]> {
  if (!ranks.length) return []
  const rows = await db()<ChangelogRow[]>`
    SELECT rank, version, date, en, ru FROM changelog WHERE rank IN ${db()(ranks)}`
  return rows.map(toRow)
}
