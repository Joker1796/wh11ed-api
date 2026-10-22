import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { freshSchema, closeDb } from './setup.js'
import {
  createParty, getParty, getPartyByInvite, getPartiesByCode, getMemberByToken, listMembers, listState,
  writeSlices, bumpSeq, insertMember, revokeMember, swapMemberSides, rotateMemberToken, setInvite, deleteParty,
} from '../../src/db/parties.repo.js'
import { SLICE_NAMES, type SliceName } from '../../src/domain/party.js'
import { sweepExpired } from '../../src/db/sweep.js'

// The shared live game against real Postgres. The routes' own tests run on an in-memory repo, so
// this file is the only place the transactions are tested — above all the race the whole design
// is for: two phones writing the same slice from the same version in the same instant.

beforeEach(freshSchema)
after(closeDb)

const NOW = '2026-10-11T12:00:00.000Z'
const LATER = () => new Date(Date.now() + 3_600_000)
const slices = Object.fromEntries(SLICE_NAMES.map((n) => [n, `{"${n}":0}`])) as Record<SliceName, string>

async function party(id = 'p1') {
  await createParty({
    partyId: id, hostUserId: 'yandex:1', gameId: 'g1', inviteToken: `inv-${id}`, code: '123456',
    codeExpiresAt: NOW, slices, nowIso: NOW, expiresAt: LATER(),
    host: { memberId: 'host', tokenHash: `h-${id}`, role: 'host', side: 0, mi: 0, name: 'Алиса' },
  })
}

describe('a shared game', () => {
  it('is created whole: party, host seat, all five slices at version 1', async () => {
    await party()
    const p = await getParty('p1')
    assert.equal(p?.seq, 1)
    assert.equal(p?.status, 'open')
    assert.equal((await getPartyByInvite('inv-p1'))?.party_id, 'p1')
    assert.equal((await getPartiesByCode('123456')).length, 1)
    assert.equal((await getMemberByToken('h-p1'))?.name, 'Алиса')
    const state = await listState('p1')
    assert.equal(state.length, 5)
    assert.ok(state.every((s) => s.version === 1 && s.seq === 1))
  })

  it('a write bumps the slice and the party seq; a write from an old version is refused', async () => {
    await party()
    const ok = await writeSlices({ partyId: 'p1', writes: [{ name: 'side0', version: 1, json: '{"vp":3}' }], status: 'open', nowIso: NOW, expiresAt: LATER() })
    assert.deepEqual(ok, { ok: true, seq: 2, versions: { side0: 2 } })
    const stale = await writeSlices({ partyId: 'p1', writes: [{ name: 'side0', version: 1, json: '{"vp":9}' }], status: 'open', nowIso: NOW, expiresAt: LATER() })
    assert.deepEqual(stale, { ok: false, stale: ['side0'] })
    const side0 = (await listState('p1')).find((s) => s.slice === 'side0')
    assert.deepEqual([side0?.version, side0?.data], [2, '{"vp":3}'])
  })

  it('two phones writing the same slice from the same version at once: one lands, one is told it is stale', async () => {
    await party()
    const write = (vp: number) =>
      writeSlices({ partyId: 'p1', writes: [{ name: 'shared', version: 1, json: `{"vp":${vp}}` }], status: 'open', nowIso: NOW, expiresAt: LATER() })
    const results = await Promise.all([write(1), write(2), write(3), write(4)])
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal(results.filter((r) => !r.ok).length, 3)
    assert.equal((await getParty('p1'))?.seq, 2, 'the seq moved exactly once')
  })

  it('concurrent admin bumps never lose a step', async () => {
    await party()
    await Promise.all(Array.from({ length: 6 }, () => bumpSeq('p1', NOW, LATER())))
    assert.equal((await getParty('p1'))?.seq, 7)
  })

  it('seats: join, swap sides, revoke, reclaim', async () => {
    await party()
    await insertMember('p1', { memberId: 'm2', tokenHash: 't2', role: 'player', side: 1, mi: 0, name: 'Боб' }, NOW, LATER())
    await swapMemberSides('p1')
    const sides = Object.fromEntries((await listMembers('p1')).map((m) => [m.member_id, m.side]))
    assert.deepEqual(sides, { host: 1, m2: 0 })
    await revokeMember('p1', 'm2', NOW)
    // The hash stays on purpose (432bad6): the phone that presents it is told 'revoked'.
    assert.equal((await getMemberByToken('t2'))?.revoked_at, NOW, 'a revoked token resolves to its revoked seat')
    const m2 = (await listMembers('p1')).find((m) => m.member_id === 'm2')
    assert.deepEqual([m2?.side, m2?.revoked_at], [null, NOW])
    await rotateMemberToken('p1', 'm2', 't2b')
    assert.equal((await getMemberByToken('t2b'))?.revoked_at, null)
  })

  it('a new code keeps the link unless a new link is asked for', async () => {
    await party()
    await setInvite({ partyId: 'p1', inviteToken: null, code: '654321', codeExpiresAt: NOW, nowIso: NOW })
    assert.deepEqual([(await getParty('p1'))?.invite_token, (await getParty('p1'))?.code], ['inv-p1', '654321'])
    await setInvite({ partyId: 'p1', inviteToken: 'inv-new', code: '111111', codeExpiresAt: NOW, nowIso: NOW })
    assert.equal((await getParty('p1'))?.invite_token, 'inv-new')
  })

  it('ending the game removes every row; an expired one is swept', async () => {
    await party('p1')
    await party('p2')
    await deleteParty('p1')
    assert.equal(await getParty('p1'), null)
    assert.equal((await listState('p1')).length, 0)
    await writeSlices({ partyId: 'p2', writes: [], status: 'open', nowIso: NOW, expiresAt: new Date(Date.now() - 1000) })
    const swept = await sweepExpired()
    assert.equal(swept.parties, 1)
    assert.equal(await getParty('p2'), null)
  })
})
