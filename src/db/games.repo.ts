import { db } from './driver.js'
import type { GameMetadata } from '../domain/game.js'

interface GameMetaRow {
  game_id: string
  created_at: string | null
  finished_at: string | null
  result_summary: string | null
  players: string | null
}

interface GameBlobRow {
  blob: string | null
}

interface CountRow {
  cnt: string | number
}

export async function countGames(userId: string): Promise<number> {
  const rows = await db()<CountRow[]>`SELECT COUNT(*) AS cnt FROM games WHERE user_id = ${userId}`
  return Number(rows[0]?.cnt ?? 0)
}

export async function listGames(userId: string, limit: number): Promise<GameMetadata[]> {
  const rows = await db()<GameMetaRow[]>`
    SELECT game_id, created_at, finished_at, result_summary, players
    FROM games WHERE user_id = ${userId}
    ORDER BY finished_at DESC, game_id DESC
    LIMIT ${limit}`
  return rows.map((r) => ({
    gameId: r.game_id,
    createdAt: r.created_at || null,
    finishedAt: r.finished_at || null,
    resultSummary: r.result_summary || null,
    players: safeParseArray(r.players),
  }))
}

export async function getGameBlob(userId: string, gameId: string): Promise<unknown | null> {
  const rows = await db()<GameBlobRow[]>`
    SELECT blob FROM games WHERE user_id = ${userId} AND game_id = ${gameId}`
  const blob = rows[0]?.blob
  if (!blob) return null
  try {
    return JSON.parse(blob)
  } catch {
    // A corrupted blob shouldn't surface as a 500; treat it as absent (404) and log for triage.
    console.error(`[games] corrupt blob for user=${userId} game=${gameId}`)
    return null
  }
}

export async function upsertGame(input: {
  userId: string
  meta: GameMetadata
  json: string
  nowIso: string
}): Promise<void> {
  const { meta } = input
  await db()`
    INSERT INTO games (user_id, game_id, blob, created_at, finished_at, result_summary, players, updated_at)
    VALUES (${input.userId}, ${meta.gameId}, ${input.json}, ${meta.createdAt ?? ''}, ${meta.finishedAt ?? ''},
            ${meta.resultSummary ?? ''}, ${JSON.stringify(meta.players)}, ${input.nowIso})
    ON CONFLICT (user_id, game_id) DO UPDATE SET
      blob = EXCLUDED.blob, created_at = EXCLUDED.created_at, finished_at = EXCLUDED.finished_at,
      result_summary = EXCLUDED.result_summary, players = EXCLUDED.players, updated_at = EXCLUDED.updated_at`
}

export async function deleteGame(userId: string, gameId: string): Promise<void> {
  await db()`DELETE FROM games WHERE user_id = ${userId} AND game_id = ${gameId}`
}

function safeParseArray(s: string | null): { name: string; factionSlug: string | null }[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
