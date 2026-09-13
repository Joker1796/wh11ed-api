import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { ZodError } from 'zod'
import { verifyAccessToken } from '../auth/jwt.js'
import { parseFeedback, FeedbackPayloadError } from '../domain/feedback.js'
import { insertFeedback } from '../db/feedback.repo.js'

// Bug reports. Public on purpose — requiring an account would silence the players most worth
// hearing from; a Bearer that happens to ride along is verified and recorded, nothing more.
// Reports are read by a human via `npm run feedback:list`; nothing serves them back out.
export const feedbackRoutes = new Hono()

// Best-effort per-IP throttle in warm-instance memory: enough against a casual flood without
// a table or a captcha (the gateway's global rate limit backs it up; a cold start forgets —
// acceptable for an abuse fence, wrong for anything stronger).
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_WINDOW = 5
const recent = new Map<string, number[]>()
function throttled(ip: string, now: number): boolean {
  const hits = (recent.get(ip) || []).filter((t) => now - t < WINDOW_MS)
  if (hits.length >= MAX_PER_WINDOW) {
    recent.set(ip, hits)
    return true
  }
  hits.push(now)
  recent.set(ip, hits)
  // The map only ever grows on distinct IPs; sweep it when it gets silly.
  if (recent.size > 10000) recent.clear()
  return false
}

feedbackRoutes.post('/', async (c) => {
  const now = Date.now()
  const ip = (c.req.header('X-Forwarded-For') || '').split(',')[0]?.trim() || 'unknown'
  if (throttled(ip, now)) return c.json({ error: 'too_many' }, 429)

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  let fb
  try {
    fb = parseFeedback(raw)
  } catch (e) {
    if (e instanceof FeedbackPayloadError) return c.json({ error: 'payload_too_large' }, 413)
    if (e instanceof ZodError) return c.json({ error: 'invalid_feedback' }, 422)
    throw e
  }
  // The honeypot field was filled: a bot. Pretend success — a 4xx would only teach it.
  if (fb.isSpam) return c.json({ ok: true })

  // Optional identity: verify a Bearer if one rode along, ignore it if it did not or is stale.
  let userId: string | null = null
  const auth = c.req.header('Authorization')
  if (auth?.startsWith('Bearer ')) {
    const claims = await verifyAccessToken(auth.slice('Bearer '.length))
    userId = claims?.sub ?? null
  }

  await insertFeedback({
    feedbackId: randomUUID(),
    createdAt: new Date(now).toISOString(),
    userId,
    appVersion: fb.appVersion,
    route: fb.route,
    message: fb.message,
    contextJson: fb.contextJson,
    attachmentJson: fb.attachmentJson,
  })
  return c.json({ ok: true })
})
