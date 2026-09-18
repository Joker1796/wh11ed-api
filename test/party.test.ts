import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  canWriteSlice,
  codeExpiry,
  codeLive,
  inviteTokenSchema,
  joinCodeSchema,
  memberTokenSchema,
  newInviteToken,
  newJoinCode,
  newMemberToken,
  newPartyId,
  parseSliceWrites,
  partyExpiry,
  partyIdSchema,
  heldSides,
  seatHeldBy,
  sideOfSlice,
  SliceTooLargeError,
  staleWrites,
  statusAfterWrite,
  syncBodySchema,
  UnknownSliceError,
  writeAllowedWhenFinished,
} from '../src/domain/party.js'
import { config } from '../src/config.js'

describe('party tokens', () => {
  it('each kind passes its own schema and no other', () => {
    for (let i = 0; i < 10; i++) {
      assert.equal(partyIdSchema.safeParse(newPartyId()).success, true)
      assert.equal(memberTokenSchema.safeParse(newMemberToken()).success, true)
      assert.equal(inviteTokenSchema.safeParse(newInviteToken()).success, true)
      assert.equal(joinCodeSchema.safeParse(newJoinCode()).success, true)
      assert.equal(memberTokenSchema.safeParse(newInviteToken()).success, false)
      assert.equal(inviteTokenSchema.safeParse(newMemberToken()).success, false)
    }
  })
  it('a member token never looks like a JWT', () => {
    assert.doesNotMatch(newMemberToken(), /\./)
  })
  it('a join code is six digits, zero-padded', () => {
    assert.match(newJoinCode(), /^\d{6}$/)
  })
})

describe('slices and rights', () => {
  it('sideOfSlice', () => {
    assert.deepEqual(['shared', 'side0', 'side1', 'roster0', 'roster1'].map((n) => sideOfSlice(n as never)), [null, 0, 1, 0, 1])
  })
  it('a seated member writes its side and the shared slice, nothing else', () => {
    const m = { host: false, side: 1 as const }
    assert.equal(canWriteSlice(m, 'side1'), true)
    assert.equal(canWriteSlice(m, 'roster1'), true)
    assert.equal(canWriteSlice(m, 'shared'), true)
    assert.equal(canWriteSlice(m, 'side0'), false)
    assert.equal(canWriteSlice(m, 'roster0'), false)
  })
  it('an unseated member writes nothing; the host writes everything', () => {
    for (const n of ['shared', 'side0', 'side1', 'roster0', 'roster1'] as const) {
      assert.equal(canWriteSlice({ host: false, side: null }, n), false)
      assert.equal(canWriteSlice({ host: true, side: null }, n), true)
    }
  })
})

describe('sync body', () => {
  it('parses writes, refusing unknown names and oversized blobs', () => {
    const body = syncBodySchema.parse({ since: 3, slices: { side0: { version: 2, data: { cp: 1 } } } })
    const writes = parseSliceWrites(body.slices)
    assert.deepEqual(writes, [{ name: 'side0', version: 2, json: '{"cp":1}' }])
    assert.throws(() => parseSliceWrites({ players: { version: 1, data: {} } }), UnknownSliceError)
    assert.throws(
      () => parseSliceWrites({ side0: { version: 1, data: { x: 'x'.repeat(config.maxPartySliceBytes) } } }),
      SliceTooLargeError,
    )
  })
  it('since must be a non-negative integer', () => {
    assert.equal(syncBodySchema.safeParse({ since: -1 }).success, false)
    assert.equal(syncBodySchema.safeParse({ since: 1.5 }).success, false)
    assert.equal(syncBodySchema.safeParse({ since: 0 }).success, true)
  })
})

describe('versions', () => {
  const stored = [
    { name: 'shared' as const, version: 4, seq: 9 },
    { name: 'side0' as const, version: 2, seq: 7 },
  ]
  it('a batch lands only when every write is based on the stored version', () => {
    assert.deepEqual(staleWrites([{ name: 'side0', version: 2, json: '{}' }], stored), [])
    assert.deepEqual(
      staleWrites([{ name: 'side0', version: 2, json: '{}' }, { name: 'shared', version: 3, json: '{}' }], stored),
      ['shared'],
    )
  })
  it('a slice the store has never seen counts as version 0', () => {
    assert.deepEqual(staleWrites([{ name: 'roster1', version: 0, json: '{}' }], stored), [])
    assert.deepEqual(staleWrites([{ name: 'roster1', version: 1, json: '{}' }], stored), ['roster1'])
  })
})

describe('finish and reopen', () => {
  const finish = { name: 'shared' as const, version: 1, json: JSON.stringify({ phase: 'finished' }) }
  const play = { name: 'shared' as const, version: 1, json: JSON.stringify({ phase: 'playing' }) }
  const side = { name: 'side0' as const, version: 1, json: '{}' }
  it('the shared slice decides the status; a side write leaves it', () => {
    assert.equal(statusAfterWrite('open', [finish]), 'finished')
    assert.equal(statusAfterWrite('finished', [play]), 'open')
    assert.equal(statusAfterWrite('finished', [side]), 'finished')
    assert.equal(statusAfterWrite('open', [{ ...finish, json: 'not json' }]), 'open')
  })
  it('only the host reopening may write into a finished party', () => {
    assert.equal(writeAllowedWhenFinished({ host: true, side: 0 }, [play, side]), true)
    assert.equal(writeAllowedWhenFinished({ host: true, side: 0 }, [side]), false)
    assert.equal(writeAllowedWhenFinished({ host: false, side: 0 }, [play]), false)
  })
})

describe('expiry', () => {
  it('a party lives the configured days from now, a code the configured minutes', () => {
    const now = Date.UTC(2026, 8, 17)
    assert.equal(partyExpiry(now).getTime() - now, config.partyTtlDays * 86_400_000)
    assert.equal(new Date(codeExpiry(now)).getTime() - now, config.partyCodeTtlMinutes * 60_000)
    assert.equal(codeLive(codeExpiry(now), now), true)
    assert.equal(codeLive(codeExpiry(now), now + config.partyCodeTtlMinutes * 60_000 + 1), false)
    assert.equal(codeLive(null, now), false)
  })
})

describe('seats', () => {
  const members = [
    { member_id: 'h', side: 0, mi: null, revoked_at: null },
    { member_id: 'g', side: 1, mi: null, revoked_at: null },
    { member_id: 'k', side: 1, mi: 0, revoked_at: '2026-09-17T10:00:00Z' },
  ]
  it('a seat is held by a live member other than the asker', () => {
    assert.equal(seatHeldBy(members, { side: 1, mi: null }, 'x')?.member_id, 'g')
    assert.equal(seatHeldBy(members, { side: 1, mi: null }, 'g'), null) // retaking one's own
    assert.equal(seatHeldBy(members, { side: 0, mi: null }, 'g')?.member_id, 'h')
  })
  it('a kicked member holds nothing, and a doubles seat differs by member index', () => {
    assert.equal(seatHeldBy(members, { side: 1, mi: 0 }, 'x'), null)
    assert.equal(seatHeldBy(members, { side: 1, mi: 1 }, 'x'), null)
  })
  it('the held sides are the ones OTHER live members sit on, each once', () => {
    assert.deepEqual(heldSides(members, 'x'), [0, 1])
    assert.deepEqual(heldSides(members, 'g'), [0]) // its own side is not "held" from itself
    assert.deepEqual(heldSides(members, 'h'), [1])
    assert.deepEqual(heldSides([{ member_id: 'k', side: 1, revoked_at: '2026-09-17T10:00:00Z' }], 'x'), [])
  })
})
