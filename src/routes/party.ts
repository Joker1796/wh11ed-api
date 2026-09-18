import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { requireAuth, type AuthVars } from '../auth/middleware.js'
import { hashToken, newId } from '../auth/refresh-logic.js'
import {
  canWriteSlice,
  codeExpiry,
  codeLive,
  createBodySchema,
  heldSides,
  joinBodySchema,
  memberIdSchema,
  memberTokenSchema,
  newInviteToken,
  newJoinCode,
  newMemberToken,
  newPartyId,
  parseSliceWrites,
  partyExpiry,
  partyIdSchema,
  seatBodySchema,
  seatHeldBy,
  SliceTooLargeError,
  statusAfterWrite,
  syncBodySchema,
  UnknownSliceError,
  writeAllowedWhenFinished,
  type MemberRights,
  type SliceName,
} from '../domain/party.js'
import {
  bumpSeq,
  createParty,
  deleteParty,
  getMemberByToken,
  getPartiesByCode,
  getParty,
  getPartyByInvite,
  insertMember,
  listMembers,
  listState,
  revokeMember,
  rotateMemberToken,
  setInvite,
  setMemberRole,
  touchMember,
  updateMemberSeat,
  writeSlices,
  type MemberRow,
  type PartyRow,
  type StateRow,
} from '../db/parties.repo.js'
import { clientIp, makeThrottle } from '../lib/throttle.js'

// A live game shared by several phones — see domain/party.ts for the model. Two credentials
// meet here: the host's account JWT creates a party (and reclaims it from a lost phone); after
// that EVERY phone, the host's included, speaks with a member token minted for this party alone.
// The only public door is /join, which exchanges an invite (link token or six-digit code) for a
// member token — and is fenced per address, because a six-digit code is guessable in principle.

interface PartyVars {
  member: MemberRow
}
type Vars = { Variables: AuthVars & PartyVars }

export const partyRoutes = new Hono<Vars>()

// ── Warm-instance caches ───────────────────────────────────────────────────────────────────────
// Four phones on one game poll every three seconds; the gateway charges per request, so the
// requests themselves are the cost we cannot dodge — but the reads behind them we can share. A
// party's state is served from memory for STATE_TTL_MS after a read and thrown away on any
// write to it, so every phone of one party in the same window costs one YDB read. Member rows
// are cached a little longer (they change on admin actions, which clear them here) — and the
// "last seen" stamp the host's list shows is written at most once a TOUCH_EVERY_MS per member,
// not on every poll.
const STATE_TTL_MS = 3000
const MEMBER_TTL_MS = 15_000
const TOUCH_EVERY_MS = 30_000

type CachedState = { at: number; party: PartyRow; rows: StateRow[]; members: MemberRow[] }
const stateCache = new Map<string, CachedState>()
type CachedMember = { at: number; touched: number; member: MemberRow }
const memberCache = new Map<string, CachedMember>()
const memberTokenByIds = new Map<string, string>() // `${partyId}/${memberId}` → token hash

function dropState(partyId: string) {
  stateCache.delete(partyId)
}
function dropMember(partyId: string, memberId: string) {
  const h = memberTokenByIds.get(`${partyId}/${memberId}`)
  if (h) memberCache.delete(h)
}
function dropParty(partyId: string, members: MemberRow[]) {
  dropState(partyId)
  for (const m of members) dropMember(partyId, m.member_id)
}

async function readState(partyId: string, now: number, fresh = false): Promise<CachedState | null> {
  const hit = stateCache.get(partyId)
  if (!fresh && hit && now - hit.at < STATE_TTL_MS) return hit
  // The members ride with the state: every response that says what moved also says which sides
  // other phones sit on (`held`), and a seat change drops this cache like a write does.
  const [party, rows, members] = await Promise.all([getParty(partyId), listState(partyId), listMembers(partyId)])
  if (!party) {
    stateCache.delete(partyId)
    return null
  }
  const entry = { at: now, party, rows, members }
  stateCache.set(partyId, entry)
  if (stateCache.size > 5000) stateCache.clear()
  return entry
}

