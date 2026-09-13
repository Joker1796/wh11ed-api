import { TypedValues } from 'ydb-sdk'
import { query } from './driver.js'

interface BroadcastOwnRow {
  token: string | null
  updated_at: string | null
}

interface BroadcastPublicRow {
  payload: string | null
  updated_at: string | null
}

/** The owner's view of their broadcast for one game (the token behind the share link). */
export async function getBroadcast(
  userId: string,
  gameId: string,
): Promise<{ token: string; updatedAt: string | null } | null> {
  const rows = await query<BroadcastOwnRow>(
    `DECLARE $user_id AS Utf8;
     DECLARE $game_id AS Utf8;
     SELECT token, updated_at FROM broadcasts
     WHERE user_id = $user_id AND game_id = $game_id;`,
    { $user_id: TypedValues.utf8(userId), $game_id: TypedValues.utf8(gameId) },
  )
  const row = rows[0]
  if (!row?.token) return null
  return { token: row.token, updatedAt: row.updated_at || null }
}

/**
 * Enable (or regenerate) the broadcast for one game. UPSERT on the (user, game) PK — a second
 * enable overwrites the row, so the previous token stops resolving the moment the new one lands.
 * The payload column is reset too: whatever the old token was serving must not leak through the
 * new one before the first push.
 */
export async function upsertBroadcast(input: {
  userId: string
  gameId: string
  token: string
  nowIso: string
  expiresAt: Date
}): Promise<void> {
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $game_id AS Utf8;
     DECLARE $token AS Utf8;
     DECLARE $updated_at AS Utf8;
     DECLARE $expires_at AS Timestamp;
     UPSERT INTO broadcasts (user_id, game_id, token, payload, updated_at, expires_at)
     VALUES ($user_id, $game_id, $token, NULL, $updated_at, $expires_at);`,
    {
      $user_id: TypedValues.utf8(input.userId),
      $game_id: TypedValues.utf8(input.gameId),
      $token: TypedValues.utf8(input.token),
      $updated_at: TypedValues.utf8(input.nowIso),
      $expires_at: TypedValues.timestamp(input.expiresAt),
    },
  )
}

export async function deleteBroadcast(userId: string, gameId: string): Promise<void> {
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $game_id AS Utf8;
     DELETE FROM broadcasts WHERE user_id = $user_id AND game_id = $game_id;`,
    { $user_id: TypedValues.utf8(userId), $game_id: TypedValues.utf8(gameId) },
  )
}

/**
 * Store the latest projected state. UPDATE, not UPSERT — pushing to a broadcast that was never
 * enabled (or already disabled/expired) must not conjure a row with no token. The caller checks
 * existence first (getBroadcast) to answer 404; the two queries are not atomic, but the worst
 * a race with DELETE can produce is a no-op UPDATE.
 */
export async function updateBroadcastPayload(input: {
  userId: string
  gameId: string
  json: string
  nowIso: string
  expiresAt: Date
}): Promise<void> {
  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $game_id AS Utf8;
     DECLARE $payload AS Utf8;
     DECLARE $updated_at AS Utf8;
     DECLARE $expires_at AS Timestamp;
     UPDATE broadcasts
     SET payload = $payload, updated_at = $updated_at, expires_at = $expires_at
     WHERE user_id = $user_id AND game_id = $game_id;`,
    {
      $user_id: TypedValues.utf8(input.userId),
      $game_id: TypedValues.utf8(input.gameId),
      $payload: TypedValues.utf8(input.json),
      $updated_at: TypedValues.utf8(input.nowIso),
      $expires_at: TypedValues.timestamp(input.expiresAt),
    },
  )
}

/** The public read: resolve a token via the global index, no owner required. */
export async function getBroadcastByToken(
  token: string,
): Promise<{ payload: unknown | null; updatedAt: string | null } | null> {
  const rows = await query<BroadcastPublicRow>(
    `DECLARE $token AS Utf8;
     SELECT payload, updated_at FROM broadcasts VIEW idx_broadcasts_token
     WHERE token = $token;`,
    { $token: TypedValues.utf8(token) },
  )
  const row = rows[0]
  if (!row) return null
  let payload: unknown | null = null
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload)
    } catch {
      // A corrupt payload shouldn't 500 a public poll; serve "no data yet" and log for triage.
      console.error(`[broadcasts] corrupt payload for token=${token.slice(0, 6)}…`)
    }
  }
  return { payload, updatedAt: row.updated_at || null }
}
