import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { rateLimit } from '../src/lib/rate-limit.js'
import { makeWindowCounter } from '../src/lib/throttle.js'

const appWith = (max: number) => {
  const app = new Hono()
  app.use('*', rateLimit(max, 60_000))
  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.get('/rosters', (c) => c.json({ ok: true }))
  return app
}
const get = (app: Hono, path: string, ip: string) =>
  app.request(path, { headers: { 'X-Forwarded-For': ip } })

test('rateLimit: an address over the ceiling gets 429 with Retry-After', async () => {
  const app = appWith(3)
  for (let i = 0; i < 3; i++) assert.equal((await get(app, '/rosters', '1.1.1.1')).status, 200)
  const res = await get(app, '/rosters', '1.1.1.1')
  assert.equal(res.status, 429)
  assert.deepEqual(await res.json(), { error: 'too_many' })
  assert.equal(res.headers.get('Retry-After'), '60')
})

test('rateLimit: addresses are counted apart', async () => {
  const app = appWith(1)
  assert.equal((await get(app, '/rosters', '1.1.1.1')).status, 200)
  assert.equal((await get(app, '/rosters', '2.2.2.2')).status, 200)
  assert.equal((await get(app, '/rosters', '1.1.1.1')).status, 429)
})

test('rateLimit: /health is never turned away', async () => {
  const app = appWith(1)
  await get(app, '/rosters', '1.1.1.1')
  for (let i = 0; i < 5; i++) assert.equal((await get(app, '/health', '1.1.1.1')).status, 200)
})

test('makeWindowCounter: the count starts over with the next window', () => {
  const over = makeWindowCounter(2, 1000)
  assert.equal(over('a', 0), false)
  assert.equal(over('a', 10), false)
  assert.equal(over('a', 20), true)
  assert.equal(over('a', 1000), false)
})
