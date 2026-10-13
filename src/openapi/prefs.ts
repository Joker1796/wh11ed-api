import { z } from 'zod'
import { prefsPutSchema, prefsScopeRowSchema, prefsScopeSchema } from '../domain/prefs.js'
import { asAccount, body, describe, errorSchema, registry, unauthorized } from './registry.js'

// /prefs — a player's own marks: pinned factions, favourite datasheets, the collection
// (routes/prefs.ts, README "A player's marks").

const tags = ['Marks']

registry.register('PrefsScope', prefsScopeRowSchema)

describe({
  method: 'get',
  path: '/prefs',
  tags,
  summary: 'Every scope of the account in one request',
  description: 'One scope per faction slug, plus `@factions` for the pinned list. Send `If-None-Match` and an unchanged collection answers 304.',
  security: asAccount,
  request: { headers: z.object({ 'if-none-match': z.string().optional() }) },
  responses: {
    200: {
      description: 'All scopes',
      schema: z.object({ scopes: z.array(prefsScopeRowSchema) }),
      headers: { ETag: { description: 'Send it back as If-None-Match', schema: { type: 'string' } } },
    },
    304: 'Nothing changed since that ETag',
    ...unauthorized,
  },
})

describe({
  method: 'put',
  path: '/prefs/{scope}',
  tags,
  summary: 'Write one scope, based on the version it was merged from',
  description: '`version` 0 means “I believe this scope does not exist yet”. A stale version is refused with the row that beat it: merge with `current` and send again.',
  security: asAccount,
  request: { params: z.object({ scope: prefsScopeSchema }), body: body(prefsPutSchema) },
  responses: {
    200: { description: 'Written', schema: z.object({ ok: z.literal(true), scope: prefsScopeSchema, version: z.number() }) },
    400: { description: 'Bad scope or not JSON', schema: errorSchema('bad_scope', 'invalid_json') },
    409: {
      description: 'Another device wrote first (`version_conflict`, with its row), or the account holds the maximum number of scopes',
      schema: z.union([
        z.object({ error: z.literal('version_conflict'), current: prefsScopeRowSchema }),
        errorSchema('quota_exceeded'),
      ]),
    },
    413: { description: 'Over the size cap', schema: errorSchema('payload_too_large') },
    422: { description: 'Not a scope write', schema: errorSchema('invalid_prefs') },
    ...unauthorized,
  },
})
