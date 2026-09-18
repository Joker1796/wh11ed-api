import { randomBytes, randomInt } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config.js'

// A PARTY is one live game shared by several phones. The server is the authority on its state and
// the host (the account that created it) is the owner of the rights; everything else is a member
// holding an opaque token. The state travels in SLICES — the tracker's own cut of a game
// (wh11ed `gameSlices.js`): `shared` (the clock, the settings, finished or not), `side0`/`side1`
// (one side's scores, cards, CP, army state) and `roster0`/`roster1` (that side's army list). Each
// slice is versioned on its own, so two phones scoring different sides never conflict, and a slice
// is also the unit of RIGHTS: a side's two slices belong to the seat(s) on that side, the shared
// one to everybody in the game. The blobs themselves stay opaque, like a game or a roster.
//
// Pure module: token shapes, schemas, the rights and version decisions. No DB, no HTTP — every
// rule that decides who may write what is here, where a unit test can reach it.

export const SLICE_NAMES = ['shared', 'side0', 'side1', 'roster0', 'roster1'] as const
export type SliceName = (typeof SLICE_NAMES)[number]

export function isSliceName(v: string): v is SliceName {
  return (SLICE_NAMES as readonly string[]).includes(v)
}

/** Which side owns a slice: 0 / 1, or null for the shared one. Mirrors the client's sideOfSlice. */
export function sideOfSlice(name: SliceName): 0 | 1 | null {
  const m = /^(?:side|roster)([01])$/.exec(name)
  return m ? (Number(m[1]) as 0 | 1) : null
}

// ── Tokens ─────────────────────────────────────────────────────────────────────────────────────
// Three kinds, all opaque random strings. The MEMBER token is a device's credential for one party
// (stored hashed, like a refresh token — it grants writes). The INVITE token rides in the link /
// QR and is exchanged for a member token on join; unguessable is its whole security, like a share
// link. The CODE is six digits — typed by hand across a table, so it must be short-lived, guarded
// by a per-address throttle, and worth nothing by itself once it has been exchanged.

export function newPartyId(): string {
  return randomBytes(12).toString('base64url')
}
export function newMemberToken(): string {
  return randomBytes(32).toString('base64url')
}
export function newInviteToken(): string {
  return randomBytes(16).toString('base64url')
}
export function newJoinCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export const partyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/)
export const memberTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
export const joinCodeSchema = z.string().regex(/^\d{6}$/)
export const memberIdSchema = z.string().regex(/^[a-f0-9]{32}$/)

// ── Seats ──────────────────────────────────────────────────────────────────────────────────────
// A seat is `{ side, mi }`: which of the two sides, and — in doubles — which member of the team.
// `mi` is null in singles. A member with no seat can read the game and write nothing.

export const seatSchema = z.object({
  side: z.union([z.literal(0), z.literal(1)]),
  mi: z.union([z.literal(0), z.literal(1)]).nullable().default(null),
})
export type Seat = z.infer<typeof seatSchema>

export interface MemberRights {
  host: boolean
  side: 0 | 1 | null
}

/**
 * May this member write this slice? A side's slices belong to the seats on that side — in doubles
 * both partners, knowingly (the companion keys CP, cards and Battle Ready to the team). The shared
 * slice belongs to everyone seated. The host owns the game and may write any slice: swapping who
 * goes first rewrites all five, and that is the host's call.
 */
export function canWriteSlice(m: MemberRights, name: SliceName): boolean {
  if (m.host) return true
  if (m.side == null) return false
  const side = sideOfSlice(name)
  return side == null || side === m.side
}

// ── The sync request ───────────────────────────────────────────────────────────────────────────

const sliceDataSchema = z.object({}).passthrough()

export const syncBodySchema = z.object({
  since: z.number().int().min(0),
  slices: z
    .record(
      z.string(),
      z.object({
        version: z.number().int().min(0),
        data: sliceDataSchema,
      }),
    )
    .optional(),
})
export type SyncBody = z.infer<typeof syncBodySchema>

export class SliceTooLargeError extends Error {}
export class UnknownSliceError extends Error {}

export interface SliceWrite {
  name: SliceName
  version: number // the version the client based its edit on
  json: string
}

