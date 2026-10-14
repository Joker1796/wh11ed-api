import { z } from 'zod'
import { changelogEntrySchema, PAGE_DEFAULT, PAGE_MAX, SEMVER } from '../domain/changelog.js'
import { feedbackSchema } from '../domain/feedback.js'
import { clientErrorsSchema } from '../domain/clientErrors.js'
import { asAccount, body, describe, errorSchema, registry, unauthorized } from './registry.js'

// The small public and per-account routes: /changelog (routes/changelog.ts), /feedback
// (routes/feedback.ts), /me (routes/me.ts).

registry.register('ChangelogEntry', changelogEntrySchema)

describe({
  method: 'get',
  path: '/changelog',
  tags: ['Changelog'],
  summary: 'A page of the release-notes archive, newest first',
  description: 'The recent releases ship inside the site; this holds the older ones. No account.',
  request: {
    query: z.object({
      before: z.string().regex(SEMVER).optional().openapi({ description: 'Only versions older than this one; absent = from the newest archived', example: '2.6.0' }),
      limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT).optional(),
    }),
  },
  responses: {
    200: { description: 'The page, and whether older entries remain', schema: z.object({ entries: z.array(changelogEntrySchema), more: z.boolean() }) },
    400: { description: 'Bad `before` or `limit`', schema: errorSchema('bad_before', 'bad_limit') },
  },
})

describe({
  method: 'post',
  path: '/feedback',
  tags: ['Feedback'],
  summary: 'Send a bug report',
  description:
    'No account needed; an access token, if one is sent, is recorded with the report. `context` (versions, route, recent errors) and `attachment` (a list or a game the player ticked) are kept as sent. `website` must stay empty.',
  request: { body: body(feedbackSchema) },
  responses: {
    200: { description: 'Received', schema: z.object({ ok: z.literal(true) }) },
    400: { description: 'Not JSON', schema: errorSchema('invalid_json') },
    413: { description: 'The message, context or attachment is over its size cap', schema: errorSchema('payload_too_large') },
    422: { description: 'Not a report', schema: errorSchema('invalid_feedback') },
  },
})

describe({
  method: 'post',
  path: '/errors',
  tags: ['Feedback'],
  summary: 'Send the errors a visitor ran into',
  description:
    'Only from visitors who switched sending on. No account; nothing about the sender is kept. Sent as `text/plain` (a CORS simple request) holding JSON. Stored as one counted row per error per site version; `hello` counts the day\'s reporting browsers.',
  request: { body: body(clientErrorsSchema) },
  responses: {
    204: { description: 'Received' },
    413: { description: 'Over 16 KB', schema: errorSchema('payload_too_large') },
    422: { description: 'Not JSON, or not this shape', schema: errorSchema('invalid_errors') },
    429: { description: 'Too many batches from one address', schema: errorSchema('too_many') },
  },
})

describe({
  method: 'get',
  path: '/me',
  tags: ['Account'],
  summary: 'Who is signed in',
  security: asAccount,
  responses: {
    200: {
      description: 'The account; `login` is its email + password sign-in, if it has one',
      schema: z.object({
        id: z.string(),
        email: z.string().nullable(),
        displayName: z.string().nullable(),
        login: z.object({ email: z.string(), verified: z.boolean() }).nullable(),
      }),
    },
    404: { description: 'The account is gone', schema: errorSchema('not_found') },
    ...unauthorized,
  },
})
