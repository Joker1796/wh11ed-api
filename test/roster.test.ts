import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoster, extractMetadata, RosterPayloadError } from '../src/domain/roster.js'

const validRoster = {
  id: '7a1c2f6e-0000-4000-8000-000000000001',
  v: 4,
  name: 'Green Tide',
  faction: 'orks',
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_900_000,
  detachments: ['Bully Boyz'],
  battleSize: 'strike-force',
  units: [{ id: 'boyz', uid: 'u1', size: 1 }],
  summary: { points: 1990, unitCount: 12, issues: 0 },
}

test('parseRoster accepts a valid roster and preserves unknown fields', () => {
  const { roster } = parseRoster(validRoster)
  assert.equal(roster.id, validRoster.id)
  assert.equal((roster as any).v, 4)
  assert.deepEqual((roster as any).detachments, ['Bully Boyz'])
})

test('extractMetadata denormalises the list-card fields', () => {
  const { roster } = parseRoster(validRoster)
  const meta = extractMetadata(roster)
  assert.deepEqual(meta, {
    rosterId: validRoster.id,
    name: 'Green Tide',
    faction: 'orks',
    updatedAt: 1_750_000_900_000,
    points: 1990,
    unitCount: 12,
  })
})

test('extractMetadata tolerates a roster nobody has priced yet', () => {
  const { roster } = parseRoster({ id: 'r1', name: 'Fresh', units: [] })
  const meta = extractMetadata(roster)
  assert.equal(meta.points, 0)
  assert.equal(meta.unitCount, 0)
  assert.equal(meta.faction, null)
})

test('parseRoster rejects a missing id', () => {
  assert.throws(() => parseRoster({ name: 'No id', units: [] }))
})

test('parseRoster rejects a wizard draft — drafts never leave the device', () => {
  assert.throws(() => parseRoster({ ...validRoster, draft: true, draftStep: 2 }))
})

test('parseRoster enforces the byte cap', () => {
  const huge = { id: 'r1', units: [{ note: 'x'.repeat(40_000) }] }
  assert.throws(() => parseRoster(huge), RosterPayloadError)
})
