import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toSnakeCaseKeys } from '../src/db/rows.js'

// ydb-sdk's query client returns columns as camelCase; the repos read the original snake_case
// names. Regression for the auth bug where `row.expires_at` was undefined (key was `expiresAt`),
// making every freshly-created session look expired → `invalid_session` on first /auth/refresh.
test('toSnakeCaseKeys converts session row keys back to snake_case', () => {
  const camel = {
    sessionId: 's1',
    userId: 'yandex:42',
    refreshHash: 'abc',
    createdAt: '2026-06-22T00:00:00Z',
    expiresAt: new Date('2026-07-22T00:00:00Z'),
  }
  const snake = toSnakeCaseKeys(camel)
  assert.deepEqual(Object.keys(snake).sort(), [
    'created_at',
    'expires_at',
    'refresh_hash',
    'session_id',
    'user_id',
  ])
  assert.equal(snake.session_id, 's1')
  assert.equal(snake.user_id, 'yandex:42')
  // Values pass through untouched (Timestamp stays a Date).
  assert.ok(snake.expires_at instanceof Date)
})

test('toSnakeCaseKeys leaves already-snake / single-word keys intact', () => {
  assert.deepEqual(toSnakeCaseKeys({ blob: 'x', players: '[]' }), { blob: 'x', players: '[]' })
})