/** Validate the writes of a sync body: known names, and each blob inside the byte cap. */
export function parseSliceWrites(slices: SyncBody['slices']): SliceWrite[] {
  const out: SliceWrite[] = []
  for (const [name, s] of Object.entries(slices || {})) {
    if (!isSliceName(name)) throw new UnknownSliceError(name)
    const json = JSON.stringify(s.data)
    if (Buffer.byteLength(json, 'utf8') > config.maxPartySliceBytes) throw new SliceTooLargeError(name)
    out.push({ name, version: s.version, json })
  }
  return out
}

/** The full set a party is created with: every slice present, so a row exists for each from day one. */
export const createBodySchema = z.object({
  gameId: z.string().min(1).max(64),
  slices: z.object({
    shared: sliceDataSchema,
    side0: sliceDataSchema,
    side1: sliceDataSchema,
    roster0: sliceDataSchema,
    roster1: sliceDataSchema,
  }),
  seat: seatSchema,
  name: z.string().max(120).default(''),
})

export const joinBodySchema = z.union([
  z.object({ code: joinCodeSchema }),
  z.object({ invite: inviteTokenSchema }),
])

export const seatBodySchema = seatSchema.extend({ name: z.string().max(120).default('') })

// ── Version decisions ──────────────────────────────────────────────────────────────────────────

export interface StoredSlice {
  name: SliceName
  version: number
  seq: number
}

/**
 * Optimistic concurrency over a BATCH: every write must be based on the version the server holds,
 * or the whole batch is refused — a step of the clock writes `shared` and both sides' cards at
 * once, and landing half of it would leave a game no phone ever had. Returns the names that are
 * stale, empty when the batch may land.
 */
export function staleWrites(writes: SliceWrite[], stored: StoredSlice[]): SliceName[] {
  const byName = new Map(stored.map((s) => [s.name, s.version]))
  return writes.filter((w) => (byName.get(w.name) ?? 0) !== w.version).map((w) => w.name)
}

export type PartyStatus = 'open' | 'finished'

/**
 * What the party's status becomes after a write, read off the shared slice: the tracker marks a
 * finished game with `phase: 'finished'`, and a finished party is read-only for everyone. Only
 * the host may reopen it (`resumeGame` on the host's phone) — a guest's shared write against a
 * finished party is refused before it gets here.
 */
export function statusAfterWrite(current: PartyStatus, writes: SliceWrite[]): PartyStatus {
  const shared = writes.find((w) => w.name === 'shared')
  if (!shared) return current
  try {
    const phase = (JSON.parse(shared.json) as { phase?: unknown }).phase
    return phase === 'finished' ? 'finished' : 'open'
  } catch {
    return current
  }
}

/** Is this write allowed against a finished party? Only the host reopening it. */
export function writeAllowedWhenFinished(m: MemberRights, writes: SliceWrite[]): boolean {
  return m.host && statusAfterWrite('finished', writes) === 'open'
}

// ── Expiry ─────────────────────────────────────────────────────────────────────────────────────

/** A party that nobody has touched for `partyTtlDays` is garbage; every write pushes this forward. */
export function partyExpiry(now = Date.now()): Date {
  return new Date(now + config.partyTtlDays * 24 * 60 * 60 * 1000)
}

/** The join code lives minutes: it is typed across a table, not kept. */
export function codeExpiry(now = Date.now()): string {
  return new Date(now + config.partyCodeTtlMinutes * 60 * 1000).toISOString()
}

export function codeLive(codeExpiresAt: string | null, now = Date.now()): boolean {
  return !!codeExpiresAt && new Date(codeExpiresAt).getTime() > now
}

/** A seat is held while its member is not revoked. The same device always reclaims its own seat. */
export function seatHeldBy<T extends { member_id: string; side: number | null; mi: number | null; revoked_at: string | null }>(
  members: T[],
  seat: Seat,
  self: string,
): T | null {
  return (
    members.find(
      (m) => m.member_id !== self && !m.revoked_at && m.side === seat.side && (m.mi ?? null) === (seat.mi ?? null),
    ) ?? null
  )
}

/**
 * The sides some OTHER live member sits on — what a phone needs to keep its hands off a side
 * another phone is playing. The rights (`canWriteSlice`) do not change with this: the host may
 * still write any slice, because editing the setup rewrites both sides at once; the phone's screen
 * is what locks a held side, and freeing the seat (a kick) is how the host takes it back.
 */
export function heldSides<T extends { member_id: string; side: number | null; revoked_at: string | null }>(
  members: T[],
  self: string,
): number[] {
  const out = new Set<number>()
  for (const m of members) if (m.member_id !== self && !m.revoked_at && m.side != null) out.add(m.side)
  return [...out].sort()
}
