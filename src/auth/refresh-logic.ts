import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

// Pure refresh-token helpers, kept free of any DB / ydb-sdk imports so they're unit-testable
// without a YDB harness (the test runtime can't import the CJS ydb-sdk). sessions.ts composes
// these with the actual queries.

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function newId(): string {
  return randomBytes(16).toString('hex')
}

// Constant-time hash comparison — avoids leaking how many leading characters of the stored
// hash a guessed token matched via response timing.
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export type RefreshVerdict = 'expired' | 'mismatch' | 'ok'

/**
 * Pure decision for a refresh attempt. 'mismatch' means the presented token doesn't match the
 * stored hash (a replayed/rotated-away or stolen token), which the caller treats the same as
 * expiry: burn the session.
 */
export function evaluateRefresh(
  row: { refresh_hash: string; expires_at: Date | string | null },
  raw: string,
  nowMs: number,
): RefreshVerdict {
  const expMs = row.expires_at ? new Date(row.expires_at).getTime() : 0
  if (!expMs || expMs < nowMs) return 'expired'
  if (!hashesEqual(row.refresh_hash, hashToken(raw))) return 'mismatch'
  return 'ok'
}
