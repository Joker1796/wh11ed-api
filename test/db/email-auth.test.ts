import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { freshSchema, closeDb } from './setup.js'

// Email + password sign-in end to end: the real routes (app.fetch), the real database, and the mail
// the stand's Mailpit catches — the links are followed exactly as a player would follow them.

process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
process.env.API_BASE_URL = 'http://localhost:8787'
process.env.APP_AFTER_LOGIN_URL = 'http://localhost:5173/tracker/auth-callback'
process.env.JWT_SIGNING_KEY ??= 'test-key-000000000000000000000000'
const MAILPIT = process.env.MAILPIT_URL || 'http://mailpit:8025'

const { app } = await import('../../src/app.js')

const ORIGIN = 'http://localhost:5173'
let ip = 0
async function call(path: string, body?: unknown, opts: { cookie?: string; origin?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${++ip % 250}` }
  if (opts.origin !== '') headers.Origin = opts.origin ?? ORIGIN
  if (opts.cookie) headers.Cookie = opts.cookie
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  const res = await app.fetch(new Request(`http://localhost:8787${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }))
  const cookie = (res.headers.get('set-cookie') || '').match(/rt=([^;]+)/)?.[1]
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, json: json as Record<string, unknown> | null, cookie: cookie ? `rt=${cookie}` : undefined }
}
const accessToken = async (cookie: string) => (await call('/auth/refresh', {}, { cookie })).json?.accessToken as string | undefined

async function mailTo(addr: string, subjectPart: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${addr}`)}`)).json()) as {
      messages: { ID: string; Subject: string }[]
    }
    const m = list.messages.find((x) => x.Subject.includes(subjectPart))
    if (m) return ((await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { Text: string }).Text
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no "${subjectPart}" mail to ${addr}`)
}
const tokenIn = (text: string) => text.match(/#token=([A-Za-z0-9_-]+)/)?.[1] ?? ''
let n = 0
const freshEmail = () => `player${Date.now()}${++n}@example.test`

beforeEach(freshSchema)
after(closeDb)

describe('email + password sign-in', () => {
  it('register → signed in at once, a confirmation mail, the link confirms once', async () => {
    const email = freshEmail()
    const reg = await call('/auth/email/register', { email: `  ${email.toUpperCase()} `, password: 'correct horse', locale: 'ru' })
    assert.equal(reg.status, 201)
    assert.equal(reg.json?.mailSent, true)
    assert.ok(reg.cookie, 'the refresh cookie is set')
    const token = await accessToken(reg.cookie!)
    assert.ok(token)
    let me = (await call('/me', undefined, { bearer: token })).json
    assert.deepEqual(me?.login, { email, verified: false })

    const mail = await mailTo(email, 'подтвердите почту')
    assert.match(mail, /http:\/\/localhost:5173\/ru\/account\/verify#token=/)
    const link = tokenIn(mail)
    assert.equal((await call('/auth/email/verify', { token: link })).status, 200)
    assert.equal((await call('/auth/email/verify', { token: link })).status, 410, 'a link works once')
    me = (await call('/me', undefined, { bearer: token })).json
    assert.deepEqual(me?.login, { email, verified: true })
  })

  it('one address, one account', async () => {
    const email = freshEmail()
    assert.equal((await call('/auth/email/register', { email, password: 'correct horse' })).status, 201)
    assert.equal((await call('/auth/email/register', { email, password: 'other password' })).status, 409)
  })

  it('login: the same refusal for a wrong password and an unknown address', async () => {
    const email = freshEmail()
    await call('/auth/email/register', { email, password: 'correct horse' })
    const wrong = await call('/auth/email/login', { email, password: 'wrong horse' })
    const unknown = await call('/auth/email/login', { email: freshEmail(), password: 'correct horse' })
    assert.deepEqual([wrong.status, wrong.json], [401, { error: 'bad_credentials' }])
    assert.deepEqual([unknown.status, unknown.json], [401, { error: 'bad_credentials' }])
    const ok = await call('/auth/email/login', { email: email.toUpperCase(), password: 'correct horse' })
    assert.equal(ok.status, 200)
    assert.ok(await accessToken(ok.cookie!))
  })

  it('reset: the mailed link sets a new password and signs every other device out', async () => {
    const email = freshEmail()
    const first = await call('/auth/email/register', { email, password: 'correct horse' })
    assert.deepEqual((await call('/auth/email/forgot', { email: freshEmail() })).json, { ok: true }, 'unknown address: same answer')
    assert.equal((await call('/auth/email/forgot', { email, locale: 'en' })).status, 200)
    const link = tokenIn(await mailTo(email, 'set a new password'))
    assert.equal((await call('/auth/email/reset', { token: link, password: 'short' })).status, 400, 'a weak password is refused first')
    const reset = await call('/auth/email/reset', { token: link, password: 'battery staple' })
    assert.equal(reset.status, 200)
    assert.equal((await call('/auth/refresh', {}, { cookie: first.cookie })).status, 401, 'the old device is signed out')
    assert.ok(await accessToken(reset.cookie!), 'this device is signed in')
    assert.equal((await call('/auth/email/login', { email, password: 'correct horse' })).status, 401)
    assert.equal((await call('/auth/email/login', { email, password: 'battery staple' })).status, 200)
    assert.equal((await call('/auth/email/reset', { token: link, password: 'again again' })).status, 410, 'once only')
  })

  it('fences: a foreign Origin, too many guesses for one address', async () => {
    assert.equal((await call('/auth/email/login', { email: 'a@b.test', password: 'x' }, { origin: 'https://evil.example' })).status, 403)
    const email = freshEmail()
    await call('/auth/email/register', { email, password: 'correct horse' })
    const statuses = []
    for (let i = 0; i < 11; i++) statuses.push((await call('/auth/email/login', { email, password: 'guess' + i })).status)
    assert.equal(statuses.at(-1), 429)
    assert.equal((await call('/auth/email/login', { email, password: 'correct horse' })).status, 429, 'locked for the window, right password or not')
  })

  it('/health/mail is ok once mail has gone out', async () => {
    await call('/auth/email/register', { email: freshEmail(), password: 'correct horse' })
    const h = await call('/health/mail')
    assert.equal(h.status, 200)
    assert.equal(h.json?.status, 'ok')
  })
})
