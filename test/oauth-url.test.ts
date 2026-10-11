import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.YANDEX_CLIENT_ID ||= 'test-client'
process.env.YANDEX_CLIENT_SECRET ||= 'test-secret'
process.env.API_BASE_URL ||= 'http://localhost:8787'

const { buildAuthUrl, createPkceState } = await import('../src/auth/oauth.js')

// Misha, 2026-10-10: with several Yandex accounts, the login went straight in with the browser's
// one. `force_confirm=yes` makes Yandex ask, its account switcher on the page.
test('the Yandex authorize URL asks which account every time', () => {
  const url = new URL(buildAuthUrl('yandex', createPkceState()))
  assert.equal(url.origin + url.pathname, 'https://oauth.yandex.ru/authorize')
  assert.equal(url.searchParams.get('force_confirm'), 'yes')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
})
