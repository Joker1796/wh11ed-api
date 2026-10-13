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

  const undescribed = [...routes].filter((r) => !described.has(r))
  assert.deepEqual(undescribed, [], 'routes with no description — add them to src/openapi/')
  const phantom = [...described].filter((r) => !routes.has(r))
  assert.deepEqual(phantom, [], 'described routes the app does not have')
})
