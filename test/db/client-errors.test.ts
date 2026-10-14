import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { freshSchema, closeDb, db } from './setup.js'

// POST /errors end to end: the route the site calls (text/plain, no credentials), the SQL that
// counts an error up instead of storing it again, production and the beta in their own tables.

process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
process.env.API_BASE_URL = 'http://localhost:8787'
process.env.APP_AFTER_LOGIN_URL = 'http://localhost:5173/tracker/auth-callback'
const { app } = await import('../../src/app.js')
const { purgeErrors, reporters } = await import('../../src/db/clientErrors.repo.js')

let ip = 0
async function send(body: unknown, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6.1 Mobile/15E148 Safari/604.1') {
  const res = await app.fetch(new Request('http://localhost:8787/errors', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': ua, 'X-Forwarded-For': `10.9.0.${++ip % 250}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return res.status
}
const boom = (msg = 'boom', at = ':1:2') => ({ kind: 'error', msg, stack: `Error\n    at f (https://wh-rules.ru/assets/a-AbCdEf12.js${at})` })

describe('POST /errors', () => {
  beforeEach(freshSchema)
  after(closeDb)

  it('counts one error up instead of storing it twice, by version', async () => {
    assert.equal(await send({ channel: 'prod', appVersion: '2.9.1', route: '/ru/roster/shared#r=1.secret', errors: [boom()] }), 204)
    assert.equal(await send({ channel: 'prod', appVersion: '2.9.1', route: '/ru/tracker', errors: [boom('boom', ':9:9')] }, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36'), 204)
    assert.equal(await send({ channel: 'prod', appVersion: '2.9.2', errors: [boom()] }), 204)
    const rows = await db()`SELECT app_version, count, browsers, routes FROM client_errors ORDER BY app_version`
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.count, 2)
    assert.deepEqual(rows[0]!.browsers, { 'Safari iOS': 1, 'Chrome Windows': 1 })
    assert.deepEqual(rows[0]!.routes, { '/ru/roster/shared': 1, '/ru/tracker': 1 })
    assert.ok(!JSON.stringify(rows).includes('secret'), 'the hash of a route is never stored')
  })

  it('keeps the beta apart, and counts the day\'s reporting browsers', async () => {
    assert.equal(await send({ channel: 'beta', appVersion: '2.9.1', hello: true, errors: [boom()] }), 204)
    assert.equal(await send({ channel: 'beta', appVersion: '2.9.1', hello: true }), 204)
    assert.equal((await db()`SELECT count(*)::int AS n FROM client_errors`)[0]!.n, 0)
    assert.equal((await db()`SELECT count(*)::int AS n FROM client_errors_beta`)[0]!.n, 1)
    assert.equal(await reporters('beta', new Date().toISOString().slice(0, 10)), 2)
  })

  it('refuses what is not a batch', async () => {
    assert.equal(await send('not json'), 422)
    assert.equal(await send({ channel: 'prod', appVersion: '2.9.1', errors: [{ kind: 'nope', msg: 'x' }] }), 422)
    assert.equal(await send('x'.repeat(17 * 1024)), 413)
  })

  it('drops rows quiet for longer than the retention', async () => {
    await send({ channel: 'prod', appVersion: '2.9.1', errors: [boom()] })
    await db()`UPDATE client_errors SET last_seen = now() - interval '31 days'`
    assert.equal(await purgeErrors(30), 1)
  })
})
