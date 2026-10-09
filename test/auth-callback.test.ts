import { test } from 'node:test'
import assert from 'node:assert/strict'

// A login that fails goes back to the site with its reason, never to a page of JSON: a player
// whose login came back in another browser saw `{"error":"missing_state_cookie"}`, and Yandex's
// refusals reached nobody (2026-10-09). None of these paths touches the database.
process.env.JWT_SIGNING_KEY ||= 'test-signing-key-test-signing-key'
process.env.API_BASE_URL ||= 'http://localhost:8787'
process.env.APP_AFTER_LOGIN_URL ||= 'http://localhost:5173/tracker/auth-callback'
process.env.ALLOWED_ORIGINS ||= 'http://localhost:5173'

const after = () => process.env.APP_AFTER_LOGIN_URL

test('Yandex refusing the login: back to the site with its code', async () => {
  const { app } = await import('../src/app.js')
  const res = await app.request('/auth/yandex/callback?error=unauthorized_client')
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), `${after()}?error=unauthorized_client`)
})

test('our own failures redirect too: no state cookie, no code', async () => {
  const { app } = await import('../src/app.js')
  const noCookie = await app.request('/auth/yandex/callback?code=abc&state=xyz')
  assert.equal(noCookie.status, 302)
  assert.equal(noCookie.headers.get('location'), `${after()}?error=missing_state_cookie`)
  const noCode = await app.request('/auth/yandex/callback')
  assert.equal(noCode.headers.get('location'), `${after()}?error=missing_code_or_state`)
})

test('the reason is escaped into the query', async () => {
  const { app } = await import('../src/app.js')
  const res = await app.request('/auth/yandex/callback?error=a%26b%3Dc')
  assert.equal(res.headers.get('location'), `${after()}?error=a%26b%3Dc`)
})
