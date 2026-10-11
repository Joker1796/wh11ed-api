import { db, transaction, type Runner } from './driver.js'
import {
  SLICE_NAMES,
  staleWrites,
  type PartyStatus,
  type SliceName,
  type SliceWrite,
} from '../domain/party.js'

export interface PartyRow {
  party_id: string
  host_user_id: string
  game_id: string
  invite_token: string | null
  code: string | null
  code_expires_at: string | null
  seq: number
  status: PartyStatus
  created_at: string
  updated_at: string
}

export interface MemberRow {
  party_id: string
  member_id: string
  token_hash: string
  role: 'host' | 'player'
  side: number | null
  mi: number | null
  name: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

export interface StateRow {
  slice: SliceName
  version: number
  seq: number
  data: string
}

// Column lists as SQL fragments (`db().unsafe` of a constant — never of input).
const PARTY_COLS = () =>
  db().unsafe('party_id, host_user_id, game_id, invite_token, code, code_expires_at, seq, status, created_at, updated_at')
const MEMBER_COLS = () =>
  db().unsafe('party_id, member_id, token_hash, role, side, mi, name, created_at, last_seen_at, revoked_at')

function partyRow(r: Record<string, unknown> | undefined): PartyRow | null {
  if (!r) return null
  return {
    party_id: String(r.party_id),
    host_user_id: String(r.host_user_id ?? ''),
    game_id: String(r.game_id ?? ''),
    invite_token: (r.invite_token as string | null) ?? null,
    code: (r.code as string | null) ?? null,
    code_expires_at: (r.code_expires_at as string | null) ?? null,
    seq: Number(r.seq ?? 0),
    status: r.status === 'finished' ? 'finished' : 'open',
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  }
}

function memberRow(r: Record<string, unknown>): MemberRow {
  return {
    party_id: String(r.party_id),
    member_id: String(r.member_id),
    token_hash: String(r.token_hash ?? ''),
    role: r.role === 'host' ? 'host' : 'player',
    side: r.side == null ? null : Number(r.side),
    mi: r.mi == null ? null : Number(r.mi),
    name: String(r.name ?? ''),
    created_at: String(r.created_at ?? ''),
    last_seen_at: (r.last_seen_at as string | null) ?? null,
    revoked_at: (r.revoked_at as string | null) ?? null,
  }
}

export interface NewMember {
  memberId: string
  tokenHash: string
  role: 'host' | 'player'
  side: number | null
  mi: number | null
  name: string
}

// ── Creation ───────────────────────────────────────────────────────────────────────────────────

/**
 * A party, its host's seat and all five slices in one transaction — a party with a slice row
 * missing would make every later write a special case.
 */
export async function createParty(input: {
  partyId: string
  hostUserId: string
  gameId: string
  inviteToken: string
  code: string
  codeExpiresAt: string
  host: NewMember
  slices: Record<SliceName, string>
  nowIso: string
  expiresAt: Date
}): Promise<void> {
  await transaction(async (tx) => {
    await tx`
      INSERT INTO parties (party_id, host_user_id, game_id, invite_token, code, code_expires_at,
                           seq, status, created_at, updated_at, expires_at)
      VALUES (${input.partyId}, ${input.hostUserId}, ${input.gameId}, ${input.inviteToken}, ${input.code},
              ${input.codeExpiresAt}, 1, 'open', ${input.nowIso}, ${input.nowIso}, ${input.expiresAt})`
    await insertMemberWith(tx, input.partyId, input.host, input.nowIso, input.expiresAt)
    for (const name of SLICE_NAMES) {
      await tx`
        INSERT INTO party_state (party_id, slice, version, seq, data, updated_at, expires_at)
        VALUES (${input.partyId}, ${name}, 1, 1, ${input.slices[name]}, ${input.nowIso}, ${input.expiresAt})`
    }
  })
}

async function insertMemberWith(run: Runner, partyId: string, m: NewMember, nowIso: string, expiresAt: Date) {
  await run`
    INSERT INTO party_members (party_id, member_id, token_hash, role, side, mi, name, created_at,
                               last_seen_at, revoked_at, expires_at)
    VALUES (${partyId}, ${m.memberId}, ${m.tokenHash}, ${m.role}, ${m.side}, ${m.mi}, ${m.name}, ${nowIso},
            ${nowIso}, NULL, ${expiresAt})
    ON CONFLICT (party_id, member_id) DO UPDATE SET
      token_hash = EXCLUDED.token_hash, role = EXCLUDED.role, side = EXCLUDED.side, mi = EXCLUDED.mi,
      name = EXCLUDED.name, created_at = EXCLUDED.created_at, last_seen_at = EXCLUDED.last_seen_at,
      revoked_at = NULL, expires_at = EXCLUDED.expires_at`
}

export async function insertMember(partyId: string, m: NewMember, nowIso: string, expiresAt: Date): Promise<void> {
  await insertMemberWith(db(), partyId, m, nowIso, expiresAt)
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────

export async function getParty(partyId: string): Promise<PartyRow | null> {
  const rows = await db()`SELECT ${PARTY_COLS()} FROM parties WHERE party_id = ${partyId}`
  return partyRow(rows[0])
}

export async function getPartyByInvite(inviteToken: string): Promise<PartyRow | null> {
  const rows = await db()`SELECT ${PARTY_COLS()} FROM parties WHERE invite_token = ${inviteToken}`
  return partyRow(rows[0])
}

/** Several parties can hold the same six digits at once; the caller picks the one whose code is live. */
export async function getPartiesByCode(code: string): Promise<PartyRow[]> {
  const rows = await db()`SELECT ${PARTY_COLS()} FROM parties WHERE code = ${code}`
  return rows.map((r) => partyRow(r)!).filter(Boolean)
}

export async function getMemberByToken(tokenHash: string): Promise<MemberRow | null> {
  const rows = await db()`SELECT ${MEMBER_COLS()} FROM party_members WHERE token_hash = ${tokenHash}`
  return rows[0] ? memberRow(rows[0]) : null
}

export async function listMembers(partyId: string): Promise<MemberRow[]> {
  const rows = await db()`SELECT ${MEMBER_COLS()} FROM party_members WHERE party_id = ${partyId}`
  return rows.map(memberRow)
}

export async function listState(partyId: string): Promise<StateRow[]> {
  const rows = await db()<{ slice: string; version: number; seq: number; data: string }[]>`
    SELECT slice, version, seq, data FROM party_state WHERE party_id = ${partyId}`
  return rows.map((r) => ({
    slice: r.slice as SliceName,
    version: Number(r.version ?? 0),
    seq: Number(r.seq ?? 0),
    data: String(r.data ?? ''),
  }))
}

// ── Writes ─────────────────────────────────────────────────────────────────────────────────────

export type WriteResult =
  | { ok: true; seq: number; versions: Partial<Record<SliceName, number>> }
  | { ok: false; stale: SliceName[] }

/**
 * Land a batch of slice writes, all or nothing, in one serializable transaction: read the
 * versions the rows hold now, refuse the batch if any write is based on an older one, otherwise
 * bump each slice's version and the party's seq together. The party's TTL horizon moves with
 * every write — the game is alive.
 */
export async function writeSlices(input: {
  partyId: string
  writes: SliceWrite[]
  status: PartyStatus
  nowIso: string
  expiresAt: Date
}): Promise<WriteResult> {
  return transaction(async (tx) => {
    const stored = await tx<{ slice: string; version: number }[]>`
      SELECT slice, version FROM party_state WHERE party_id = ${input.partyId}`
    const stale = staleWrites(
      input.writes,
      stored.map((s) => ({ name: s.slice as SliceName, version: Number(s.version ?? 0), seq: 0 })),
    )
    if (stale.length) return { ok: false as const, stale }

    const party = await tx<{ seq: number }[]>`SELECT seq FROM parties WHERE party_id = ${input.partyId}`
    const seq = Number(party[0]?.seq ?? 0) + 1
    const versions: Partial<Record<SliceName, number>> = {}
    for (const w of input.writes) {
      versions[w.name] = w.version + 1
      await tx`
        UPDATE party_state
        SET version = ${w.version + 1}, seq = ${seq}, data = ${w.json}, updated_at = ${input.nowIso},
            expires_at = ${input.expiresAt}
        WHERE party_id = ${input.partyId} AND slice = ${w.name}`
    }
    await tx`
      UPDATE parties SET seq = ${seq}, status = ${input.status}, updated_at = ${input.nowIso},
                         expires_at = ${input.expiresAt}
      WHERE party_id = ${input.partyId}`
    return { ok: true as const, seq, versions }
  })
}

/**
 * An administrative change (a seat moved, a member kicked, the host handed over) bumps the
 * party's seq without touching a slice, so every polling phone gets a 200 carrying its own
 * refreshed standing instead of a 204 that tells it nothing.
 */
export async function bumpSeq(partyId: string, nowIso: string, expiresAt: Date): Promise<number> {
  return transaction(async (tx) => {
    const rows = await tx<{ seq: number }[]>`SELECT seq FROM parties WHERE party_id = ${partyId}`
    const seq = Number(rows[0]?.seq ?? 0) + 1
    await tx`
      UPDATE parties SET seq = ${seq}, updated_at = ${nowIso}, expires_at = ${expiresAt}
      WHERE party_id = ${partyId}`
    return seq
  })
}

/** A fresh code (and, when asked, a fresh link token) for the invite. */
export async function setInvite(input: {
  partyId: string
  inviteToken: string | null // null = keep the link
  code: string
  codeExpiresAt: string
  nowIso: string
}): Promise<void> {
  await db()`
    UPDATE parties
    SET invite_token = COALESCE(${input.inviteToken}::text, invite_token), code = ${input.code},
        code_expires_at = ${input.codeExpiresAt}, updated_at = ${input.nowIso}
    WHERE party_id = ${input.partyId}`
}

export async function updateMemberSeat(input: {
  partyId: string
  memberId: string
  side: number | null
  mi: number | null
  name: string
}): Promise<void> {
  await db()`
    UPDATE party_members SET side = ${input.side}, mi = ${input.mi}, name = ${input.name}
    WHERE party_id = ${input.partyId} AND member_id = ${input.memberId}`
}

/**
 * Swap the two sides across every live seat, in one statement: side 0 becomes 1 and 1 becomes 0,
 * the member index inside a doubles team stays put. This is what keeps seats attached to their
 * ARMY when the host settles who goes first — the client reorders the players so the first-turn
 * side is index 0, and a seat that did not move with them would name the other army.
 */
export async function swapMemberSides(partyId: string): Promise<void> {
  await db()`
    UPDATE party_members SET side = 1 - side
    WHERE party_id = ${partyId} AND side IS NOT NULL AND revoked_at IS NULL`
}

export async function setMemberRole(partyId: string, memberId: string, role: 'host' | 'player'): Promise<void> {
  await db()`UPDATE party_members SET role = ${role} WHERE party_id = ${partyId} AND member_id = ${memberId}`
}

/** The token dies and the seat is free; the row stays so the host's list can say who left. */
export async function revokeMember(partyId: string, memberId: string, nowIso: string): Promise<void> {
  await db()`
    UPDATE party_members SET revoked_at = ${nowIso}, token_hash = '', side = NULL, mi = NULL
    WHERE party_id = ${partyId} AND member_id = ${memberId}`
}

/** A fresh token for an existing member (the host reclaiming a lost phone). */
export async function rotateMemberToken(partyId: string, memberId: string, tokenHash: string): Promise<void> {
  await db()`
    UPDATE party_members SET token_hash = ${tokenHash}, revoked_at = NULL
    WHERE party_id = ${partyId} AND member_id = ${memberId}`
}

export async function touchMember(partyId: string, memberId: string, nowIso: string, expiresAt: Date): Promise<void> {
  await db()`
    UPDATE party_members SET last_seen_at = ${nowIso}, expires_at = ${expiresAt}
    WHERE party_id = ${partyId} AND member_id = ${memberId}`
}

/** The party is over: every row of it goes, so every token dies with it. */
export async function deleteParty(partyId: string): Promise<void> {
  await transaction(async (tx) => {
    await tx`DELETE FROM party_state WHERE party_id = ${partyId}`
    await tx`DELETE FROM party_members WHERE party_id = ${partyId}`
    await tx`DELETE FROM parties WHERE party_id = ${partyId}`
  })
}
