import { TypedValues, Types } from 'ydb-sdk'
import { query, transaction, type Runner } from './driver.js'
import {
  SLICE_NAMES,
  staleWrites,
  type PartyStatus,
  type SliceName,
  type SliceWrite,
} from '../domain/party.js'

// Nullable params: the sdk has no one-call helper for a NULLABLE typed value, so wrap or null.
const optUtf8 = (v: string | null | undefined) =>
  v == null ? TypedValues.optionalNull(Types.UTF8) : TypedValues.optional(TypedValues.utf8(v))
const optInt32 = (v: number | null | undefined) =>
  v == null ? TypedValues.optionalNull(Types.INT32) : TypedValues.optional(TypedValues.int32(v))

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

const PARTY_COLS = `party_id, host_user_id, game_id, invite_token, code, code_expires_at,
  seq, status, created_at, updated_at`
const MEMBER_COLS = `party_id, member_id, token_hash, role, side, mi, name, created_at, last_seen_at, revoked_at`

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
  await transaction(async (run) => {
    await run(
      `DECLARE $party_id AS Utf8;
       DECLARE $host_user_id AS Utf8;
       DECLARE $game_id AS Utf8;
       DECLARE $invite_token AS Utf8;
       DECLARE $code AS Utf8;
       DECLARE $code_expires_at AS Utf8;
       DECLARE $now AS Utf8;
       DECLARE $expires_at AS Timestamp;
       UPSERT INTO parties (${PARTY_COLS}, expires_at)
       VALUES ($party_id, $host_user_id, $game_id, $invite_token, $code, $code_expires_at,
               1u, "open", $now, $now, $expires_at);`,
      {
        $party_id: TypedValues.utf8(input.partyId),
        $host_user_id: TypedValues.utf8(input.hostUserId),
        $game_id: TypedValues.utf8(input.gameId),
        $invite_token: TypedValues.utf8(input.inviteToken),
        $code: TypedValues.utf8(input.code),
        $code_expires_at: TypedValues.utf8(input.codeExpiresAt),
        $now: TypedValues.utf8(input.nowIso),
        $expires_at: TypedValues.timestamp(input.expiresAt),
      },
    )
    await insertMemberWith(run, input.partyId, input.host, input.nowIso, input.expiresAt)
    for (const name of SLICE_NAMES) {
      await run(
        `DECLARE $party_id AS Utf8;
         DECLARE $slice AS Utf8;
         DECLARE $data AS Utf8;
         DECLARE $now AS Utf8;
         DECLARE $expires_at AS Timestamp;
         UPSERT INTO party_state (party_id, slice, version, seq, data, updated_at, expires_at)
         VALUES ($party_id, $slice, 1u, 1u, $data, $now, $expires_at);`,
        {
          $party_id: TypedValues.utf8(input.partyId),
          $slice: TypedValues.utf8(name),
          $data: TypedValues.utf8(input.slices[name]),
          $now: TypedValues.utf8(input.nowIso),
          $expires_at: TypedValues.timestamp(input.expiresAt),
        },
      )
    }
  })
}

async function insertMemberWith(run: Runner, partyId: string, m: NewMember, nowIso: string, expiresAt: Date) {
  await run(
    `DECLARE $party_id AS Utf8;
     DECLARE $member_id AS Utf8;
     DECLARE $token_hash AS Utf8;
     DECLARE $role AS Utf8;
     DECLARE $side AS Int32?;
     DECLARE $mi AS Int32?;
     DECLARE $name AS Utf8;
     DECLARE $now AS Utf8;
     DECLARE $expires_at AS Timestamp;
     UPSERT INTO party_members (${MEMBER_COLS}, expires_at)
     VALUES ($party_id, $member_id, $token_hash, $role, $side, $mi, $name, $now, $now, NULL, $expires_at);`,
    {
      $party_id: TypedValues.utf8(partyId),
      $member_id: TypedValues.utf8(m.memberId),
      $token_hash: TypedValues.utf8(m.tokenHash),
      $role: TypedValues.utf8(m.role),
      $side: optInt32(m.side),
      $mi: optInt32(m.mi),
      $name: TypedValues.utf8(m.name),
      $now: TypedValues.utf8(nowIso),
      $expires_at: TypedValues.timestamp(expiresAt),
    },
  )
}

