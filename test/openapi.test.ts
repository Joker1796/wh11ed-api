import { test } from 'node:test'
import assert from 'node:assert/strict'

// The stand's API description (src/openapi/). Two things are checked: that it does not exist
// without SWAGGER=1 — like /dev/jwt, a deployment never registers it — and that it describes
// every route the app has, so a new route without a description fails here.
process.env.JWT_SIGNING_KEY ||= 'test-signing-key-test-signing-key'
process.env.API_BASE_URL ||= 'http://localhost:8787'
process.env.APP_AFTER_LOGIN_URL ||= 'http://localhost:5173/tracker/auth-callback'
delete process.env.SWAGGER
delete process.env.DEV_JWT

// Routes not described YET. The list only shrinks: describing one fails this test until its line
// is removed, and a route added to the app is not let in here.
const PENDING = new Set([
  'POST /auth/email/register', 'POST /auth/email/login', 'POST /auth/email/verify', 'POST /auth/email/forgot',
  'POST /auth/email/reset', 'POST /auth/email/resend', 'POST /auth/email/add', 'POST /auth/email/password',
  'GET /auth/{provider}/login', 'GET /auth/{provider}/callback', 'POST /auth/refresh', 'POST /auth/logout',
  'PUT /broadcast/live/{gameId}', 'GET /broadcast/{token}',
  'GET /changelog', 'POST /feedback',
  'GET /games', 'GET /games/{id}', 'PUT /games/{id}', 'DELETE /games/{id}',
  'POST /party', 'POST /party/join', 'GET /party/{id}', 'DELETE /party/{id}', 'POST /party/{id}/sync',
  'GET /party/{id}/members', 'POST /party/{id}/members/{mid}/kick', 'POST /party/{id}/members/{mid}/seat',
  'POST /party/{id}/seat', 'POST /party/{id}/reseat', 'POST /party/{id}/leave', 'POST /party/{id}/host',
  'POST /party/{id}/reclaim', 'GET /party/{id}/invite', 'POST /party/{id}/invite',
  'GET /games/{id}/broadcast', 'POST /games/{id}/broadcast', 'DELETE /games/{id}/broadcast',
  'GET /prefs', 'PUT /prefs/{scope}', 'GET /me',
])

const toOpenApi = (path: string) => path.replace(/:(\w+)/g, '{$1}')

test('/openapi.json and /swagger do not exist without SWAGGER=1', async () => {
  const { app } = await import('../src/app.js')
  for (const path of ['/openapi.json', '/swagger']) assert.equal((await app.request(path)).status, 404, path)
})

test('the description lists every route the app has', async () => {
  const { app } = await import('../src/app.js')
  const { buildOpenApiDocument } = await import('../src/openapi/index.js')
  const routes = new Set(
    app.routes
      .filter((r) => ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method))
      .map((r) => `${r.method} ${toOpenApi(r.path)}`),
  )
  const doc = buildOpenApiDocument()
  const described = new Set(
    Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops ?? {}).map((m) => `${m.toUpperCase()} ${path}`)),
  )

  const undescribed = [...routes].filter((r) => !described.has(r) && !PENDING.has(r))
  assert.deepEqual(undescribed, [], 'routes with no description — add them to src/openapi/')
  const phantom = [...described].filter((r) => !routes.has(r))
  assert.deepEqual(phantom, [], 'described routes the app does not have')
  const stale = [...PENDING].filter((r) => described.has(r) || !routes.has(r))
  assert.deepEqual(stale, [], 'PENDING lines to remove — described now, or gone from the app')
})
