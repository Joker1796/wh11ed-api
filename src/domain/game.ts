import { z } from 'zod'
import { config } from '../config.js'

// The tracker game object is stored as an opaque JSON blob. We validate only the envelope we
// rely on for ownership/idempotency/listing — NOT the full internal structure (which the client
// owns and may evolve). Unknown fields are preserved.

const playerSchema = z
  .object({
    name: z.string().max(120).optional().default(''),
    factionSlug: z.string().max(120).nullable().optional(),
  })
  .passthrough()

// Game id constraint, shared between the payload envelope and the URL route param.
export const gameIdSchema = z.string().min(1).max(64)

export const gameSchema = z
  .object({
    id: gameIdSchema,
    createdAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    phase: z.string().max(32).optional(),
    players: z.array(playerSchema).length(2).optional(),
    result: z
      .object({ totals: z.array(z.number()).length(2) })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type Game = z.infer<typeof gameSchema>

export interface GameMetadata {
  gameId: string
  createdAt: string | null
  finishedAt: string | null
  resultSummary: string | null
  // Small denormalized list of {name, factionSlug} for the history list view.
  players: { name: string; factionSlug: string | null }[]
}

export function extractMetadata(game: Game): GameMetadata {
  const players = (game.players ?? []).map((p) => ({
    name: p.name ?? '',
    factionSlug: p.factionSlug ?? null,
  }))
  const totals = game.result?.totals
  return {
    gameId: game.id,
    createdAt: game.createdAt ?? null,
    finishedAt: game.finishedAt ?? null,
    resultSummary: totals ? `${totals[0]}-${totals[1]}` : null,
    players,
  }
}

/** Parse + validate a raw game payload, enforcing the byte cap. Returns the canonical string too. */
export function parseGame(raw: unknown): { game: Game; json: string } {
  const game = gameSchema.parse(raw)
  const json = JSON.stringify(game)
  if (Buffer.byteLength(json, 'utf8') > config.maxGameBytes) {
    throw new GamePayloadError(`Game payload exceeds ${config.maxGameBytes} bytes`)
  }
  return { game, json }
}

export class GamePayloadError extends Error {}
