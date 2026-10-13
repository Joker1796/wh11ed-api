import { z } from 'zod'
import { gameIdSchema } from '../domain/game.js'
import { broadcastTokenSchema } from '../domain/broadcast.js'
import { asAccount, body, describe, errorSchema, unauthorized } from './registry.js'

// /broadcast — the live scoreboard an OBS overlay reads (routes/broadcast.ts, README "The
// broadcast feed"). Turning it on and off is under /games/{id}/broadcast.

const tags = ['Broadcast']
const payload = z.object({}).passthrough().openapi({ description: 'The scoreboard as the phone projects it — the tracker’s shape, stored as sent' })

describe({
  method: 'put',
  path: '/broadcast/live/{gameId}',
  tags,
  summary: 'The phone pushing the game’s current state',
  security: asAccount,
  request: { params: z.object({ gameId: gameIdSchema }), body: body(payload) },
  responses: {
    200: { description: 'Stored', schema: z.object({ ok: z.literal(true) }) },
    400: { description: 'Bad id or not JSON', schema: errorSchema('bad_id', 'invalid_json') },
    404: { description: 'The broadcast is not on for this game', schema: errorSchema('not_found') },
    413: { description: 'Over the size cap', schema: errorSchema('payload_too_large') },
    422: { description: 'Not a JSON object', schema: errorSchema('invalid_payload') },
    ...unauthorized,
  },
})

describe({
  method: 'get',
  path: '/broadcast/{token}',
  tags,
  summary: 'The public read — what an overlay polls',
  description: 'No account: the token is the credential. Open CORS. Send `If-None-Match` with the last ETag and an unchanged game answers 304 with no body.',
  request: {
    params: z.object({ token: broadcastTokenSchema }),
    headers: z.object({ 'if-none-match': z.string().optional() }),
  },
  responses: {
    200: {
      description: 'The latest state',
      schema: z.object({ payload: payload.nullable(), updatedAt: z.string().nullable() }),
      headers: { ETag: { description: 'Send it back as If-None-Match', schema: { type: 'string' } } },
    },
    304: 'Nothing changed since that ETag',
    400: { description: 'Not a token', schema: errorSchema('bad_token') },
    404: { description: 'No such broadcast, or it was turned off', schema: errorSchema('not_found') },
  },
})
