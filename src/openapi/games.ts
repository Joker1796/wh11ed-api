import { z } from 'zod'
import { gameIdSchema, gameMetadataSchema, gameSchema } from '../domain/game.js'
import { broadcastTokenSchema } from '../domain/broadcast.js'
import { listQuerySchema } from '../routes/games.js'
import { asAccount, body, component, describe, errorSchema, unauthorized } from './registry.js'

// /games — finished-game backup, and turning a game's live broadcast on and off
// (routes/games.ts, README "API").

const tags = ['Games']
const security = asAccount
const params = z.object({ id: gameIdSchema })
const badId = { 400: { description: 'Bad id', schema: errorSchema('bad_id') } }

component('GameMetadata', gameMetadataSchema)
component('Game', gameSchema)

describe({
  method: 'get',
  path: '/games',
  tags,
  summary: 'The account’s finished games, metadata only',
  security,
  request: { query: listQuerySchema },
  responses: {
    200: { description: 'Newest first', schema: z.object({ games: z.array(gameMetadataSchema) }) },
    400: { description: 'Bad query', schema: errorSchema('bad_query') },
    ...unauthorized,
  },
})

describe({
  method: 'get',
  path: '/games/{id}',
  tags,
  summary: 'One game, as the tracker uploaded it',
  security,
  request: { params },
  responses: {
    200: { description: 'The stored game', schema: gameSchema },
    ...badId,
    404: { description: 'No such game', schema: errorSchema('not_found') },
    ...unauthorized,
  },
})

describe({
  method: 'put',
  path: '/games/{id}',
  tags,
  summary: 'Save a game (create or overwrite)',
  description: 'Only the envelope is checked; the rest of the game is the tracker’s and is kept as sent.',
  security,
  request: { params, body: body(gameSchema) },
  responses: {
    200: { description: 'Saved', schema: z.object({ ok: z.literal(true), gameId: gameIdSchema }) },
    400: { description: 'Bad id or not JSON', schema: errorSchema('bad_id', 'invalid_json') },
    409: { description: 'The account already holds the maximum number of games', schema: errorSchema('quota_exceeded') },
    413: { description: 'The game is over the size cap', schema: errorSchema('payload_too_large') },
    422: { description: 'Not a game, or the body’s id is not the path’s', schema: errorSchema('invalid_game', 'id_mismatch') },
    ...unauthorized,
  },
})

describe({
  method: 'delete',
  path: '/games/{id}',
  tags,
  summary: 'Delete a game',
  security,
  request: { params },
  responses: { 204: 'Deleted (also when the id was never stored)', ...badId, ...unauthorized },
})

const tokenAnswer = z.object({ token: broadcastTokenSchema })

describe({
  method: 'post',
  path: '/games/{id}/broadcast',
  tags: ['Broadcast'],
  summary: 'Turn the game’s live broadcast on — or give it a new link',
  description: 'Either way a fresh token replaces the old one, and the old link stops working. The game need not be stored here.',
  security,
  request: { params },
  responses: { 200: { description: 'The token of the public read, GET /broadcast/{token}', schema: tokenAnswer }, ...badId, ...unauthorized },
})

describe({
  method: 'get',
  path: '/games/{id}/broadcast',
  tags: ['Broadcast'],
  summary: 'The game’s broadcast token, if the broadcast is on',
  security,
  request: { params },
  responses: {
    200: { description: 'On', schema: tokenAnswer },
    ...badId,
    404: { description: 'Off', schema: errorSchema('not_found') },
    ...unauthorized,
  },
})

describe({
  method: 'delete',
  path: '/games/{id}/broadcast',
  tags: ['Broadcast'],
  summary: 'Turn the broadcast off — its link stops working',
  security,
  request: { params },
  responses: { 204: 'Off', ...badId, ...unauthorized },
})
