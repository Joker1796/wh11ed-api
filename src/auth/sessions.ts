import { db } from '../db/driver.js'
import { config } from '../config.js'
import { hashToken, newToken, newId, evaluateRefresh } from './refresh-logic.js'

// Refresh tokens are opaque random strings. We store only their SHA-256 hash, and rotate the
// token on every refresh (single-use). The raw token lives only in the client's HttpOnly cookie.
// The pure crypto/decision helpers live in ./refresh-logic.ts so they're unit-testable.

export interface SessionRow {
  session_id: string
  user_id: string
  refresh_hash: string
  expires_at: Date | string | null
}

export async function createSession(userId: string): Promise<string> {
  const sessionId = newId()
  const raw = newToken()
  const nowIso = new Date().toISOString()
  const expiresAt = new Date(Date.now() + config.refreshTokenTtl * 1000)
  await db()`
    INSERT INTO sessions (session_id, user_id, refresh_hash, created_at, expires_at)
    VALUES (${sessionId}, ${userId}, ${hashToken(raw)}, ${nowIso}, ${expiresAt})`
  // Cookie value carries both the session id and the secret, so refresh is an O(1) PK lookup.
  return `${sessionId}.${raw}`
}

/**
 * Validate a refresh-cookie value and rotate it. Returns the user id + the NEW cookie value,
 * or null if invalid/expired. On detected reuse of an already-rotated token the session is
 * destroyed (defence against stolen refresh tokens).
 */
export async function rotateSession(
  cookieValue: string,
): Promise<{ userId: string; newCookie: string } | null> {
  const dot = cookieValue.indexOf('.')
  if (dot < 0) return null
  const sessionId = cookieValue.slice(0, dot)
  const raw = cookieValue.slice(dot + 1)
  if (!sessionId || !raw) return null

  const rows = await db()<SessionRow[]>`
    SELECT session_id, user_id, refresh_hash, expires_at FROM sessions WHERE session_id = ${sessionId}`
  const row = rows[0]
  if (!row) return null

  if (evaluateRefresh(row, raw, Date.now()) !== 'ok') {
    // Expired, or the token doesn't match the current secret (likely a replayed/stolen old
    // token) → burn the session.
    await destroySession(sessionId)
    return null
  }

  // Rotate: new secret, same session id, extended expiry.
  const newRaw = newToken()
  const expiresAt = new Date(Date.now() + config.refreshTokenTtl * 1000)
  await db()`
    UPDATE sessions SET refresh_hash = ${hashToken(newRaw)}, expires_at = ${expiresAt}
    WHERE session_id = ${sessionId}`
  return { userId: row.user_id, newCookie: `${sessionId}.${newRaw}` }
}

export async function destroySessionByCookie(cookieValue: string): Promise<void> {
  const dot = cookieValue.indexOf('.')
  const sessionId = dot < 0 ? cookieValue : cookieValue.slice(0, dot)
  if (sessionId) await destroySession(sessionId)
}

/** Every session of a user ends — after a password reset, so a thief's device is signed out too. */
export async function destroyUserSessions(userId: string): Promise<void> {
  await db()`DELETE FROM sessions WHERE user_id = ${userId}`
}

export async function destroySession(sessionId: string): Promise<void> {
  await db()`DELETE FROM sessions WHERE session_id = ${sessionId}`
}
