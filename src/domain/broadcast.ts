import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config.js'

// A broadcast payload is OPAQUE, like the game blob: the client projects the read-only
// scoreboard (whitelisted fields only — teams, round, CP, VP) and owns its shape; the server
// stores and serves it verbatim. We validate only that it is a JSON object and fits the cap.

// 128 bits of randomness, URL-safe. Unguessable is the whole security model of the public GET —
// the link is the credential, exactly like an unlisted share link.
export function newBroadcastToken(): string {
  return randomBytes(16).toString('base64url')
}

export const broadcastTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)

const payloadSchema = z.object({}).passthrough()

export class BroadcastPayloadError extends Error {}

/** Parse + validate a raw broadcast payload, enforcing the byte cap. Returns the canonical string. */
export function parseBroadcastPayload(raw: unknown): { json: string } {
  const payload = payloadSchema.parse(raw)
  const json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') > config.maxBroadcastBytes) {
    throw new BroadcastPayloadError(`Broadcast payload exceeds ${config.maxBroadcastBytes} bytes`)
  }
  return { json }
}

/** TTL horizon for a broadcast row, from "now": pushed forward by every enable/update. */
export function broadcastExpiry(now = Date.now()): Date {
  return new Date(now + config.broadcastTtlDays * 24 * 60 * 60 * 1000)
}
