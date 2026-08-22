import { z } from 'zod'
import { config } from '../config.js'

// An army list is stored as an opaque JSON blob, exactly like a game: we validate only the
// envelope the API itself needs — `id` for ownership/idempotency, the rest for the list
// endpoint — and pass everything else through untouched. The client owns the list's internal
// shape (units, wargear picks, its own `v` schema version) and evolves it freely.

// Roster id constraint, shared between the payload envelope and the URL route param.
export const rosterIdSchema = z.string().min(1).max(64)

// Client timestamps here are epoch milliseconds (the roster store's `Date.now()`), NOT the ISO
// strings the game envelope carries. `updatedAt` is what last-write-wins compares on, so it is
// mirrored into its own column instead of living only inside the blob.
const tsSchema = z.number().int().nonnegative()

export const rosterSchema = z
  .object({
    id: rosterIdSchema,
    name: z.string().max(200).optional().default(''),
    faction: z.string().max(120).nullable().optional(),
    createdAt: tsSchema.optional(),
    updatedAt: tsSchema.optional(),
    units: z.array(z.unknown()).optional(),
    summary: z
      .object({
        points: z.number().optional(),
        unitCount: z.number().optional(),
      })
      .passthrough()
      .optional(),
    // A wizard draft never leaves the device it was started on — it isn't a list yet (see the
    // frontend's useRosterSync). A saved roster carries no `draft` key at all, so `false` is the
    // only value this accepts and a stray draft is rejected rather than filling the cloud.
    draft: z.literal(false).optional(),
  })
  .passthrough()

export type Roster = z.infer<typeof rosterSchema>

export interface RosterMetadata {
  rosterId: string
  name: string
  faction: string | null
  updatedAt: number
  // Denormalised from the client's cached summary purely so the list endpoint can render a card
  // without downloading the blob. Never recomputed here — the client owns the arithmetic.
  points: number
  unitCount: number
}

export function extractMetadata(roster: Roster): RosterMetadata {
  return {
    rosterId: roster.id,
    name: roster.name ?? '',
    faction: roster.faction ?? null,
    updatedAt: roster.updatedAt ?? 0,
    points: Number(roster.summary?.points ?? 0) || 0,
    unitCount: Number(roster.summary?.unitCount ?? 0) || 0,
  }
}

/** Parse + validate a raw roster payload, enforcing the byte cap. Returns the canonical string too. */
export function parseRoster(raw: unknown): { roster: Roster; json: string } {
  const roster = rosterSchema.parse(raw)
  const json = JSON.stringify(roster)
  if (Buffer.byteLength(json, 'utf8') > config.maxRosterBytes) {
    throw new RosterPayloadError(`Roster payload exceeds ${config.maxRosterBytes} bytes`)
  }
  return { roster, json }
}

export class RosterPayloadError extends Error {}
