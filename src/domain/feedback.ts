import { z } from 'zod'
import { config } from '../config.js'

// A bug report: the player's text plus two opaque blobs — the client-collected tech context
// (app/data version, route, UA, recent JS errors) and an optional roster/game snapshot the
// player explicitly ticked on. Like the game blob, the internals belong to the client; we
// validate only shape and size. `website` is the honeypot: a real form never fills it, so a
// non-empty value marks the sender as a bot (the route pretends success and drops it).

const feedbackSchema = z.object({
  message: z.string().min(1),
  context: z.object({}).passthrough().optional(),
  attachment: z.object({}).passthrough().optional(),
  website: z.string().optional(),
})

export class FeedbackPayloadError extends Error {}

export interface ParsedFeedback {
  message: string
  contextJson: string | null
  attachmentJson: string | null
  appVersion: string | null
  route: string | null
  isSpam: boolean
}

function capped(value: unknown, cap: number, what: string): string | null {
  if (value == null) return null
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > cap) {
    throw new FeedbackPayloadError(`${what} exceeds ${cap} bytes`)
  }
  return json
}

export function parseFeedback(raw: unknown): ParsedFeedback {
  const fb = feedbackSchema.parse(raw)
  if (Buffer.byteLength(fb.message, 'utf8') > config.maxFeedbackMessageBytes) {
    throw new FeedbackPayloadError(`message exceeds ${config.maxFeedbackMessageBytes} bytes`)
  }
  const contextJson = capped(fb.context, config.maxFeedbackContextBytes, 'context')
  const attachmentJson = capped(fb.attachment, config.maxFeedbackAttachmentBytes, 'attachment')
  const ctx = (fb.context ?? {}) as Record<string, unknown>
  return {
    message: fb.message,
    contextJson,
    attachmentJson,
    // Two fields denormalized for the human list view; the full truth stays in contextJson.
    appVersion: typeof ctx.appVersion === 'string' ? ctx.appVersion.slice(0, 32) : null,
    route: typeof ctx.route === 'string' ? ctx.route.slice(0, 200) : null,
    isSpam: !!fb.website,
  }
}
