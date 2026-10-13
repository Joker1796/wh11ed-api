import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

// The stand's tripwire (src/openapi/mount.ts): with SWAGGER=1 every JSON answer is checked against
// its description, and a mismatch or a missing description is a line in the log. A tripwire that
// stays silent proves nothing, so this makes it fire. A file of its own: the flag must be set before
// app.ts is first imported, and test/openapi.test.ts imports it without.
process.env.SWAGGER = '1'
process.env.JWT_SIGNING_KEY ||= 'test-signing-key-test-signing-key'
process.env.API_BASE_URL ||= 'http://localhost:8787'
process.env.APP_AFTER_LOGIN_URL ||= 'http://localhost:5173/tracker/auth-callback'

test('with SWAGGER=1 the docs are served and every answer is checked against its description', async () => {
  const { app } = await import('../src/app.js')
  const { responseSchemas } = await import('../src/openapi/registry.js')
  assert.equal((await app.request('/openapi.json')).status, 200)
  assert.equal((await app.request('/swagger')).status, 200)

  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))
  try {
    // GET /me without a token answers 401 before touching the database.
    await app.request('/me')
    assert.deepEqual(warnings, [], 'an answer as described passes silently')

    const described = responseSchemas.get('GET /me 401')
    assert.ok(described)
    responseSchemas.set('GET /me 401', z.object({ nope: z.string() }))
    await app.request('/me')
    assert.match(warnings.at(-1) ?? '', /GET \/me 401 does not match its description/)

    responseSchemas.delete('GET /me 401')
    await app.request('/me')
    assert.match(warnings.at(-1) ?? '', /no description for GET \/me 401/)
    responseSchemas.set('GET /me 401', described)
  } finally {
    console.warn = warn
  }
})