export async function insertMember(partyId: string, m: NewMember, nowIso: string, expiresAt: Date): Promise<void> {
  await insertMemberWith(query, partyId, m, nowIso, expiresAt)
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────

export async function getParty(partyId: string): Promise<PartyRow | null> {
  const rows = await query(
    `DECLARE $party_id AS Utf8;
     SELECT ${PARTY_COLS} FROM parties WHERE party_id = $party_id;`,
    { $party_id: TypedValues.utf8(partyId) },
  )
  return partyRow(rows[0])
}

export async function getPartyByInvite(inviteToken: string): Promise<PartyRow | null> {
  const rows = await query(
    `DECLARE $invite_token AS Utf8;
     SELECT ${PARTY_COLS} FROM parties VIEW idx_parties_invite WHERE invite_token = $invite_token;`,
    { $invite_token: TypedValues.utf8(inviteToken) },
  )
  return partyRow(rows[0])
}

/** Several parties can hold the same six digits at once; the caller picks the one whose code is live. */
export async function getPartiesByCode(code: string): Promise<PartyRow[]> {
  const rows = await query(
    `DECLARE $code AS Utf8;
     SELECT ${PARTY_COLS} FROM parties VIEW idx_parties_code WHERE code = $code;`,
    { $code: TypedValues.utf8(code) },
  )
  return rows.map((r) => partyRow(r)!).filter(Boolean)
}

export async function getMemberByToken(tokenHash: string): Promise<MemberRow | null> {
  const rows = await query(
    `DECLARE $token_hash AS Utf8;
     SELECT ${MEMBER_COLS} FROM party_members VIEW idx_party_members_token WHERE token_hash = $token_hash;`,
    { $token_hash: TypedValues.utf8(tokenHash) },
  )
  return rows[0] ? memberRow(rows[0]) : null
}

export async function listMembers(partyId: string): Promise<MemberRow[]> {
  const rows = await query(
    `DECLARE $party_id AS Utf8;
     SELECT ${MEMBER_COLS} FROM party_members WHERE party_id = $party_id;`,
    { $party_id: TypedValues.utf8(partyId) },
  )
  return rows.map(memberRow)
}

export async function listState(partyId: string): Promise<StateRow[]> {
  const rows = await query<{ slice: string; version: number; seq: number; data: string }>(
    `DECLARE $party_id AS Utf8;
     SELECT slice, version, seq, data FROM party_state WHERE party_id = $party_id;`,
    { $party_id: TypedValues.utf8(partyId) },
  )
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
  return transaction(async (run) => {
    const stored = await run<{ slice: string; version: number }>(
      `DECLARE $party_id AS Utf8;
       SELECT slice, version FROM party_state WHERE party_id = $party_id;`,
      { $party_id: TypedValues.utf8(input.partyId) },
    )
    const stale = staleWrites(
      input.writes,
      stored.map((s) => ({ name: s.slice as SliceName, version: Number(s.version ?? 0), seq: 0 })),
    )
    if (stale.length) return { ok: false as const, stale }

    const party = await run<{ seq: number }>(
      `DECLARE $party_id AS Utf8;
       SELECT seq FROM parties WHERE party_id = $party_id;`,
      { $party_id: TypedValues.utf8(input.partyId) },
    )
    const seq = Number(party[0]?.seq ?? 0) + 1
    const versions: Partial<Record<SliceName, number>> = {}
    for (const w of input.writes) {
      versions[w.name] = w.version + 1
      await run(
        `DECLARE $party_id AS Utf8;
         DECLARE $slice AS Utf8;
         DECLARE $version AS Uint32;
         DECLARE $seq AS Uint32;
         DECLARE $data AS Utf8;
         DECLARE $now AS Utf8;
         DECLARE $expires_at AS Timestamp;
         UPDATE party_state
         SET version = $version, seq = $seq, data = $data, updated_at = $now, expires_at = $expires_at
         WHERE party_id = $party_id AND slice = $slice;`,
        {
          $party_id: TypedValues.utf8(input.partyId),
          $slice: TypedValues.utf8(w.name),
          $version: TypedValues.uint32(w.version + 1),
          $seq: TypedValues.uint32(seq),
          $data: TypedValues.utf8(w.json),
          $now: TypedValues.utf8(input.nowIso),
          $expires_at: TypedValues.timestamp(input.expiresAt),
        },
      )
    }
    await run(
      `DECLARE $party_id AS Utf8;
       DECLARE $seq AS Uint32;
       DECLARE $status AS Utf8;
       DECLARE $now AS Utf8;
       DECLARE $expires_at AS Timestamp;
       UPDATE parties SET seq = $seq, status = $status, updated_at = $now, expires_at = $expires_at
       WHERE party_id = $party_id;`,
      {
        $party_id: TypedValues.utf8(input.partyId),
        $seq: TypedValues.uint32(seq),
        $status: TypedValues.utf8(input.status),
        $now: TypedValues.utf8(input.nowIso),
        $expires_at: TypedValues.timestamp(input.expiresAt),
      },
    )
    return { ok: true as const, seq, versions }
  })
}

/**
 * An administrative change (a seat moved, a member kicked, the host handed over) bumps the
 * party's seq without touching a slice, so every polling phone gets a 200 carrying its own
 * refreshed standing instead of a 204 that tells it nothing.
 */
export async function bumpSeq(partyId: string, nowIso: string, expiresAt: Date): Promise<number> {
  return transaction(async (run) => {
    const rows = await run<{ seq: number }>(
      `DECLARE $party_id AS Utf8;
       SELECT seq FROM parties WHERE party_id = $party_id;`,
      { $party_id: TypedValues.utf8(partyId) },
    )
    const seq = Number(rows[0]?.seq ?? 0) + 1
    await run(
      `DECLARE $party_id AS Utf8;
       DECLARE $seq AS Uint32;
       DECLARE $now AS Utf8;
       DECLARE $expires_at AS Timestamp;
       UPDATE parties SET seq = $seq, updated_at = $now, expires_at = $expires_at WHERE party_id = $party_id;`,
      {
        $party_id: TypedValues.utf8(partyId),
        $seq: TypedValues.uint32(seq),
        $now: TypedValues.utf8(nowIso),
        $expires_at: TypedValues.timestamp(expiresAt),
      },
    )
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
  await query(
    `DECLARE $party_id AS Utf8;
     DECLARE $invite_token AS Utf8?;
     DECLARE $code AS Utf8;
     DECLARE $code_expires_at AS Utf8;
     DECLARE $now AS Utf8;
     UPDATE parties
     SET invite_token = COALESCE($invite_token, invite_token), code = $code, code_expires_at = $code_expires_at,
         updated_at = $now
     WHERE party_id = $party_id;`,
    {
      $party_id: TypedValues.utf8(input.partyId),
      $invite_token: optUtf8(input.inviteToken),
      $code: TypedValues.utf8(input.code),
      $code_expires_at: TypedValues.utf8(input.codeExpiresAt),
      $now: TypedValues.utf8(input.nowIso),
    },
  )
}

export async function updateMemberSeat(input: {
  partyId: string
  memberId: string
  side: number | null
  mi: number | null
  name: string
}): Promise<void> {
  await query(
    `DECLARE $party_id AS Utf8;
     DECLARE $member_id AS Utf8;
     DECLARE $side AS Int32?;
     DECLARE $mi AS Int32?;
     DECLARE $name AS Utf8;
     UPDATE party_members SET side = $side, mi = $mi, name = $name
     WHERE party_id = $party_id AND member_id = $member_id;`,
    {
      $party_id: TypedValues.utf8(input.partyId),
      $member_id: TypedValues.utf8(input.memberId),
      $side: optInt32(input.side),
      $mi: optInt32(input.mi),
      $name: TypedValues.utf8(input.name),
    },
  )
}

export async function setMemberRole(partyId: string, memberId: string, role: 'host' | 'player'): Promise<void> {
  await query(
    `DECLARE $party_id AS Utf8;
     DECLARE $member_id AS Utf8;
     DECLARE $role AS Utf8;
     UPDATE party_members SET role = $role WHERE party_id = $party_id AND member_id = $member_id;`,
    {
      $party_id: TypedValues.utf8(partyId),
      $member_id: TypedValues.utf8(memberId),
      $role: TypedValues.utf8(role),
    },
  )
}

/** The token dies and the seat is free; the row stays so the host's list can say who left. */
export async function revokeMember(partyId: string, memberId: string, nowIso: string): Promise<void> {
  await query(
    `DECLARE $party_id AS Utf8;
     DECLARE $member_id AS Utf8;
     DECLARE $now AS Utf8;
     UPDATE party_members SET revoked_at = $now, token_hash = "", side = NULL, mi = NULL
     WHERE party_id = $party_id AND member_id = $member_id;`,
    {
      $party_id: TypedValues.utf8(partyId),
      $member_id: TypedValues.utf8(memberId),
      $now: TypedValues.utf8(nowIso),
    },
  )
}

/** A fresh token for an existing member (the host reclaiming a lost phone). */
export async function rotateMemberToken(partyId: string, memberId: string, tokenHash: string): Promise<void> {
  await query(
    `DECLARE $party_id AS Utf8;
     DECLARE $member_id AS Utf8;
     DECLARE $token_hash AS Utf8;
     UPDATE party_members SET token_hash = $token_hash, revoked_at = NULL
     WHERE party_id = $party_id AND member_id = $member_id;`,
    {
      $party_id: TypedValues.utf8(partyId),
      $member_id: TypedValues.utf8(memberId),
      $token_hash: TypedValues.utf8(tokenHash),
    },
  )
}

export async function touchMember(partyId: string, memberId: string, nowIso: string, expiresAt: Date): Promise<void> {
  await query(
    `DECLARE $party_id AS Utf8;
     DECLARE $member_id AS Utf8;
     DECLARE $now AS Utf8;
     DECLARE $expires_at AS Timestamp;
     UPDATE party_members SET last_seen_at = $now, expires_at = $expires_at
     WHERE party_id = $party_id AND member_id = $member_id;`,
    {
      $party_id: TypedValues.utf8(partyId),
      $member_id: TypedValues.utf8(memberId),
      $now: TypedValues.utf8(nowIso),
      $expires_at: TypedValues.timestamp(expiresAt),
    },
  )
}

/** The party is over: every row of it goes, so every token dies with it. */
export async function deleteParty(partyId: string): Promise<void> {
  await transaction(async (run) => {
    for (const table of ['party_state', 'party_members', 'parties']) {
      await run(
        `DECLARE $party_id AS Utf8;
         DELETE FROM ${table} WHERE party_id = $party_id;`,
        { $party_id: TypedValues.utf8(partyId) },
      )
    }
  })
}
