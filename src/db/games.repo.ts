import { TypedValues } from 'ydb-sdk'
import { query } from './driver.js'
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
  cnt: number | bigint
}

export async function countGames(userId: string): Promise<number> {
  const rows = await query<CountRow>(
    `DECLARE $user_id AS Utf8;
     SELECT COUNT(*) AS cnt FROM games WHERE user_id = $user_id;`,
    { $user_id: TypedValues.utf8(userId) },
  )
  return Number(rows[0]?.cnt ?? 0)
}

export async function listGames(userId: string, limit: number): Promise<GameMetadata[]> {
  const rows = await query<GameMetaRow>(
    `DECLARE $user_id AS Utf8;
     DECLARE $limit AS Uint64;
     SELECT game_id, created_at, finished_at, result_summary, players
     FROM games WHERE user_id = $user_id
     ORDER BY finished_at DESC, game_id DESC
     LIMIT $limit;`,
    { $user_id: TypedValues.utf8(userId), $limit: TypedValues.uint64(limit) },
  )
  return rows.map((r) => ({
    gameId: r.game_id,
    createdAt: r.created_at || null,
    finishedAt: r.finished_at || null,
    resultSummary: r.result_summary || null,
    players: safeParseArray(r.players),
  }))
}

export async function getGameBlob(userId: string, gameId: string): Promise<unknown | null> {
  const rows = await query<GameBlobRow>(
    `DECLARE $user_id AS Utf8;
     DECLARE $game_id AS Utf8;
     SELECT blob FROM games WHERE user_id = $user_id AND game_id = $game_id;`,
    { $user_id: TypedValues.utf8(userId), $game_id: TypedValues.utf8(gameId) },
  )
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
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $game_id AS Utf8;
     DECLARE $blob AS Utf8;
     DECLARE $created_at AS Utf8;
     DECLARE $finished_at AS Utf8;
     DECLARE $result_summary AS Utf8;
     DECLARE $players AS Utf8;
     DECLARE $updated_at AS Utf8;
     UPSERT INTO games
       (user_id, game_id, blob, created_at, finished_at, result_summary, players, updated_at)
     VALUES
       ($user_id, $game_id, $blob, $created_at, $finished_at, $result_summary, $players, $updated_at);`,
    {
      $user_id: TypedValues.utf8(input.userId),
      $game_id: TypedValues.utf8(meta.gameId),
      $blob: TypedValues.utf8(input.json),
      $created_at: TypedValues.utf8(meta.createdAt ?? ''),
      $finished_at: TypedValues.utf8(meta.finishedAt ?? ''),
      $result_summary: TypedValues.utf8(meta.resultSummary ?? ''),
      $players: TypedValues.utf8(JSON.stringify(meta.players)),
      $updated_at: TypedValues.utf8(input.nowIso),
    },
  )
}

export async function deleteGame(userId: string, gameId: string): Promise<void> {
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $game_id AS Utf8;
     DELETE FROM games WHERE user_id = $user_id AND game_id = $game_id;`,
    { $user_id: TypedValues.utf8(userId), $game_id: TypedValues.utf8(gameId) },
  )
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
