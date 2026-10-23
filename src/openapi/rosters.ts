import { z } from 'zod'
import { rosterIdSchema, rosterListEntrySchema, rosterSchema } from '../domain/roster.js'
import { deleteQuerySchema, listQuerySchema } from '../routes/rosters.js'
import { asAccount, body, component, describe, errorSchema, unauthorized } from './registry.js'

// /rosters — army-list sync (routes/rosters.ts, README "Army lists").

const tags = ['Rosters']
const security = asAccount
const params = z.object({ id: rosterIdSchema })

component('RosterListEntry', rosterListEntrySchema)
component('Roster', rosterSchema)

describe({
  method: 'get',
  path: '/rosters',
  tags,
  summary: 'Every list of the account, metadata only — tombstones included',
  security,
  request: { query: listQuerySchema },
  responses: {
    200: { description: 'Live lists and deleted ones, newest first', schema: z.object({ rosters: z.array(rosterListEntrySchema) }) },
    400: { description: 'Bad query', schema: errorSchema('bad_query') },
    ...unauthorized,
  },
})

describe({
  method: 'get',
  path: '/rosters/{id}',
  tags,
  summary: 'One list, as the client uploaded it',
  security,
  request: { params },
  responses: {
    200: { description: 'The stored list', schema: rosterSchema },
    400: { description: 'Bad id', schema: errorSchema('bad_id') },
    404: { description: 'No such list (or deleted)', schema: errorSchema('not_found') },
    ...unauthorized,
  },
})

describe({
  method: 'put',
  path: '/rosters/{id}',
  tags,
  summary: 'Save a list (create or overwrite)',
  description: 'A wizard draft (`draft: true`) is refused: it never leaves the device it was started on.',
  security,
  request: { params, body: body(rosterSchema) },
  responses: {
    200: { description: 'Saved', schema: z.object({ ok: z.literal(true), rosterId: rosterIdSchema }) },
    400: { description: 'Bad id or not JSON', schema: errorSchema('bad_id', 'invalid_json') },
    409: { description: 'The account already holds the maximum number of lists', schema: errorSchema('quota_exceeded') },
    413: { description: 'The list is over the size cap', schema: errorSchema('payload_too_large') },
    422: { description: 'Not a list, a draft, or the body’s id is not the path’s', schema: errorSchema('invalid_roster', 'id_mismatch') },
    ...unauthorized,
  },
})

describe({
  method: 'delete',
  path: '/rosters/{id}',
  tags,
  summary: 'Delete a list — leaves a tombstone other devices learn from',
  security,
  request: { params, query: deleteQuerySchema },
  responses: {
    204: 'Deleted (also when the id was never stored)',
    400: { description: 'Bad id or query', schema: errorSchema('bad_id', 'bad_query') },
    ...unauthorized,
  },
})
