import { z } from 'zod'
import { rosterIdSchema, rosterListEntrySchema, rosterSchema } from '../domain/roster.js'
import { deleteQuerySchema, listQuerySchema } from '../routes/rosters.js'
import { bearerAuth, errorBody, json, registry } from './registry.js'

// /rosters — army-list sync (routes/rosters.ts, README "Army lists").

const tag = 'Rosters'
const security = [{ [bearerAuth.name]: [] }]
const idParam = z.object({ id: rosterIdSchema })
const unauthorized = { 401: { description: 'No valid access token' } }

registry.register('RosterListEntry', rosterListEntrySchema)
registry.register('Roster', rosterSchema)

registry.registerPath({
  method: 'get',
  path: '/rosters',
  tags: [tag],
  summary: 'Every list of the account, metadata only — tombstones included',
  security,
  request: { query: listQuerySchema },
  responses: {
    200: { description: 'Live lists and deleted ones, newest first', ...json(z.object({ rosters: z.array(rosterListEntrySchema) })) },
    400: { description: 'Bad query', ...errorBody('bad_query') },
    ...unauthorized,
  },
})

registry.registerPath({
  method: 'get',
  path: '/rosters/{id}',
  tags: [tag],
  summary: 'One list, as the client uploaded it',
  security,
  request: { params: idParam },
  responses: {
    200: { description: 'The stored list', ...json(rosterSchema) },
    400: { description: 'Bad id', ...errorBody('bad_id') },
    404: { description: 'No such list (or deleted)', ...errorBody('not_found') },
    ...unauthorized,
  },
})

registry.registerPath({
  method: 'put',
  path: '/rosters/{id}',
  tags: [tag],
  summary: 'Save a list (create or overwrite)',
  description: 'A wizard draft (`draft: true`) is refused: it never leaves the device it was started on.',
  security,
  request: { params: idParam, body: { required: true, ...json(rosterSchema) } },
  responses: {
    200: { description: 'Saved', ...json(z.object({ ok: z.literal(true), rosterId: rosterIdSchema })) },
    400: { description: 'Bad id or not JSON', ...errorBody('bad_id', 'invalid_json') },
    409: { description: 'The account already holds the maximum number of lists', ...errorBody('quota_exceeded') },
    413: { description: 'The list is over the size cap', ...errorBody('payload_too_large') },
    422: { description: 'Not a list, a draft, or the body’s id is not the path’s', ...errorBody('invalid_roster', 'id_mismatch') },
    ...unauthorized,
  },
})

registry.registerPath({
  method: 'delete',
  path: '/rosters/{id}',
  tags: [tag],
  summary: 'Delete a list — leaves a tombstone other devices learn from',
  security,
  request: { params: idParam, query: deleteQuerySchema },
  responses: {
    204: { description: 'Deleted (also when the id was never stored)' },
    400: { description: 'Bad id or query', ...errorBody('bad_id', 'bad_query') },
    ...unauthorized,
  },
})
