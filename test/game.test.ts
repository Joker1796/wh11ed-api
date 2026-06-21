import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGame, extractMetadata, GamePayloadError } from '../src/domain/game.js'

const validGame = {
  id: 'g1718921604000',
  createdAt: '2026-06-20T12:00:00.000Z',
  finishedAt: '2026-06-20T13:30:00.000Z',
  phase: 'finished',
  players: [
    { name: 'Alice', factionSlug: 'necrons', cp: 3 },
    { name: 'Bob', factionSlug: 'astra-militarum', cp: 1 },
  ],
  result: { totals: [85, 72] },
  extraClientField: { whatever: true },
}

test('parseGame accepts a valid game and preserves unknown fields', () => {
  const { game } = parseGame(validGame)
  assert.equal(game.id, 'g1718921604000')
  assert.equal((game as any).extraClientField.whatever, true)
})

test('extractMetadata derives summary + players', () => {
  const { game } = parseGame(validGame)
  const meta = extractMetadata(game)
  assert.equal(meta.gameId, 'g1718921604000')
  assert.equal(meta.resultSummary, '85-72')
  assert.deepEqual(meta.players, [
    { name: 'Alice', factionSlug: 'necrons' },
    { name: 'Bob', factionSlug: 'astra-militarum' },
  ])
})

test('parseGame rejects a missing id', () => {
  assert.throws(() => parseGame({ players: [] }))
})

test('parseGame enforces the byte cap', () => {
  const huge = { id: 'g1', blobblob: 'x'.repeat(70_000) }
  assert.throws(() => parseGame(huge), GamePayloadError)
})
