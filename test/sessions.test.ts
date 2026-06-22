import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { evaluateRefresh, hashesEqual, hashToken } from '../src/auth/refresh-logic.js'

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')
const future = new Date(Date.now() + 60_000)
const past = new Date(Date.now() - 60_000)

test('evaluateRefresh: valid, unexpired token → ok', () => {
  const row = { refresh_hash: hash('secret-token'), expires_at: future }
  assert.equal(evaluateRefresh(row, 'secret-token', Date.now()), 'ok')
})

test('evaluateRefresh: replayed/rotated-away token → mismatch (session should be burned)', () => {
  // The stored hash is for the current secret; an old/stolen token hashes differently.
  const row = { refresh_hash: hash('current-secret'), expires_at: future }
  assert.equal(evaluateRefresh(row, 'old-stolen-token', Date.now()), 'mismatch')
})

test('evaluateRefresh: expired session → expired (even with a matching token)', () => {
  const row = { refresh_hash: hash('secret-token'), expires_at: past }
  assert.equal(evaluateRefresh(row, 'secret-token', Date.now()), 'expired')
})

test('evaluateRefresh: missing expiry → expired', () => {
  const row = { refresh_hash: hash('secret-token'), expires_at: null }
  assert.equal(evaluateRefresh(row, 'secret-token', Date.now()), 'expired')
})

test('hashToken + hashesEqual: matching hashes compare equal, different ones do not', () => {
  assert.ok(hashesEqual(hashToken('a'), hashToken('a')))
  assert.ok(!hashesEqual(hashToken('a'), hashToken('b')))
  // Different-length inputs must not throw (timingSafeEqual requires equal length).
  assert.ok(!hashesEqual('short', hashToken('a')))
})
