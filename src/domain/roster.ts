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

// What GET /rosters says about one list. A schema rather than an interface so the types the repo
// returns and the stand's OpenAPI description (src/openapi/) are one statement, not two.
export const rosterMetadataSchema = z.object({
  rosterId: rosterIdSchema,
  name: z.string(),
  faction: z.string().nullable(),
  updatedAt: z.number(),
  // Denormalised from the client's cached summary purely so the list endpoint can render a card
  // without downloading the blob. Never recomputed here — the client owns the arithmetic.
  points: z.number(),
  unitCount: z.number(),
})
export type RosterMetadata = z.infer<typeof rosterMetadataSchema>

// A deleted list keeps nothing but its id and the moment it died — enough for another device to
// drop its own copy, and nothing that would keep a deleted army list readable on the server.
// `deletedAt` is the deleting client's clock (the same scale as `updatedAt`), so a list saved
// after the delete outranks the tombstone and comes back.
export const rosterTombstoneSchema = z.object({
  rosterId: rosterIdSchema,
  deleted: z.literal(true),
  deletedAt: z.number(),
})
export type RosterTombstone = z.infer<typeof rosterTombstoneSchema>

export const rosterListEntrySchema = z.union([rosterMetadataSchema, rosterTombstoneSchema])
export type RosterListEntry = z.infer<typeof rosterListEntrySchema>

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
