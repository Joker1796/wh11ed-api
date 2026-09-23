import { test } from 'node:test'
import assert from 'node:assert/strict'

// The stand's token route is REGISTERED only when DEV_JWT=1 — not guarded inside, not 403'd.
// A route that mints week-long tokens should not exist in a deployment at all, so the test that
// matters is the one asserting its absence: the app is imported here with the flag unset, which
// is every environment but the docker stand.
process.env.JWT_SIGNING_KEY ||= 'test-signing-key-test-signing-key'
process.env.API_BASE_URL ||= 'http://localhost:8787'
process.env.APP_AFTER_LOGIN_URL ||= 'http://localhost:5173/tracker/auth-callback'
delete process.env.DEV_JWT

test('GET /dev/jwt does not exist without DEV_JWT=1', async () => {
  const { app } = await import('../src/app.js')
  const res = await app.request('/dev/jwt')
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: 'not_found' })
})
