import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import { returnOrigin } from '../config.js'
import { requireAuth, type AuthVars } from '../auth/middleware.js'
import { burnHashTime, hashPassword, normalizeEmail, PASSWORD_MAX, PASSWORD_MIN, verifyPassword } from '../auth/password.js'
import { destroyOtherSessions, destroyUserSessions } from '../auth/sessions.js'
import { clientIp, makeThrottle } from '../lib/throttle.js'
import { sendUserMail } from '../mail/smtp.js'
import {
  addPasswordLogin, consumeEmailToken, createPasswordAccount, getLoginByEmail, getLoginByUser, issueEmailToken, markVerified,
  setPassword,
  type TokenPurpose,
} from '../db/password.repo.js'
import { originAllowed, siteOf, startSession } from './auth.js'

// Email + password sign-in, next to Yandex (README "Signing in with an email"). Every endpoint that
// sets the session cookie is a POST behind the same Origin allow-list as /auth/refresh.
//
// What is deliberately NOT told to a stranger: whether an address has an account (login answers the
// same "wrong email or password" either way and costs the same time; "forgot password" always says
// "sent"). The one place it shows is registration ("taken") — unavoidable, and fenced by a per-IP
// limit.

export const emailAuthRoutes = new Hono<{ Variables: AuthVars }>()

// The body schemas below are exported for the stand's OpenAPI description (src/openapi/), which
// reads them rather than restating them.

const emailSchema = z.string().trim().min(3).max(254).email()
const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX)
const localeSchema = z.enum(['ru', 'en']).default('ru')

const VERIFY_TTL_MS = 3 * 24 * 3600 * 1000
const RESET_TTL_MS = 60 * 60 * 1000

// Fences, in-process like every other throttle here. An email key is the normalized address.
const registerByIp = makeThrottle(5, 60 * 60 * 1000)
const loginByIp = makeThrottle(30, 10 * 60 * 1000)
const loginByEmail = makeThrottle(10, 10 * 60 * 1000)
const mailByEmail = makeThrottle(3, 60 * 60 * 1000)
const mailByIp = makeThrottle(10, 60 * 60 * 1000)

const ipOf = (c: { req: { header(n: string): string | undefined } }) => clientIp(c.req.header('X-Forwarded-For'))

/** Where a mailed link points: the site the request came from when it is ours, else the default. */
function appOrigin(c: Parameters<typeof siteOf>[0], asked: string | undefined): string {
  return returnOrigin(asked) ?? new URL(siteOf(c).appAfterLoginUrl).origin
}

const MAIL = {
  verify: {
    ru: (link: string) => ({
      subject: 'WH Rules: подтвердите почту',
      text: `Здравствуйте!\n\nВы зарегистрировались на WH Rules. Подтвердите почту по ссылке:\n${link}\n\nСсылка действует 3 дня. Если вы не регистрировались, просто удалите это письмо.\n\n— WH Rules`,
    }),
    en: (link: string) => ({
      subject: 'WH Rules: confirm your email',
      text: `Hello!\n\nYou signed up for WH Rules. Confirm your email with this link:\n${link}\n\nThe link works for 3 days. If it was not you, just delete this mail.\n\n— WH Rules`,
    }),
  },
  reset: {
    ru: (link: string) => ({
      subject: 'WH Rules: новый пароль',
      text: `Здравствуйте!\n\nКто-то попросил сменить пароль для этой почты на WH Rules. Задать новый пароль можно по ссылке:\n${link}\n\nСсылка действует 1 час. Если вы ничего не просили, просто удалите это письмо — пароль останется прежним.\n\n— WH Rules`,
    }),
    en: (link: string) => ({
      subject: 'WH Rules: set a new password',
      text: `Hello!\n\nSomeone asked to change the password for this email on WH Rules. Set a new one with this link:\n${link}\n\nThe link works for 1 hour. If it was not you, just delete this mail — the password stays as it is.\n\n— WH Rules`,
    }),
  },
} as const

async function mailLink(input: {
  userId: string
  email: string
  purpose: TokenPurpose
  locale: 'ru' | 'en'
  origin: string
}): Promise<boolean> {
  const token = await issueEmailToken({
    userId: input.userId,
    email: input.email,
    purpose: input.purpose,
    ttlMs: input.purpose === 'verify' ? VERIFY_TTL_MS : RESET_TTL_MS,
    nowIso: new Date().toISOString(),
  })
  const path = input.purpose === 'verify' ? 'account/verify' : 'account/reset'
  const prefix = input.locale === 'ru' ? '/ru' : ''
  const link = `${input.origin}${prefix}/${path}#token=${token}`
  const { subject, text } = MAIL[input.purpose][input.locale](link)
  return sendUserMail(input.email, subject, text)
}

// Every route here changes the session or mails someone: the Origin fence comes first.
emailAuthRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && !originAllowed(c.req.header('Origin'))) return c.json({ error: 'forbidden_origin' }, 403)
  await next()
})

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().max(60).optional().default(''),
  locale: localeSchema,
  origin: z.string().max(200).optional(),
})

emailAuthRoutes.post('/register', async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
  if (registerByIp(ipOf(c), Date.now())) return c.json({ error: 'too_many' }, 429)
  const body = parsed.data
  const email = normalizeEmail(body.email)
  const created = await createPasswordAccount({
    email,
    hash: await hashPassword(body.password),
    displayName: body.name || email.split('@')[0]!,
    nowIso: new Date().toISOString(),
  })
  if (!created.ok) return c.json({ error: 'email_taken' }, 409)
  await startSession(c, created.userId, siteOf(c))
  // The account works at once; the mail only proves the address (needed before a reset can be
  // trusted to reach its owner). A relay that is down does not stop anyone from playing.
  const mailSent = await mailLink({ userId: created.userId, email, purpose: 'verify', locale: body.locale, origin: appOrigin(c, body.origin) })
  return c.json({ ok: true, verified: false, mailSent }, 201)
})

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(PASSWORD_MAX) })

