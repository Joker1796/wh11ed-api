import { before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { staleWrites, type SliceName, type SliceWrite, type PartyStatus } from '../src/domain/party.js'

// The party routes against an IN-MEMORY repo: the protocol end to end — create, join, seat, the
// sync handshake (204 / 200 / 409 / 423 / 403), kick and revocation — without a YDB. The repo's
// YQL is the one thing this cannot cover; its semantics (versions per slice, seq per write,
// atomic batches) are re-stated here in a few lines so the routes are tested against the
// contract the real repo implements.

process.env.JWT_SIGNING_KEY ||= 'test-signing-key-test-signing-key'
process.env.API_BASE_URL ||= 'http://localhost:8787'
process.env.APP_AFTER_LOGIN_URL ||= 'http://localhost:5173/tracker/auth-callback'

interface Party {
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
interface Member {
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
interface State {
  slice: SliceName
  version: number
  seq: number
  data: string
}

const parties = new Map<string, Party>()
const members = new Map<string, Member[]>()
const states = new Map<string, State[]>()

const fakeRepo = {
  async createParty(input: {
    partyId: string
    hostUserId: string
    gameId: string
    inviteToken: string
    code: string
    codeExpiresAt: string
    host: { memberId: string; tokenHash: string; role: 'host' | 'player'; side: number | null; mi: number | null; name: string }
    slices: Record<SliceName, string>
    nowIso: string
  }) {
    parties.set(input.partyId, {
      party_id: input.partyId,
      host_user_id: input.hostUserId,
      game_id: input.gameId,
      invite_token: input.inviteToken,
      code: input.code,
      code_expires_at: input.codeExpiresAt,
      seq: 1,
      status: 'open',
      created_at: input.nowIso,
      updated_at: input.nowIso,
    })
    members.set(input.partyId, [])
    await fakeRepo.insertMember(input.partyId, input.host, input.nowIso)
    states.set(
      input.partyId,
      (Object.entries(input.slices) as [SliceName, string][]).map(([slice, data]) => ({ slice, version: 1, seq: 1, data })),
    )
  },
  async insertMember(partyId: string, m: { memberId: string; tokenHash: string; role: 'host' | 'player'; side: number | null; mi: number | null; name: string }, nowIso: string) {
    members.get(partyId)!.push({
      party_id: partyId,
      member_id: m.memberId,
      token_hash: m.tokenHash,
      role: m.role,
      side: m.side,
      mi: m.mi,
      name: m.name,
      created_at: nowIso,
      last_seen_at: nowIso,
      revoked_at: null,
    })
  },
  async getParty(id: string) {
    return parties.get(id) ?? null
  },
  async getPartyByInvite(tok: string) {
    return [...parties.values()].find((p) => p.invite_token === tok) ?? null
  },
  async getPartiesByCode(code: string) {
    return [...parties.values()].filter((p) => p.code === code)
  },
  async getMemberByToken(hash: string) {
    for (const ms of members.values()) {
      const m = ms.find((x) => x.token_hash === hash)
      if (m) return m
    }
    return null
  },
  async listMembers(partyId: string) {
    return members.get(partyId) ?? []
  },
  async listState(partyId: string) {
    return states.get(partyId) ?? []
  },
  async writeSlices(input: { partyId: string; writes: SliceWrite[]; status: PartyStatus; nowIso: string }) {
    const rows = states.get(input.partyId)!
    const stale = staleWrites(input.writes, rows.map((r) => ({ name: r.slice, version: r.version, seq: r.seq })))
    if (stale.length) return { ok: false as const, stale }
    const party = parties.get(input.partyId)!
    const seq = party.seq + 1
    const versions: Partial<Record<SliceName, number>> = {}
    for (const w of input.writes) {
      const row = rows.find((r) => r.slice === w.name)!
      row.version = w.version + 1
      row.seq = seq
      row.data = w.json
      versions[w.name] = row.version
    }
    party.seq = seq
    party.status = input.status
    return { ok: true as const, seq, versions }
  },
  async bumpSeq(partyId: string) {
    const p = parties.get(partyId)!
    p.seq += 1
    return p.seq
  },
  async setInvite(input: { partyId: string; inviteToken: string | null; code: string; codeExpiresAt: string }) {
    const p = parties.get(input.partyId)!
    if (input.inviteToken) p.invite_token = input.inviteToken
    p.code = input.code
    p.code_expires_at = input.codeExpiresAt
  },
  async updateMemberSeat(input: { partyId: string; memberId: string; side: number | null; mi: number | null; name: string }) {
    const m = members.get(input.partyId)!.find((x) => x.member_id === input.memberId)!
    Object.assign(m, { side: input.side, mi: input.mi, name: input.name })
  },
  async setMemberRole(partyId: string, memberId: string, role: 'host' | 'player') {
    members.get(partyId)!.find((x) => x.member_id === memberId)!.role = role
  },
  async revokeMember(partyId: string, memberId: string, nowIso: string) {
    const m = members.get(partyId)!.find((x) => x.member_id === memberId)!
    Object.assign(m, { revoked_at: nowIso, token_hash: '', side: null, mi: null })
  },
  async rotateMemberToken(partyId: string, memberId: string, tokenHash: string) {
    const m = members.get(partyId)!.find((x) => x.member_id === memberId)!
    Object.assign(m, { token_hash: tokenHash, revoked_at: null })
  },
  async touchMember(partyId: string, memberId: string, nowIso: string) {
    const m = members.get(partyId)!.find((x) => x.member_id === memberId)
    if (m) m.last_seen_at = nowIso
  },
  async deleteParty(partyId: string) {
    parties.delete(partyId)
    members.delete(partyId)
    states.delete(partyId)
  },
}

mock.module(new URL('../src/db/parties.repo.ts', import.meta.url).href, { namedExports: fakeRepo })

let app: Hono
let hostJwt: string
before(async () => {
  const { partyRoutes } = await import('../src/routes/party.js')
  const { issueAccessToken } = await import('../src/auth/jwt.js')
  app = new Hono().route('/party', partyRoutes)
  hostJwt = (await issueAccessToken('user-host')).token
})

const json = (body: unknown, token?: string, method = 'POST') =>
  ({
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }) as RequestInit

const game = () => ({
  shared: { id: 'g1', phase: 'playing', currentRound: 1, settings: { gameType: 'singles' } },
  side0: { name: 'Host', cp: 0 },
  side1: { name: 'Guest', cp: 0 },
  roster0: { rosterId: null, roster: null },
  roster1: { rosterId: null, roster: null },
})

async function createParty() {
  const res = await app.request('/party', json({ gameId: 'g1', slices: game(), seat: { side: 0, mi: null }, name: 'Host' }, hostJwt))
  assert.equal(res.status, 201)
  return (await res.json()) as {
    partyId: string
    memberToken: string
    memberId: string
    seq: number
    versions: Record<SliceName, number>
    invite: { token: string; code: string }
  }
}

// Each join from its own address: the route fences joins per IP (ten a minute), and one
// address for the whole file would hit that fence by the third test.
let ipN = 0
async function join(body: unknown) {
  const init = json(body)
  init.headers = { ...(init.headers as Record<string, string>), 'X-Forwarded-For': `10.0.0.${++ipN}` }
  const res = await app.request('/party/join', init)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('create + join', () => {
  it('needs an account to create, and hands back the invite', async () => {
    const anon = await app.request('/party', json({ gameId: 'g1', slices: game(), seat: { side: 0 } }))
    assert.equal(anon.status, 401)
    const p = await createParty()
    assert.match(p.invite.code, /^\d{6}$/)
    assert.deepEqual(p.versions, { shared: 1, side0: 1, side1: 1, roster0: 1, roster1: 1 })
  })

  it('joins by code or by link and gets the whole game plus the seats', async () => {
    const p = await createParty()
    const byCode = await join({ code: p.invite.code })
    assert.equal(byCode.status, 201)
    assert.equal(byCode.body.partyId, p.partyId)
    assert.equal((byCode.body.slices as Record<string, { data: { name: string } }>).side1!.data.name, 'Guest')
    assert.equal((byCode.body.you as { side: number | null }).side, null)
    const seats = byCode.body.members as { host: boolean; side: number | null; you: boolean }[]
    assert.equal(seats.filter((m) => m.host).length, 1)
    assert.equal(seats.find((m) => m.you)?.side, null)
    const byLink = await join({ invite: p.invite.token })
    assert.equal(byLink.status, 201)
  })

  it('a wrong code or link is 404, garbage is 422', async () => {
    await createParty()
    assert.equal((await join({ invite: 'x'.repeat(22) })).status, 404)
    assert.equal((await join({ code: '12' })).status, 422)
  })
})

describe('seats', () => {
  it('a guest takes a free seat, is refused a held one, and always retakes its own', async () => {
    const p = await createParty()
    const g = (await join({ code: p.invite.code })).body as { memberToken: string; partyId: string }
    const taken = await app.request(`/party/${p.partyId}/seat`, json({ side: 0, mi: null, name: 'Me' }, g.memberToken))
    assert.equal(taken.status, 409)
    assert.equal(((await taken.json()) as { heldBy: { name: string } }).heldBy.name, 'Host')
    const ok = await app.request(`/party/${p.partyId}/seat`, json({ side: 1, mi: null, name: 'Me' }, g.memberToken))
    assert.equal(ok.status, 200)
    assert.deepEqual(((await ok.json()) as { you: unknown }).you, { memberId: (await fakeRepo.listMembers(p.partyId))[1]!.member_id, side: 1, mi: null, host: false })
    const again = await app.request(`/party/${p.partyId}/seat`, json({ side: 1, mi: null, name: 'Me' }, g.memberToken))
    assert.equal(again.status, 200)
  })
})

describe('sync', () => {
  async function table() {
    const p = await createParty()
    const g = (await join({ code: p.invite.code })).body as { memberToken: string; memberId: string }
    await app.request(`/party/${p.partyId}/seat`, json({ side: 1, mi: null, name: 'Guest' }, g.memberToken))
    // The seat bumped the seq: the host's next poll learns of it.
    return { p, g, sync: (token: string, body: unknown) => app.request(`/party/${p.partyId}/sync`, json(body, token)) }
  }

  it('204 when nothing moved, 200 with the others\' slices when something did', async () => {
    const { p, g, sync } = await table()
    const seated = await sync(p.memberToken, { since: 1 })
    assert.equal(seated.status, 200)
    const seq = ((await seated.json()) as { seq: number }).seq
    assert.equal((await sync(p.memberToken, { since: seq })).status, 204)

    const w = await sync(g.memberToken, { since: seq, slices: { side1: { version: 1, data: { name: 'Guest', cp: 3 } } } })
    assert.equal(w.status, 200)
    const wb = (await w.json()) as { seq: number; written: Record<string, number>; slices: Record<string, unknown> }
    assert.deepEqual(wb.written, { side1: 2 })
    assert.deepEqual(wb.slices, {}) // its own write is not echoed
    assert.equal(wb.seq, seq + 1)

    const r = await sync(p.memberToken, { since: seq })
    assert.equal(r.status, 200)
    const rb = (await r.json()) as { seq: number; slices: Record<string, { version: number; data: { cp: number } }> }
    assert.deepEqual(Object.keys(rb.slices), ['side1'])
    assert.equal(rb.slices.side1!.version, 2)
    assert.equal(rb.slices.side1!.data.cp, 3)
    assert.equal((await sync(p.memberToken, { since: rb.seq })).status, 204)
  })

  it('403 for a slice the member does not own; the host may write any', async () => {
    const { p, g, sync } = await table()
    const bad = await sync(g.memberToken, { since: 0, slices: { side0: { version: 1, data: {} } } })
    assert.equal(bad.status, 403)
    assert.deepEqual(((await bad.json()) as { slices: string[] }).slices, ['side0'])
    const ok = await sync(p.memberToken, { since: 0, slices: { side1: { version: 1, data: { cp: 9 } } } })
    assert.equal(ok.status, 200)
  })

  it('409 on a stale version returns the current state, and nothing of the batch lands', async () => {
    const { p, g, sync } = await table()
    await sync(g.memberToken, { since: 0, slices: { side1: { version: 1, data: { cp: 1 } } } })
    // The host based a batch on side1@1 and shared@1; side1 moved to 2 → the whole batch is refused.
    const res = await sync(p.memberToken, {
      since: 0,
      slices: { side1: { version: 1, data: { cp: 100 } }, shared: { version: 1, data: { phase: 'playing', currentRound: 2 } } },
    })
    assert.equal(res.status, 409)
    const body = (await res.json()) as { stale: string[]; slices: Record<string, { version: number; data: { cp?: number; currentRound?: number } }> }
    assert.deepEqual(body.stale, ['side1'])
    assert.equal(body.slices.side1!.data.cp, 1)
    assert.equal(body.slices.shared!.version, 1) // shared did not land
    assert.equal(body.slices.shared!.data.currentRound, 1)
  })

  it('a finished party is read-only for a guest, and the host reopens it', async () => {
    const { p, g, sync } = await table()
    const fin = await sync(g.memberToken, { since: 0, slices: { shared: { version: 1, data: { phase: 'finished', currentRound: 5 } } } })
    assert.equal(fin.status, 200)
    assert.equal(((await fin.json()) as { status: string }).status, 'finished')
    const ro = await sync(g.memberToken, { since: 0, slices: { side1: { version: 1, data: { cp: 4 } } } })
    assert.equal(ro.status, 423)
    const guestReopen = await sync(g.memberToken, { since: 0, slices: { shared: { version: 2, data: { phase: 'playing' } } } })
    assert.equal(guestReopen.status, 423)
    const hostReopen = await sync(p.memberToken, { since: 0, slices: { shared: { version: 2, data: { phase: 'playing' } } } })
    assert.equal(hostReopen.status, 200)
    assert.equal(((await hostReopen.json()) as { status: string }).status, 'open')
    assert.equal((await sync(g.memberToken, { since: 0, slices: { side1: { version: 1, data: { cp: 4 } } } })).status, 200)
  })

  it('the response carries the member\'s own standing, so a moved seat reaches the phone', async () => {
    const { p, g, sync } = await table()
    const guest = (await fakeRepo.listMembers(p.partyId))[1]!
    const moved = await app.request(`/party/${p.partyId}/members/${guest.member_id}/seat`, json({ side: null }, p.memberToken))
    assert.equal(moved.status, 200)
    const res = await sync(g.memberToken, { since: 0 })
    assert.equal(res.status, 200)
    assert.deepEqual(((await res.json()) as { you: { side: number | null } }).you.side, null)
    // …and, unseated, the guest writes nothing.
    assert.equal((await sync(g.memberToken, { since: 0, slices: { side1: { version: 1, data: {} } } })).status, 403)
  })
})

describe('administration', () => {
  it('a kicked member is 401 on its next call and its seat is free', async () => {
    const p = await createParty()
    const g = (await join({ code: p.invite.code })).body as { memberToken: string }
    await app.request(`/party/${p.partyId}/seat`, json({ side: 1, mi: null, name: 'Guest' }, g.memberToken))
    const guest = (await fakeRepo.listMembers(p.partyId))[1]!
    const notHost = await app.request(`/party/${p.partyId}/members/${guest.member_id}/kick`, json({}, g.memberToken))
    assert.equal(notHost.status, 403)
    const kicked = await app.request(`/party/${p.partyId}/members/${guest.member_id}/kick`, json({}, p.memberToken))
    assert.equal(kicked.status, 200)
    const after = await app.request(`/party/${p.partyId}/sync`, json({ since: 0 }, g.memberToken))
    assert.equal(after.status, 401)
    const g2 = (await join({ code: p.invite.code })).body as { memberToken: string }
    const seat = await app.request(`/party/${p.partyId}/seat`, json({ side: 1, mi: null, name: 'Other' }, g2.memberToken))
    assert.equal(seat.status, 200)
  })

  it('a guest leaves on its own; the host cannot', async () => {
    const p = await createParty()
    const g = (await join({ code: p.invite.code })).body as { memberToken: string }
    assert.equal((await app.request(`/party/${p.partyId}/leave`, json({}, p.memberToken))).status, 422)
    assert.equal((await app.request(`/party/${p.partyId}/leave`, json({}, g.memberToken))).status, 204)
    assert.equal((await app.request(`/party/${p.partyId}/sync`, json({ since: 0 }, g.memberToken))).status, 401)
    const left = (await fakeRepo.listMembers(p.partyId)).filter((m) => !m.revoked_at)
    assert.equal(left.length, 1)
  })

  it('the host hands over the role; the old host is then a player', async () => {
    const p = await createParty()
    const g = (await join({ code: p.invite.code })).body as { memberToken: string; memberId: string }
    const res = await app.request(`/party/${p.partyId}/host`, json({ memberId: g.memberId }, p.memberToken))
    assert.equal(res.status, 200)
    const inv = await app.request(`/party/${p.partyId}/invite`, { headers: { Authorization: `Bearer ${p.memberToken}` } })
    assert.equal(inv.status, 403)
    const inv2 = await app.request(`/party/${p.partyId}/invite`, { headers: { Authorization: `Bearer ${g.memberToken}` } })
    assert.equal(inv2.status, 200)
  })

  it('a fresh invite rotates the code; the link only on request', async () => {
    const p = await createParty()
    const r1 = await app.request(`/party/${p.partyId}/invite`, json({}, p.memberToken))
    const b1 = (await r1.json()) as { token: string; code: string }
    assert.equal(b1.token, p.invite.token)
    assert.notEqual(b1.code, p.invite.code)
    const r2 = await app.request(`/party/${p.partyId}/invite`, json({ link: true }, p.memberToken))
    const b2 = (await r2.json()) as { token: string }
    assert.notEqual(b2.token, p.invite.token)
    assert.equal((await join({ invite: p.invite.token })).status, 404)
    assert.equal((await join({ invite: b2.token })).status, 201)
  })

  it('the account that created the party reclaims the host seat with a new token', async () => {
    const p = await createParty()
    const other = (await (await import('../src/auth/jwt.js')).issueAccessToken('someone-else')).token
    assert.equal((await app.request(`/party/${p.partyId}/reclaim`, json({}, other))).status, 404)
    const res = await app.request(`/party/${p.partyId}/reclaim`, json({}, hostJwt))
    assert.equal(res.status, 200)
    const body = (await res.json()) as { memberToken: string; you: { host: boolean; side: number } }
    assert.equal(body.you.host, true)
    assert.equal(body.you.side, 0)
    assert.equal((await app.request(`/party/${p.partyId}/sync`, json({ since: 0 }, p.memberToken))).status, 401)
    assert.notEqual((await app.request(`/party/${p.partyId}/sync`, json({ since: 0 }, body.memberToken))).status, 401)
  })

  it('deleting the party kills every token', async () => {
    const p = await createParty()
    const g = (await join({ code: p.invite.code })).body as { memberToken: string }
    assert.equal((await app.request(`/party/${p.partyId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${g.memberToken}` } })).status, 403)
    assert.equal((await app.request(`/party/${p.partyId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${p.memberToken}` } })).status, 204)
    assert.equal((await app.request(`/party/${p.partyId}/sync`, json({ since: 0 }, g.memberToken))).status, 401)
  })
})
