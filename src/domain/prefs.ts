import { z } from 'zod'
import { config } from '../config.js'

// A player's own marks — pinned factions, favourite datasheets, and the "I own this box"
// collection. Stored, like a game or a roster, as an opaque JSON blob the client owns: the
// server never looks inside, and in particular knows nothing about datasheets. What a mark
// means, which id replaced which, and when a unit left the game are all decided on the client,
// which is the only side that ships the rules data to decide them with.
//
// Two things make this different from /rosters:
//
//   1. ONE ROW PER FACTION, not per document. Marking a box is a single tap on a crowded screen,
//      and a tap must not rewrite everything a player has ever marked. `scope` is the faction
//      slug; the pinned-faction list belongs to no faction and lives under `@factions` (an `@`
//      cannot occur in a slug, so the two namespaces can't collide).
//   2. OPTIMISTIC CONCURRENCY, not last-write-wins. Marks merge cell by cell on the client, so a
//      blind overwrite would drop what the other device added between this device's read and its
//      write — and "nothing is lost" is the whole point of the feature. A PUT therefore carries
//      the `version` it merged from; a stale one is refused with the current row attached, so the
//      client re-merges and retries without a second round trip. Same shape as a party slice.
export const prefsScopeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(@factions|[a-z0-9-]+)$/, 'scope must be a faction slug or @factions')

export const GLOBAL_SCOPE = '@factions'

// The blob is the client's, but not unbounded: a cell carries a timestamp and a tombstone stays
// until it is swept, so a runaway client must not be able to fill the table.
export const prefsDataSchema = z.record(z.string(), z.unknown())

export const prefsPutSchema = z.object({
  // The version this write was merged from. 0 means "I believe this scope does not exist yet".
  version: z.number().int().nonnegative(),
  data: prefsDataSchema,
})

export interface PrefsScopeRow {
  scope: string
  version: number
  updatedAt: number
  data: Record<string, unknown>
}

export class PrefsPayloadError extends Error {}

/** Validate a scope payload and enforce the byte cap. Returns the canonical string too. */
export function parsePrefsData(raw: unknown): { data: Record<string, unknown>; json: string } {
  const data = prefsDataSchema.parse(raw)
  const json = JSON.stringify(data)
  if (Buffer.byteLength(json, 'utf8') > config.maxPrefsScopeBytes) {
    throw new PrefsPayloadError(`Prefs payload exceeds ${config.maxPrefsScopeBytes} bytes`)
  }
  return { data, json }
}

// The GET's ETag. Every write bumps its scope's version, so the set of (scope, version) pairs
// identifies the whole collection exactly — no hashing of blobs, and a visit that changed
// nothing costs a 304 with no body.
export function prefsEtag(rows: Pick<PrefsScopeRow, 'scope' | 'version'>[]): string {
  const parts = rows
    .map((r) => `${r.scope}:${r.version}`)
    .sort()
    .join(',')
  return `"${parts || 'empty'}"`
}