emailAuthRoutes.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
  const email = normalizeEmail(parsed.data.email)
  const now = Date.now()
  if (loginByIp(ipOf(c), now) || loginByEmail(email, now)) return c.json({ error: 'too_many' }, 429)
  const login = await getLoginByEmail(email)
  if (!login) {
    await burnHashTime(parsed.data.password)
    return c.json({ error: 'bad_credentials' }, 401)
  }
  if (!(await verifyPassword(parsed.data.password, login.hash))) return c.json({ error: 'bad_credentials' }, 401)
  await startSession(c, login.user_id, siteOf(c))
  return c.json({ ok: true, verified: !!login.verified_at })
})

export const tokenSchema = z.object({ token: z.string().min(20).max(100) })

emailAuthRoutes.post('/verify', async (c) => {
  const parsed = tokenSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
  const nowIso = new Date().toISOString()
  const userId = await consumeEmailToken(parsed.data.token, 'verify', nowIso)
  if (!userId) return c.json({ error: 'link_invalid' }, 410)
  await markVerified(userId, nowIso)
  return c.json({ ok: true })
})

export const forgotSchema = z.object({ email: emailSchema, locale: localeSchema, origin: z.string().max(200).optional() })

emailAuthRoutes.post('/forgot', async (c) => {
  const parsed = forgotSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
  const email = normalizeEmail(parsed.data.email)
  const now = Date.now()
  if (mailByIp(ipOf(c), now) || mailByEmail(email, now)) return c.json({ error: 'too_many' }, 429)
  const login = await getLoginByEmail(email)
  // Same answer whether or not the address has an account. A relay failure IS said, though — a
  // player waiting for a mail that never went needs to know to try again later.
  if (!login) return c.json({ ok: true })
  const mailSent = await mailLink({ userId: login.user_id, email, purpose: 'reset', locale: parsed.data.locale, origin: appOrigin(c, parsed.data.origin) })
  return mailSent ? c.json({ ok: true }) : c.json({ error: 'mail_failed' }, 503)
})

export const resetSchema = z.object({ token: z.string().min(20).max(100), password: passwordSchema })

emailAuthRoutes.post('/reset', async (c) => {
  const parsed = resetSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
  const nowIso = new Date().toISOString()
  const userId = await consumeEmailToken(parsed.data.token, 'reset', nowIso)
  if (!userId) return c.json({ error: 'link_invalid' }, 410)
  await setPassword(userId, await hashPassword(parsed.data.password), nowIso)
  // The link reached the address, so the address is proven; and every other device is signed out —
  // a reset is what someone does when they think another person has their password.
  await markVerified(userId, nowIso)
  await destroyUserSessions(userId)
  await startSession(c, userId, siteOf(c))
  return c.json({ ok: true })
})

export const resendSchema = z.object({ locale: localeSchema, origin: z.string().max(200).optional() })

emailAuthRoutes.post('/resend', requireAuth, async (c) => {
  const parsed = resendSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
  const login = await getLoginByUser(c.var.userId)
  if (!login) return c.json({ error: 'not_found' }, 404)
  if (login.verified_at) return c.json({ ok: true, verified: true })
  const now = Date.now()
  if (mailByIp(ipOf(c), now) || mailByEmail(login.email, now)) return c.json({ error: 'too_many' }, 429)
  const mailSent = await mailLink({ userId: login.user_id, email: login.email, purpose: 'verify', locale: parsed.data.locale, origin: appOrigin(c, parsed.data.origin) })
  return mailSent ? c.json({ ok: true }) : c.json({ error: 'mail_failed' }, 503)
})

// ── For a signed-in player ─────────────────────────────────────────────────────────────────────

export const addSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  locale: localeSchema,
  origin: z.string().max(200).optional(),
})

/** A Yandex account gets an email + password as a second way in — the same account, same data. */
emailAuthRoutes.post('/add', requireAuth, async (c) => {
  const parsed = addSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
  if (registerByIp(ipOf(c), Date.now())) return c.json({ error: 'too_many' }, 429)
  const email = normalizeEmail(parsed.data.email)
  const added = await addPasswordLogin({
    userId: c.var.userId,
    email,
    hash: await hashPassword(parsed.data.password),
    nowIso: new Date().toISOString(),
  })
  if (!added.ok) return c.json({ error: added.reason === 'taken' ? 'email_taken' : 'has_login' }, 409)
  const mailSent = await mailLink({ userId: c.var.userId, email, purpose: 'verify', locale: parsed.data.locale, origin: appOrigin(c, parsed.data.origin) })
  return c.json({ ok: true, verified: false, mailSent }, 201)
})

export const changeSchema = z.object({ current: z.string().min(1).max(PASSWORD_MAX), password: passwordSchema })

/**
 * A new password, the current one required. Every OTHER device is signed out (this one keeps its
 * session): changing a password is what someone does when they think another person has it.
 */
emailAuthRoutes.post('/password', requireAuth, async (c) => {
  const parsed = changeSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
  const login = await getLoginByUser(c.var.userId)
  if (!login) return c.json({ error: 'not_found' }, 404)
  if (loginByEmail(login.email, Date.now())) return c.json({ error: 'too_many' }, 429)
  if (!(await verifyPassword(parsed.data.current, login.hash))) return c.json({ error: 'bad_credentials' }, 401)
  await setPassword(c.var.userId, await hashPassword(parsed.data.password), new Date().toISOString())
  await destroyOtherSessions(c.var.userId, getCookie(c, 'rt') || '')
  return c.json({ ok: true })
})
