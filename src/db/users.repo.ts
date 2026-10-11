import { db } from './driver.js'

export interface User {
  user_id: string
  email: string | null
  display_name: string | null
  created_at: string | null
}

export async function getUser(userId: string): Promise<User | null> {
  const rows = await db()<User[]>`
    SELECT user_id, email, display_name, created_at FROM users WHERE user_id = ${userId}`
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
    await db()`
      UPDATE users SET email = ${input.email ?? ''}, display_name = ${input.displayName ?? ''}
      WHERE user_id = ${input.userId}`
    return { ...existing, email: input.email ?? null, display_name: input.displayName ?? null }
  }

  // ON CONFLICT: two first sign-ins racing must not fail one of them; the loser just refreshes
  // the names, which is what a returning sign-in does anyway.
  await db()`
    INSERT INTO users (user_id, email, display_name, created_at)
    VALUES (${input.userId}, ${input.email ?? ''}, ${input.displayName ?? ''}, ${input.nowIso})
    ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`
  return {
    user_id: input.userId,
    email: input.email ?? null,
    display_name: input.displayName ?? null,
    created_at: input.nowIso,
  }
}
