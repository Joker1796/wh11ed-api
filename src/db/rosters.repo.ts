import { db } from './driver.js'
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
  cnt: string | number
}

// Tombstones don't count against the quota — a deleted list is not a stored list.
export async function countRosters(userId: string): Promise<number> {
  const rows = await db()<CountRow[]>`
    SELECT COUNT(*) AS cnt FROM rosters
    WHERE user_id = ${userId} AND (deleted_at IS NULL OR deleted_at = '')`
  return Number(rows[0]?.cnt ?? 0)
}

// Returns live lists AND tombstones — the tombstones are the whole point of the endpoint for a
// second device, which has no other way to learn that a list was deleted elsewhere.
export async function listRosters(userId: string, limit: number): Promise<RosterListEntry[]> {
  // updated_at is epoch milliseconds kept as Utf8 (the table's convention — see schema.ts), so
  // this ORDER BY is lexicographic. Epoch ms stays 13 digits until the year 2286, which makes
  // it identical to numeric order; the client re-compares numerically anyway.
  // COLLATE "C": byte order, as YDB compared Utf8 — a locale collation could sort differently.
  const rows = await db()<RosterMetaRow[]>`
    SELECT roster_id, name, faction, updated_at, points, unit_count, deleted_at
    FROM rosters WHERE user_id = ${userId}
    ORDER BY updated_at COLLATE "C" DESC, roster_id COLLATE "C" DESC
    LIMIT ${limit}`
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
  const rows = await db()<RosterBlobRow[]>`
    SELECT blob FROM rosters WHERE user_id = ${userId} AND roster_id = ${rosterId}`
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
  await db()`
    INSERT INTO rosters
      (user_id, roster_id, blob, name, faction, updated_at, points, unit_count, deleted_at, server_updated_at)
    VALUES
      (${input.userId}, ${meta.rosterId}, ${input.json}, ${meta.name}, ${meta.faction ?? ''},
       ${String(meta.updatedAt)}, ${String(meta.points)}, ${String(meta.unitCount)}, '', ${input.nowIso})
    ON CONFLICT (user_id, roster_id) DO UPDATE SET
      blob = EXCLUDED.blob, name = EXCLUDED.name, faction = EXCLUDED.faction, updated_at = EXCLUDED.updated_at,
      points = EXCLUDED.points, unit_count = EXCLUDED.unit_count, deleted_at = '',
      server_updated_at = EXCLUDED.server_updated_at`
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
  const deletedAt = String(input.deletedAtMs)
  await db()`
    UPDATE rosters
    SET blob = '', name = '', faction = '', points = '0', unit_count = '0',
        updated_at = ${deletedAt}, deleted_at = ${deletedAt}, server_updated_at = ${input.nowIso}
    WHERE user_id = ${input.userId} AND roster_id = ${input.rosterId}`
}

// Sweep tombstones nobody can still need. A device that has been offline longer than this and
// then syncs will re-upload its copy of a list deleted elsewhere — which is why the window is
// generous rather than tight. Runs on delete (a rare operation), so no scheduled job exists.
// The `deleted_at != ''` guard is what keeps live lists out of it; the string comparison is
// exact because epoch-ms is a fixed 13 digits until the year 2286.
export async function purgeOldTombstones(userId: string, cutoffMs: number): Promise<void> {
  await db()`
    DELETE FROM rosters
    WHERE user_id = ${userId} AND deleted_at IS NOT NULL AND deleted_at != ''
      AND deleted_at COLLATE "C" < ${String(cutoffMs)}`
}
