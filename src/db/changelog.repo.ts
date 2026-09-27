import { TypedValues, Types } from 'ydb-sdk'
import { query } from './driver.js'
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
export async function listChangelog(beforeRank: number | null, limit: number): Promise<ChangelogRow[]> {
  return query<ChangelogRow>(
    `DECLARE $before AS Uint32;
     DECLARE $limit AS Uint64;
     SELECT rank, version, date, en, ru FROM changelog
     WHERE rank < $before
     ORDER BY rank DESC LIMIT $limit;`,
    {
      $before: TypedValues.uint32(beforeRank ?? 0xffffffff),
      $limit: TypedValues.uint64(limit + 1),
    },
  )
}

// Idempotent by version: publishing the same entry twice rewrites the row in place, so a deploy
// that failed after this step can simply run again. One statement per entry — a publish is one
// entry per release (43 once, at the first move), not worth a batched struct list.
export async function upsertChangelog(entries: StoredEntry[]): Promise<void> {
  for (const e of entries) {
    await query(
      `DECLARE $rank AS Uint32;
       DECLARE $version AS Utf8;
       DECLARE $date AS Utf8;
       DECLARE $en AS Utf8;
       DECLARE $ru AS Utf8;
       UPSERT INTO changelog (rank, version, date, en, ru) VALUES ($rank, $version, $date, $en, $ru);`,
      {
        $rank: TypedValues.uint32(e.rank),
        $version: TypedValues.utf8(e.version),
        $date: TypedValues.utf8(e.date),
        $en: TypedValues.utf8(e.en),
        $ru: TypedValues.utf8(e.ru),
      },
    )
  }
}

// Read-back for the publish check: the stored rows for exactly these versions.
export async function getChangelogByRanks(ranks: number[]): Promise<ChangelogRow[]> {
  if (!ranks.length) return []
  return query<ChangelogRow>(
    `DECLARE $ranks AS List<Uint32>;
     SELECT rank, version, date, en, ru FROM changelog WHERE rank IN $ranks;`,
    { $ranks: TypedValues.list(Types.UINT32, ranks) },
  )
}
