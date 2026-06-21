import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth, type AuthVars } from '../auth/middleware.js'
import { parseGame, extractMetadata, GamePayloadError } from '../domain/game.js'
import { config } from '../config.js'
import {
  listGames,
  getGameBlob,
  upsertGame,
  deleteGame,
  countGames,
} from '../db/games.repo.js'

export const gameRoutes = new Hono<{ Variables: AuthVars }>()

gameRoutes.use('*', requireAuth)

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

gameRoutes.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse({ limit: c.req.query('limit') })
  if (!parsed.success) return c.json({ error: 'bad_query' }, 400)
  const games = await listGames(c.var.userId, parsed.data.limit)
  return c.json({ games })
})

gameRoutes.get('/:id', async (c) => {
  const blob = await getGameBlob(c.var.userId, c.req.param('id'))
  if (!blob) return c.json({ error: 'not_found' }, 404)
  return c.json(blob)
})

gameRoutes.put('/:id', async (c) => {
  const id = c.req.param('id')
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  let game, json
  try {
    ;({ game, json } = parseGame(raw))
  } catch (e) {
    if (e instanceof GamePayloadError) return c.json({ error: 'payload_too_large' }, 413)
    return c.json({ error: 'invalid_game' }, 422)
  }
  if (game.id !== id) return c.json({ error: 'id_mismatch' }, 422)

  // Enforce the per-user cap, but always allow overwriting an existing game.
  const existing = await getGameBlob(c.var.userId, id)
  if (!existing) {
    const count = await countGames(c.var.userId)
    if (count >= config.maxGamesPerUser) return c.json({ error: 'quota_exceeded' }, 409)
  }

  await upsertGame({
    userId: c.var.userId,
    meta: extractMetadata(game),
    json,
    nowIso: new Date().toISOString(),
  })
  return c.json({ ok: true, gameId: id })
})

gameRoutes.delete('/:id', async (c) => {
  await deleteGame(c.var.userId, c.req.param('id'))
  return c.body(null, 204)
})
