import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchRetrying } from '../src/auth/oauth.js'

// Yandex OAuth refuses a share of requests with 429 while busy (2026-10-11: about one in three).
// A refusal is retried; an answer — success or a real 4xx — is returned as it is.
const real = globalThis.fetch
let calls = 0
function answer(...statuses: number[]) {
  calls = 0
  globalThis.fetch = (async () => new Response('{}', { status: statuses[Math.min(calls++, statuses.length - 1)] })) as typeof fetch
}
beforeEach(() => { calls = 0 })
afterEach(() => { globalThis.fetch = real })

test('a 429 and a 503 are retried until the answer comes', async () => {
  answer(429, 503, 200)
  const res = await fetchRetrying('https://x', {}, [0, 0, 0])
  assert.equal(res.status, 200)
  assert.equal(calls, 3)
})

test('a real refusal is returned at once, not retried', async () => {
  answer(400)
  const res = await fetchRetrying('https://x', {}, [0, 0, 0])
  assert.equal(res.status, 400)
  assert.equal(calls, 1)
})

test('gives up after the last delay and hands back the last refusal', async () => {
  answer(429)
  const res = await fetchRetrying('https://x', {}, [0, 0])
  assert.equal(res.status, 429)
  assert.equal(calls, 3)
})

test('a network error is retried too, and thrown when it persists', async () => {
  let n = 0
  globalThis.fetch = (async () => { n++; if (n < 2) throw new TypeError('fetch failed'); return new Response('{}') }) as typeof fetch
  assert.equal((await fetchRetrying('https://x', {}, [0, 0])).status, 200)
  globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  await assert.rejects(fetchRetrying('https://x', {}, [0]))
})
