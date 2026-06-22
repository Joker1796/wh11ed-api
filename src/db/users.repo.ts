import { TypedValues } from 'ydb-sdk'
import { query } from './driver.js'

export interface User {
  user_id: string
  email: string | null
  display_name: string | null
  created_at: string | null
}

export async function getUser(userId: string): Promise<User | null> {
  const rows = await query<User>(
    `DECLARE $user_id AS Utf8;
     SELECT user_id, email, display_name, created_at FROM users WHERE user_id = $user_id;`,
    { $user_id: TypedValues.utf8(userId) },
  )
  const row = rows[0]
  if (!row) return null
  // Absent values are stored as '' (codebase convention, mirroring games.repo); normalize
  // back to null on read so the `string | null` contract distinguishes "no email" from a
  // genuine value.
  return {
    user_id: row.user_id,
    email: row.email || null,
    display_name: row.display_name || null,
    created_at: row.created_at || null,
  }
}

/**
 * Insert the user if new (stamping created_at), or refresh email/display_name if returning.
 * user_id = `${provider}:${sub}`. Returns the resulting row.
 */
export async function upsertUser(input: {
  userId: string
  email: string | null
  displayName: string | null
  nowIso: string
}): Promise<User> {
  const existing = await getUser(input.userId)
  if (existing) {
    await query(
      `DECLARE $user_id AS Utf8;
       DECLARE $email AS Utf8;
       DECLARE $display_name AS Utf8;
       UPSERT INTO users (user_id, email, display_name) VALUES ($user_id, $email, $display_name);`,
      {
        $user_id: TypedValues.utf8(input.userId),
        $email: TypedValues.utf8(input.email ?? ''),
        $display_name: TypedValues.utf8(input.displayName ?? ''),
      },
    )
    return { ...existing, email: input.email ?? null, display_name: input.displayName ?? null }
  }

  await query(
    `DECLARE $user_id AS Utf8;
     DECLARE $email AS Utf8;
     DECLARE $display_name AS Utf8;
     DECLARE $created_at AS Utf8;
     UPSERT INTO users (user_id, email, display_name, created_at)
     VALUES ($user_id, $email, $display_name, $created_at);`,
    {
      $user_id: TypedValues.utf8(input.userId),
      $email: TypedValues.utf8(input.email ?? ''),
      $display_name: TypedValues.utf8(input.displayName ?? ''),
      $created_at: TypedValues.utf8(input.nowIso),
    },
  )
  return {
    user_id: input.userId,
    email: input.email ?? null,
    display_name: input.displayName ?? null,
    created_at: input.nowIso,
  }
}
