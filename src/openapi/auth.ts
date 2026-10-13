import { z } from 'zod'
import {
  addSchema, changeSchema, forgotSchema, loginSchema, registerSchema, resendSchema, resetSchema, tokenSchema,
} from '../routes/email-auth.js'
import { asAccount, body, describe, errorSchema, forbiddenOrigin, refreshCookie, unauthorized } from './registry.js'

// Signing in: Yandex (routes/auth.ts), the session behind it, and email + password
// (routes/email-auth.ts). README "Auth" and "Signing in with an email".
//
// A sign-in does not return a token: it sets the session cookie (`rt`, HttpOnly), and the site then
// asks POST /auth/refresh for a short-lived access token.

const tags = ['Sign-in']
const viaCookie = [{ [refreshCookie.name]: [] }]
const invalidInput = { 400: { description: 'The body is not what this route takes', schema: errorSchema('invalid_input') } }
const signedIn = 'Signed in — the session cookie is set'
const mailFailed = { 503: { description: 'The mail could not be sent — try again later', schema: errorSchema('mail_failed') } }
const linkInvalid = { 410: { description: 'The link is unknown, used or expired', schema: errorSchema('link_invalid') } }

// ── Yandex ─────────────────────────────────────────────────────────────────────────────────────

const provider = z.object({ provider: z.enum(['yandex']) })
const unknownProvider = { 404: { description: 'No such provider', schema: errorSchema('unknown_provider') } }

describe({
  method: 'get',
  path: '/auth/{provider}/login',
  tags,
  summary: 'Start a sign-in — redirects to the provider',
  description: 'Open it in the browser, not with fetch: it is a page-to-page round trip. On the stand the provider is a stand-in.',
  request: {
    params: provider,
    query: z.object({ return: z.string().optional().openapi({ description: 'One of our own sites to come back to; anything else is ignored' }) }),
  },
  responses: { 302: 'To the provider’s sign-in page', ...unknownProvider },
})

describe({
  method: 'get',
  path: '/auth/{provider}/callback',
  tags,
  summary: 'Where the provider sends the browser back',
  description: 'Not called by hand. Signs the browser in and redirects to the site; a failure redirects there too, with `?error=<reason>`.',
  request: { params: provider, query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }) },
  responses: { 302: 'Back to the site', ...unknownProvider },
})

// ── The session ────────────────────────────────────────────────────────────────────────────────

describe({
  method: 'post',
  path: '/auth/refresh',
  tags,
  summary: 'A fresh access token for the signed-in browser',
  description: 'Spends the session cookie and sets a new one (each is good once).',
  security: viaCookie,
  responses: {
    200: { description: 'The token to send as `Authorization: Bearer`', schema: z.object({ accessToken: z.string(), expiresIn: z.number() }) },
    401: { description: 'No session, or it was ended', schema: errorSchema('no_session', 'invalid_session') },
    ...forbiddenOrigin,
  },
})

describe({
  method: 'post',
  path: '/auth/logout',
  tags,
  summary: 'Sign this browser out',
  security: viaCookie,
  responses: { 204: 'Signed out (also when it was not signed in)', ...forbiddenOrigin },
})

// ── Email and password ─────────────────────────────────────────────────────────────────────────

const okVerified = z.object({ ok: z.literal(true), verified: z.boolean() })
const okMail = z.object({ ok: z.literal(true), verified: z.literal(false), mailSent: z.boolean() })
const ok = z.object({ ok: z.literal(true) })
const emailTags = ['Sign-in: email']

describe({
  method: 'post',
  path: '/auth/email/register',
  tags: emailTags,
  summary: 'Create an account with an email and a password',
  description: 'The account works at once; a link to confirm the address is mailed (`mailSent` says whether it went).',
  request: { body: body(registerSchema) },
  responses: {
    201: { description: signedIn, schema: okMail },
    ...invalidInput,
    409: { description: 'The address already has an account', schema: errorSchema('email_taken') },
    ...forbiddenOrigin,
  },
})

describe({
  method: 'post',
  path: '/auth/email/login',
  tags: emailTags,
  summary: 'Sign in with an email and a password',
  description: 'A wrong address and a wrong password answer the same.',
  request: { body: body(loginSchema) },
  responses: {
    200: { description: `${signedIn}; \`verified\` is whether the address was confirmed`, schema: okVerified },
    ...invalidInput,
    401: { description: 'Wrong email or password', schema: errorSchema('bad_credentials') },
    ...forbiddenOrigin,
  },
})

describe({
  method: 'post',
  path: '/auth/email/verify',
  tags: emailTags,
  summary: 'Confirm the address — the token from the mailed link',
  request: { body: body(tokenSchema) },
  responses: { 200: { description: 'Confirmed', schema: ok }, ...invalidInput, ...linkInvalid, ...forbiddenOrigin },
})

describe({
  method: 'post',
  path: '/auth/email/forgot',
  tags: emailTags,
  summary: 'Mail a link to set a new password',
  description: 'Answers the same whether or not the address has an account.',
  request: { body: body(forgotSchema) },
  responses: { 200: { description: 'Sent (if the address has an account)', schema: ok }, ...invalidInput, ...mailFailed, ...forbiddenOrigin },
})

describe({
  method: 'post',
  path: '/auth/email/reset',
  tags: emailTags,
  summary: 'Set a new password — the token from the mailed link',
  description: 'Every other device is signed out; this browser is signed in.',
  request: { body: body(resetSchema) },
  responses: { 200: { description: signedIn, schema: ok }, ...invalidInput, ...linkInvalid, ...forbiddenOrigin },
})

describe({
  method: 'post',
  path: '/auth/email/resend',
  tags: emailTags,
  summary: 'Mail the confirmation link again',
  security: asAccount,
  request: { body: body(resendSchema, false) },
  responses: {
    200: { description: 'Sent — or `verified: true` when there was nothing to confirm', schema: z.union([ok, z.object({ ok: z.literal(true), verified: z.literal(true) })]) },
    ...invalidInput,
    404: { description: 'The account has no email sign-in', schema: errorSchema('not_found') },
    ...mailFailed,
    ...unauthorized,
    ...forbiddenOrigin,
  },
})

describe({
  method: 'post',
  path: '/auth/email/add',
  tags: emailTags,
  summary: 'Give a Yandex account an email and a password as a second way in',
  security: asAccount,
  request: { body: body(addSchema) },
  responses: {
    201: { description: 'Added; a confirmation link is mailed', schema: okMail },
    ...invalidInput,
    409: { description: 'The address belongs to another account, or this one already has an email sign-in', schema: errorSchema('email_taken', 'has_login') },
    ...unauthorized,
    ...forbiddenOrigin,
  },
})

describe({
  method: 'post',
  path: '/auth/email/password',
  tags: emailTags,
  summary: 'Change the password — the current one required',
  description: 'Every other device is signed out; this one stays signed in.',
  security: asAccount,
  request: { body: body(changeSchema) },
  responses: {
    200: { description: 'Changed', schema: ok },
    ...invalidInput,
    401: { description: 'No valid access token, or the current password is wrong', schema: errorSchema('missing_bearer_token', 'invalid_token', 'bad_credentials') },
    404: { description: 'The account has no email sign-in', schema: errorSchema('not_found') },
    ...forbiddenOrigin,
  },
})