// ── Throttles ──────────────────────────────────────────────────────────────────────────────────
// Joins per address: a code is six digits and lives ten minutes, so a guesser at this rate sees
// the code expire long before the odds mean anything. Syncs per MEMBER, not per address — a
// tournament hall puts every phone behind one NAT, and four of them polling every three
// seconds is a normal evening, not abuse.
const joinThrottled = makeThrottle(10, 60_000)
const syncThrottled = makeThrottle(60, 60_000)

// ── Member auth ────────────────────────────────────────────────────────────────────────────────

const requireMember = createMiddleware<Vars>(async (c, next) => {
  const idParsed = partyIdSchema.safeParse(c.req.param('id'))
  if (!idParsed.success) return c.json({ error: 'bad_id' }, 400)
  const header = c.req.header('Authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  const tokParsed = memberTokenSchema.safeParse(match?.[1])
  if (!tokParsed.success) return c.json({ error: 'missing_member_token' }, 401)
  const now = Date.now()
  const hash = hashToken(tokParsed.data)
  let hit = memberCache.get(hash)
  if (!hit || now - hit.at >= MEMBER_TTL_MS) {
    const member = await getMemberByToken(hash)
    if (!member) {
      memberCache.delete(hash)
      return c.json({ error: 'invalid_member_token' }, 401)
    }
    hit = { at: now, touched: hit?.touched ?? 0, member }
    memberCache.set(hash, hit)
    memberTokenByIds.set(`${member.party_id}/${member.member_id}`, hash)
    if (memberCache.size > 20000) memberCache.clear()
  }
  const member = hit.member
  // A kicked phone learns it on its next call — the revoke cleared this cache entry, so the row
  // above is fresh, and its revoked_at says so.
  if (member.revoked_at) return c.json({ error: 'revoked' }, 401)
  if (member.party_id !== idParsed.data) return c.json({ error: 'wrong_party' }, 403)
  c.set('member', member)
  if (now - hit.touched >= TOUCH_EVERY_MS) {
    hit.touched = now
    await touchMember(member.party_id, member.member_id, new Date(now).toISOString(), partyExpiry(now))
  }
  await next()
})

const requireHost = createMiddleware<Vars>(async (c, next) => {
  if (c.var.member.role !== 'host') return c.json({ error: 'host_only' }, 403)
  await next()
})

function rights(m: MemberRow): MemberRights {
  return { host: m.role === 'host', side: m.side === 0 || m.side === 1 ? m.side : null }
}

function youOf(m: MemberRow) {
  return { memberId: m.member_id, side: m.side, mi: m.mi, host: m.role === 'host' }
}

function memberView(m: MemberRow, self: string) {
  return {
    memberId: m.member_id,
    name: m.name,
    side: m.side,
    mi: m.mi,
    host: m.role === 'host',
    lastSeenAt: m.last_seen_at,
    you: m.member_id === self,
  }
}

function slicesOf(rows: StateRow[], pick?: (r: StateRow) => boolean) {
  const out: Partial<Record<SliceName, { version: number; data: unknown }>> = {}
  for (const r of rows) {
    if (pick && !pick(r)) continue
    let data: unknown = null
    try {
      data = JSON.parse(r.data)
    } catch {
      console.error(`[party] corrupt slice ${r.slice}`)
    }
    out[r.slice] = { version: r.version, data }
  }
  return out
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | undefined> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

// ── Create (the host, with an account) ─────────────────────────────────────────────────────────

partyRoutes.post('/', requireAuth, async (c) => {
  const raw = await readJson(c)
  if (raw === undefined) return c.json({ error: 'invalid_json' }, 400)
  const parsed = createBodySchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid_party' }, 422)
  const body = parsed.data

  let writes
  try {
    writes = parseSliceWrites(
      Object.fromEntries(Object.entries(body.slices).map(([k, data]) => [k, { version: 0, data }])),
    )
  } catch (e) {
    if (e instanceof SliceTooLargeError) return c.json({ error: 'payload_too_large' }, 413)
    return c.json({ error: 'invalid_party' }, 422)
  }

  const now = Date.now()
  const partyId = newPartyId()
  const memberId = newId()
  const memberToken = newMemberToken()
  const inviteToken = newInviteToken()
  const code = newJoinCode()
  const codeExpiresAt = codeExpiry(now)
  await createParty({
    partyId,
    hostUserId: c.var.userId,
    gameId: body.gameId,
    inviteToken,
    code,
    codeExpiresAt,
    host: {
      memberId,
      tokenHash: hashToken(memberToken),
      role: 'host',
      side: body.seat.side,
      mi: body.seat.mi,
      name: body.name,
    },
    slices: Object.fromEntries(writes.map((w) => [w.name, w.json])) as Record<SliceName, string>,
    nowIso: new Date(now).toISOString(),
    expiresAt: partyExpiry(now),
  })
  return c.json(
    {
      partyId,
      memberId,
      memberToken,
      seq: 1,
      status: 'open',
      versions: Object.fromEntries(writes.map((w) => [w.name, 1])),
      you: { memberId, side: body.seat.side, mi: body.seat.mi, host: true },
      invite: { token: inviteToken, code, codeExpiresAt },
    },
    201,
  )
})

// ── Join (public: the invite is the credential) ────────────────────────────────────────────────

partyRoutes.post('/join', async (c) => {
  const now = Date.now()
  if (joinThrottled(clientIp(c.req.header('X-Forwarded-For')), now)) {
    c.header('Retry-After', '30')
    return c.json({ error: 'too_many' }, 429)
  }
  const raw = await readJson(c)
  if (raw === undefined) return c.json({ error: 'invalid_json' }, 400)
  const parsed = joinBodySchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid_invite' }, 422)

  let party: PartyRow | null = null
  if ('code' in parsed.data) {
    // Six digits are not unique across parties; the live one wins, and two live at once is a
    // one-in-a-million evening we answer honestly rather than pick between.
    const live = (await getPartiesByCode(parsed.data.code)).filter((p) => codeLive(p.code_expires_at, now))
    if (live.length > 1) return c.json({ error: 'ambiguous_code' }, 409)
    party = live[0] ?? null
  } else {
    party = await getPartyByInvite(parsed.data.invite)
  }
  if (!party) return c.json({ error: 'not_found' }, 404)

  const memberId = newId()
  const memberToken = newMemberToken()
  const nowIso = new Date(now).toISOString()
  await insertMember(
    party.party_id,
    { memberId, tokenHash: hashToken(memberToken), role: 'player', side: null, mi: null, name: '' },
    nowIso,
    partyExpiry(now),
  )
  const [rows, members] = await Promise.all([listState(party.party_id), listMembers(party.party_id)])
  return c.json(
    {
      partyId: party.party_id,
      memberId,
      memberToken,
      seq: party.seq,
      status: party.status,
      slices: slicesOf(rows),
      members: members.filter((m) => !m.revoked_at).map((m) => memberView(m, memberId)),
      you: { memberId, side: null, mi: null, host: false },
    },
    201,
  )
})

// ── The host reclaiming a lost phone (account JWT, not a member token) ─────────────────────────

partyRoutes.post('/:id/reclaim', requireAuth, async (c) => {
  const idParsed = partyIdSchema.safeParse(c.req.param('id'))
  if (!idParsed.success) return c.json({ error: 'bad_id' }, 400)
  const party = await getParty(idParsed.data)
  if (!party || party.host_user_id !== c.var.userId) return c.json({ error: 'not_found' }, 404)
  const members = await listMembers(party.party_id)
  const host = members.find((m) => m.role === 'host')
  if (!host) return c.json({ error: 'not_found' }, 404)
  const memberToken = newMemberToken()
  await rotateMemberToken(party.party_id, host.member_id, hashToken(memberToken))
  dropMember(party.party_id, host.member_id)
  const rows = await listState(party.party_id)
  return c.json({
    partyId: party.party_id,
    memberId: host.member_id,
    memberToken,
    seq: party.seq,
    status: party.status,
    slices: slicesOf(rows),
    members: members.filter((m) => !m.revoked_at).map((m) => memberView(m, host.member_id)),
    you: youOf({ ...host, revoked_at: null }),
  })
})

// ── Everything below speaks with a member token ────────────────────────────────────────────────

partyRoutes.use('/:id', requireMember)
partyRoutes.use('/:id/*', requireMember)

// The whole game — what a phone rebuilds from after a reload or a long sleep.
partyRoutes.get('/:id', async (c) => {
  const state = await readState(c.var.member.party_id, Date.now())
  if (!state) return c.json({ error: 'not_found' }, 404)
  const me = c.var.member.member_id
  return c.json({
    seq: state.party.seq,
    status: state.party.status,
    slices: slicesOf(state.rows),
    members: state.members.filter((m) => !m.revoked_at).map((m) => memberView(m, me)),
    held: heldSides(state.members, me),
    you: youOf(c.var.member),
  })
})

partyRoutes.get('/:id/members', async (c) => {
  const members = await listMembers(c.var.member.party_id)
  return c.json({
    members: members.filter((m) => !m.revoked_at).map((m) => memberView(m, c.var.member.member_id)),
  })
})

// Take a seat. The same phone may always retake its own; a seat another live member holds is
// refused with who holds it, and the host's kick is the way past that.
partyRoutes.post('/:id/seat', async (c) => {
  const raw = await readJson(c)
  if (raw === undefined) return c.json({ error: 'invalid_json' }, 400)
  const parsed = seatBodySchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid_seat' }, 422)
  const me = c.var.member
  const members = await listMembers(me.party_id)
  const holder = seatHeldBy(members, parsed.data, me.member_id)
  if (holder) {
    return c.json({ error: 'seat_taken', heldBy: { name: holder.name, lastSeenAt: holder.last_seen_at } }, 409)
  }
  const now = Date.now()
  await updateMemberSeat({
    partyId: me.party_id,
    memberId: me.member_id,
    side: parsed.data.side,
    mi: parsed.data.mi,
    name: parsed.data.name,
  })
  dropMember(me.party_id, me.member_id)
  const seq = await bumpSeq(me.party_id, new Date(now).toISOString(), partyExpiry(now))
  dropState(me.party_id)
  return c.json({ seq, you: { memberId: me.member_id, side: parsed.data.side, mi: parsed.data.mi, host: me.role === 'host' } })
})

// A guest leaving on purpose: its own token dies and its seat is free, so the host's list does
// not show a ghost until the TTL. The host cannot leave — it ends the party or hands over first.
partyRoutes.post('/:id/leave', async (c) => {
  const me = c.var.member
  if (me.role === 'host') return c.json({ error: 'host_cannot_leave' }, 422)
  const now = Date.now()
  await revokeMember(me.party_id, me.member_id, new Date(now).toISOString())
  dropMember(me.party_id, me.member_id)
  await bumpSeq(me.party_id, new Date(now).toISOString(), partyExpiry(now))
  dropState(me.party_id)
  return c.body(null, 204)
})

// ── Sync: send what changed here, receive what changed elsewhere, one request ──────────────────
//
// `{ since, slices? }` → 204 when nothing has happened since `since` and nothing was sent;
// otherwise 200 with the party's seq, this phone's standing, the versions its writes landed at,
// and every slice someone ELSE changed since `since`. A write based on a stale version refuses
// the whole batch with 409 and the current state, so the phone can take the server's truth and
// carry on; a guest's write against a finished party is 423.

partyRoutes.post('/:id/sync', async (c) => {
  const me = c.var.member
  const now = Date.now()
  if (syncThrottled(me.member_id, now)) {
    c.header('Retry-After', '3')
    return c.json({ error: 'too_many' }, 429)
  }
  const raw = await readJson(c)
  if (raw === undefined) return c.json({ error: 'invalid_json' }, 400)
  const parsed = syncBodySchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid_sync' }, 422)
  const { since } = parsed.data

  let writes
  try {
    writes = parseSliceWrites(parsed.data.slices)
  } catch (e) {
    if (e instanceof SliceTooLargeError) return c.json({ error: 'payload_too_large' }, 413)
    if (e instanceof UnknownSliceError) return c.json({ error: 'unknown_slice' }, 422)
    throw e
  }
  const forbidden = writes.filter((w) => !canWriteSlice(rights(me), w.name)).map((w) => w.name)
  if (forbidden.length) return c.json({ error: 'forbidden_slice', slices: forbidden }, 403)

  const written: Partial<Record<SliceName, number>> = {}
  if (writes.length) {
    // Fresh, not cached: "is the game finished" must be answered by the row, not by a three-
    // second-old memory of it.
    const before = await readState(me.party_id, now, true)
    if (!before) return c.json({ error: 'not_found' }, 404)
    if (before.party.status === 'finished' && !writeAllowedWhenFinished(rights(me), writes)) {
      return c.json(
        {
          error: 'read_only',
          seq: before.party.seq,
          status: 'finished',
          you: youOf(me),
          held: heldSides(before.members, me.member_id),
          slices: slicesOf(before.rows),
        },
        423,
      )
    }
    const result = await writeSlices({
      partyId: me.party_id,
      writes,
      status: statusAfterWrite(before.party.status, writes),
      nowIso: new Date(now).toISOString(),
      expiresAt: partyExpiry(now),
    })
    dropState(me.party_id)
    if (!result.ok) {
      const state = await readState(me.party_id, now, true)
      if (!state) return c.json({ error: 'not_found' }, 404)
      return c.json(
        {
          error: 'version_conflict',
          stale: result.stale,
          seq: state.party.seq,
          status: state.party.status,
          you: youOf(me),
          held: heldSides(state.members, me.member_id),
          // Everything that moved since the phone last looked, the stale slices included whatever
          // their seq — the phone must replace its copy of those.
          slices: slicesOf(state.rows, (r) => r.seq > since || result.stale.includes(r.slice)),
        },
        409,
      )
    }
    Object.assign(written, result.versions)
  }

  const state = await readState(me.party_id, now)
  if (!state) return c.json({ error: 'not_found' }, 404)
  if (!writes.length && state.party.seq <= since) return c.body(null, 204)
  return c.json({
    seq: state.party.seq,
    status: state.party.status,
    you: youOf(me),
    held: heldSides(state.members, me.member_id),
    written,
    slices: slicesOf(state.rows, (r) => r.seq > since && !(r.slice in written)),
  })
})

// ── Host administration ────────────────────────────────────────────────────────────────────────

partyRoutes.get('/:id/invite', requireHost, async (c) => {
  const party = await getParty(c.var.member.party_id)
  if (!party) return c.json({ error: 'not_found' }, 404)
  const live = codeLive(party.code_expires_at)
  return c.json({
    token: party.invite_token,
    code: live ? party.code : null,
    codeExpiresAt: live ? party.code_expires_at : null,
  })
})

// A fresh code (and, with `{ link: true }`, a fresh link — the old one stops resolving).
const inviteBodySchema = z.object({ link: z.boolean().default(false) })
partyRoutes.post('/:id/invite', requireHost, async (c) => {
  const raw = (await readJson(c)) ?? {}
  const parsed = inviteBodySchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid_invite' }, 422)
  const now = Date.now()
  const token = parsed.data.link ? newInviteToken() : null
  const code = newJoinCode()
  const codeExpiresAt = codeExpiry(now)
  await setInvite({
    partyId: c.var.member.party_id,
    inviteToken: token,
    code,
    codeExpiresAt,
    nowIso: new Date(now).toISOString(),
  })
  const party = await getParty(c.var.member.party_id)
  return c.json({ token: party?.invite_token ?? token, code, codeExpiresAt })
})

async function memberOrNull(partyId: string, raw: string | undefined) {
  const parsed = memberIdSchema.safeParse(raw)
  if (!parsed.success) return null
  const members = await listMembers(partyId)
  return { members, target: members.find((m) => m.member_id === parsed.data && !m.revoked_at) ?? null }
}

// Move (or clear) another member's seat.
const hostSeatSchema = z.object({
  side: z.union([z.literal(0), z.literal(1)]).nullable(),
  mi: z.union([z.literal(0), z.literal(1)]).nullable().default(null),
  name: z.string().max(120).optional(),
})
partyRoutes.post('/:id/members/:mid/seat', requireHost, async (c) => {
  const found = await memberOrNull(c.var.member.party_id, c.req.param('mid'))
  if (!found?.target) return c.json({ error: 'not_found' }, 404)
  const raw = await readJson(c)
  if (raw === undefined) return c.json({ error: 'invalid_json' }, 400)
  const parsed = hostSeatSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid_seat' }, 422)
  const { side, mi } = parsed.data
  if (side != null) {
    const holder = seatHeldBy(found.members, { side, mi }, found.target.member_id)
    if (holder) return c.json({ error: 'seat_taken', heldBy: { name: holder.name, lastSeenAt: holder.last_seen_at } }, 409)
  }
  const now = Date.now()
  await updateMemberSeat({
    partyId: c.var.member.party_id,
    memberId: found.target.member_id,
    side,
    mi: side == null ? null : mi,
    name: parsed.data.name ?? found.target.name,
  })
  dropMember(c.var.member.party_id, found.target.member_id)
  const seq = await bumpSeq(c.var.member.party_id, new Date(now).toISOString(), partyExpiry(now))
  dropState(c.var.member.party_id)
  return c.json({ seq })
})

// Kick: the token dies now (its cache entry goes with it), the seat is free.
partyRoutes.post('/:id/members/:mid/kick', requireHost, async (c) => {
  const found = await memberOrNull(c.var.member.party_id, c.req.param('mid'))
  if (!found?.target) return c.json({ error: 'not_found' }, 404)
  if (found.target.member_id === c.var.member.member_id) return c.json({ error: 'not_self' }, 422)
  const now = Date.now()
  await revokeMember(c.var.member.party_id, found.target.member_id, new Date(now).toISOString())
  dropMember(c.var.member.party_id, found.target.member_id)
  const seq = await bumpSeq(c.var.member.party_id, new Date(now).toISOString(), partyExpiry(now))
  dropState(c.var.member.party_id)
  return c.json({ seq })
})

// Hand the host role to another member. The account link (reclaim) stays with the creator.
const transferSchema = z.object({ memberId: memberIdSchema })
partyRoutes.post('/:id/host', requireHost, async (c) => {
  const raw = await readJson(c)
  if (raw === undefined) return c.json({ error: 'invalid_json' }, 400)
  const parsed = transferSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid_member' }, 422)
  const found = await memberOrNull(c.var.member.party_id, parsed.data.memberId)
  if (!found?.target) return c.json({ error: 'not_found' }, 404)
  if (found.target.member_id === c.var.member.member_id) return c.json({ error: 'not_self' }, 422)
  const now = Date.now()
  await setMemberRole(c.var.member.party_id, c.var.member.member_id, 'player')
  await setMemberRole(c.var.member.party_id, found.target.member_id, 'host')
  dropMember(c.var.member.party_id, c.var.member.member_id)
  dropMember(c.var.member.party_id, found.target.member_id)
  const seq = await bumpSeq(c.var.member.party_id, new Date(now).toISOString(), partyExpiry(now))
  dropState(c.var.member.party_id)
  return c.json({ seq })
})

// The party is over: every row goes, every token with it. The game itself lives on in each
// phone's own tracker.
partyRoutes.delete('/:id', requireHost, async (c) => {
  const partyId = c.var.member.party_id
  const members = await listMembers(partyId)
  await deleteParty(partyId)
  dropParty(partyId, members)
  return c.body(null, 204)
})
