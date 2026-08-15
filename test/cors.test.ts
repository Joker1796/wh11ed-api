import { test } from 'node:test'
import assert from 'node:assert/strict'
import { corsOrigin } from '../src/config.js'

// ALLOWED_ORIGINS is read lazily per call (see config.ts), so setting it here is enough.
process.env.ALLOWED_ORIGINS = 'https://wh11ed.ru,https://wh-rules.ru'

test('corsOrigin: allow-listed Origin is echoed back', () => {
  assert.equal(corsOrigin('https://wh-rules.ru'), 'https://wh-rules.ru')
})

test('corsOrigin: disallowed Origin gets the canonical origin, never an empty answer', () => {
  // An absent Access-Control-Allow-Origin lets the YC platform layer substitute `*`
  // (+ allow-credentials) — the mismatching canonical origin keeps browsers blocking.
  assert.equal(corsOrigin('https://evil.example'), 'https://wh11ed.ru')
})

test('corsOrigin: no Origin (server-to-server) also resolves to the canonical origin', () => {
  assert.equal(corsOrigin(''), 'https://wh11ed.ru')
})
