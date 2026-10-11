import { createHash, randomBytes } from 'node:crypto'
import { db, transaction } from './driver.js'

// Email + password logins and the one-time links mailed for them (migrations/002_password_auth.sql).

export interface PasswordLogin {
  user_id: string
  email: string
  hash: string
  verified_at: string | null
}

export async function getLoginByEmail(email: string): Promise<PasswordLogin | null> {
  const rows = await db()<PasswordLogin[]>`
    SELECT user_id, email, hash, verified_at FROM password_logins WHERE email = ${email}`
  return rows[0] ?? null
}

export async function getLoginByUser(userId: string): Promise<PasswordLogin | null> {
  const rows = await db()<PasswordLogin[]>`
    SELECT user_id, email, hash, verified_at FROM password_logins WHERE user_id = ${userId}`
  return rows[0] ?? null
}

export type CreateResult = { ok: true; userId: string } | { ok: false; reason: 'taken' }

/**
 * A new account and its email login, in one transaction. The address is unique: a second
 * registration with it is refused ("taken") — the way back for its real owner is "forgot password",
 * which mails a link only that address can open.
 */
export async function createPasswordAccount(input: {
  email: string
  hash: string
  displayName: string
  nowIso: string
}): Promise<CreateResult> {
  const userId = `u:${randomBytes(12).toString('base64url')}`
  try {
    await transaction(async (tx) => {
      await tx`INSERT INTO users (user_id, email, display_name, created_at)
               VALUES (${userId}, ${input.email}, ${input.displayName}, ${input.nowIso})`
      await tx`INSERT INTO password_logins (user_id, email, hash, verified_at, created_at, updated_at)
               VALUES (${userId}, ${input.email}, ${input.hash}, NULL, ${input.nowIso}, ${input.nowIso})`
    })
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return { ok: false, reason: 'taken' }
    throw e
  }
  return { ok: true, userId }
}

export async function setPassword(userId: string, hash: string, nowIso: string): Promise<void> {
  await db()`UPDATE password_logins SET hash = ${hash}, updated_at = ${nowIso} WHERE user_id = ${userId}`
}

export async function markVerified(userId: string, nowIso: string): Promise<void> {
  await db()`UPDATE password_logins SET verified_at = COALESCE(verified_at, ${nowIso}) WHERE user_id = ${userId}`
}

// ── One-time links ─────────────────────────────────────────────────────────────────────────────

export type TokenPurpose = 'verify' | 'reset'

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex')

/** A new link token; earlier unused tokens of the same purpose for this user stop working. */
export async function issueEmailToken(input: {
  userId: string
  email: string
  purpose: TokenPurpose
  ttlMs: number
  nowIso: string
}): Promise<string> {
  const raw = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + input.ttlMs)
  await transaction(async (tx) => {
    await tx`DELETE FROM email_tokens WHERE user_id = ${input.userId} AND purpose = ${input.purpose} AND used_at IS NULL`
    await tx`INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, used_at, expires_at)
             VALUES (${sha256(raw)}, ${input.userId}, ${input.purpose}, ${input.email}, ${input.nowIso}, NULL, ${expiresAt})`
  })
  return raw
}

/**
 * Spend a token: valid only once, before it expires, for its purpose, and only while the account's
 * login is still the address the link was sent to. Returns the user id, or null.
 */
export async function consumeEmailToken(raw: string, purpose: TokenPurpose, nowIso: string): Promise<string | null> {
  return transaction(async (tx) => {
    const rows = await tx<{ user_id: string; email: string }[]>`
      UPDATE email_tokens SET used_at = ${nowIso}
      WHERE token_hash = ${sha256(raw)} AND purpose = ${purpose} AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, email`
    const t = rows[0]
    if (!t) return null
    const login = await tx<{ email: string }[]>`SELECT email FROM password_logins WHERE user_id = ${t.user_id}`
    return login[0]?.email === t.email ? t.user_id : null
  })
}
