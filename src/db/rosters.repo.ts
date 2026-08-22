import { TypedValues } from 'ydb-sdk'
import { query } from './driver.js'
import type { RosterMetadata } from '../domain/roster.js'

interface RosterMetaRow {
  roster_id: string
  name: string | null
  faction: string | null
  updated_at: string | null
  points: string | null
  unit_count: string | null
}

interface RosterBlobRow {
  blob: string | null
}

interface CountRow {
  cnt: number | bigint
}

export async function countRosters(userId: string): Promise<number> {
  const rows = await query<CountRow>(
    `DECLARE $user_id AS Utf8;
     SELECT COUNT(*) AS cnt FROM rosters WHERE user_id = $user_id;`,
    { $user_id: TypedValues.utf8(userId) },
  )
  return Number(rows[0]?.cnt ?? 0)
}

export async function listRosters(userId: string, limit: number): Promise<RosterMetadata[]> {
  // updated_at is epoch milliseconds kept as Utf8 (the table's convention — see schema.ts), so
  // this ORDER BY is lexicographic. Epoch ms stays 13 digits until the year 2286, which makes
  // it identical to numeric order; the client re-compares numerically anyway.
  const rows = await query<RosterMetaRow>(
    `DECLARE $user_id AS Utf8;
     DECLARE $limit AS Uint64;
     SELECT roster_id, name, faction, updated_at, points, unit_count
     FROM rosters WHERE user_id = $user_id
     ORDER BY updated_at DESC, roster_id DESC
     LIMIT $limit;`,
    { $user_id: TypedValues.utf8(userId), $limit: TypedValues.uint64(limit) },
  )
  return rows.map((r) => ({
    rosterId: r.roster_id,
    name: r.name || '',
    faction: r.faction || null,
    updatedAt: Number(r.updated_at) || 0,
    points: Number(r.points) || 0,
    unitCount: Number(r.unit_count) || 0,
  }))
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
       (user_id, roster_id, blob, name, faction, updated_at, points, unit_count, server_updated_at)
     VALUES
       ($user_id, $roster_id, $blob, $name, $faction, $updated_at, $points, $unit_count, $server_updated_at);`,
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

export async function deleteRoster(userId: string, rosterId: string): Promise<void> {
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $roster_id AS Utf8;
     DELETE FROM rosters WHERE user_id = $user_id AND roster_id = $roster_id;`,
    { $user_id: TypedValues.utf8(userId), $roster_id: TypedValues.utf8(rosterId) },
  )
}
