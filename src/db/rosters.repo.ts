import { TypedValues } from 'ydb-sdk'
import { query } from './driver.js'
import type { RosterListEntry, RosterMetadata } from '../domain/roster.js'

interface RosterMetaRow {
  roster_id: string
  name: string | null
  faction: string | null
  updated_at: string | null
  points: string | null
  unit_count: string | null
  deleted_at: string | null
}

interface RosterBlobRow {
  blob: string | null
}

interface CountRow {
  cnt: number | bigint
}

// Tombstones don't count against the quota — a deleted list is not a stored list.
export async function countRosters(userId: string): Promise<number> {
  const rows = await query<CountRow>(
    `DECLARE $user_id AS Utf8;
     SELECT COUNT(*) AS cnt FROM rosters
     WHERE user_id = $user_id AND (deleted_at IS NULL OR deleted_at = '');`,
    { $user_id: TypedValues.utf8(userId) },
  )
  return Number(rows[0]?.cnt ?? 0)
}

// Returns live lists AND tombstones — the tombstones are the whole point of the endpoint for a
// second device, which has no other way to learn that a list was deleted elsewhere.
export async function listRosters(userId: string, limit: number): Promise<RosterListEntry[]> {
  // updated_at is epoch milliseconds kept as Utf8 (the table's convention — see schema.ts), so
  // this ORDER BY is lexicographic. Epoch ms stays 13 digits until the year 2286, which makes
  // it identical to numeric order; the client re-compares numerically anyway.
  const rows = await query<RosterMetaRow>(
    `DECLARE $user_id AS Utf8;
     DECLARE $limit AS Uint64;
     SELECT roster_id, name, faction, updated_at, points, unit_count, deleted_at
     FROM rosters WHERE user_id = $user_id
     ORDER BY updated_at DESC, roster_id DESC
     LIMIT $limit;`,
    { $user_id: TypedValues.utf8(userId), $limit: TypedValues.uint64(limit) },
  )
  return rows.map((r) =>
    r.deleted_at
      ? { rosterId: r.roster_id, deleted: true as const, deletedAt: Number(r.deleted_at) || 0 }
      : {
          rosterId: r.roster_id,
          name: r.name || '',
          faction: r.faction || null,
          updatedAt: Number(r.updated_at) || 0,
          points: Number(r.points) || 0,
          unitCount: Number(r.unit_count) || 0,
        },
  )
}

export async function getRosterBlob(userId: string, rosterId: string): Promise<unknown | null> {
  const rows = await query<RosterBlobRow>(
    `DECLARE $user_id AS Utf8;
     DECLARE $roster_id AS Utf8;
     SELECT blob FROM rosters WHERE user_id = $user_id AND roster_id = $roster_id;`,
    { $user_id: TypedValues.utf8(userId), $roster_id: TypedValues.utf8(rosterId) },
  )
  const blob = rows[0]?.blob
  if (!blob) return null
  try {
    return JSON.parse(blob)
  } catch {
    // A corrupted blob shouldn't surface as a 500; treat it as absent (404) and log for triage.
    console.error(`[rosters] corrupt blob for user=${userId} roster=${rosterId}`)
    return null
  }
}

export async function upsertRoster(input: {
  userId: string
  meta: RosterMetadata
  json: string
  nowIso: string
}): Promise<void> {
  const { meta } = input
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $roster_id AS Utf8;
     DECLARE $blob AS Utf8;
     DECLARE $name AS Utf8;
     DECLARE $faction AS Utf8;
     DECLARE $updated_at AS Utf8;
     DECLARE $points AS Utf8;
     DECLARE $unit_count AS Utf8;
     DECLARE $server_updated_at AS Utf8;
     UPSERT INTO rosters
       (user_id, roster_id, blob, name, faction, updated_at, points, unit_count, deleted_at, server_updated_at)
     VALUES
       ($user_id, $roster_id, $blob, $name, $faction, $updated_at, $points, $unit_count, '', $server_updated_at);`,
    {
      $user_id: TypedValues.utf8(input.userId),
      $roster_id: TypedValues.utf8(meta.rosterId),
      $blob: TypedValues.utf8(input.json),
      $name: TypedValues.utf8(meta.name),
      $faction: TypedValues.utf8(meta.faction ?? ''),
      $updated_at: TypedValues.utf8(String(meta.updatedAt)),
      $points: TypedValues.utf8(String(meta.points)),
      $unit_count: TypedValues.utf8(String(meta.unitCount)),
      $server_updated_at: TypedValues.utf8(input.nowIso),
    },
  )
}

// Delete = empty the row and stamp it, so the id keeps saying "this list was deleted" to every
// other device. UPDATE, not UPSERT: deleting an id the cloud never held must not conjure a
// tombstone out of nothing (that would let a client fill the table with ids it invented).
export async function tombstoneRoster(input: {
  userId: string
  rosterId: string
  deletedAtMs: number
  nowIso: string
}): Promise<void> {
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $roster_id AS Utf8;
     DECLARE $deleted_at AS Utf8;
     DECLARE $server_updated_at AS Utf8;
     UPDATE rosters
     SET blob = '', name = '', faction = '', points = '0', unit_count = '0',
         updated_at = $deleted_at, deleted_at = $deleted_at, server_updated_at = $server_updated_at
     WHERE user_id = $user_id AND roster_id = $roster_id;`,
    {
      $user_id: TypedValues.utf8(input.userId),
      $roster_id: TypedValues.utf8(input.rosterId),
      $deleted_at: TypedValues.utf8(String(input.deletedAtMs)),
      $server_updated_at: TypedValues.utf8(input.nowIso),
    },
  )
}

// Sweep tombstones nobody can still need. A device that has been offline longer than this and
// then syncs will re-upload its copy of a list deleted elsewhere — which is why the window is
// generous rather than tight. Runs on delete (a rare operation), so no scheduled job exists.
// The `deleted_at != ''` guard is what keeps live lists out of it; the string comparison is
// exact because epoch-ms is a fixed 13 digits until the year 2286.
export async function purgeOldTombstones(userId: string, cutoffMs: number): Promise<void> {
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $cutoff AS Utf8;
     DELETE FROM rosters
     WHERE user_id = $user_id AND deleted_at IS NOT NULL AND deleted_at != '' AND deleted_at < $cutoff;`,
    { $user_id: TypedValues.utf8(userId), $cutoff: TypedValues.utf8(String(cutoffMs)) },
  )
}
