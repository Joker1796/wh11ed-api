import { Hono } from 'hono'
import { ZodError } from 'zod'
import { ClientErrorsTooLarge, browserOf, fingerprint, normalizeRoute, parseClientErrors } from '../domain/clientErrors.js'
import { countReporter, recordError } from '../db/clientErrors.repo.js'

// POST /errors — what the site's visitors ran into, from those who switched sending on (it is off
// by default; the site asks a signed-in player once, after an error). Public: no account, no token,
// nothing about the sender is stored. The site sends `text/plain` with `fetch(keepalive)` and no
// credentials, a CORS "simple request", so the call survives the tab closing and needs no preflight.
export const clientErrorRoutes = new Hono()

// The same in-memory throttle as /feedback: an abuse fence, not accounting. A browser sends a
// batch at most every few seconds and ten errors per batch, so 30 batches in ten minutes is far
// above any real page.
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_WINDOW = 30
const recent = new Map<string, number[]>()
function throttled(ip: string, now: number): boolean {
  const hits = (recent.get(ip) || []).filter((t) => now - t < WINDOW_MS)
  if (hits.length >= MAX_PER_WINDOW) {
    recent.set(ip, hits)
    return true
  }
  hits.push(now)
  recent.set(ip, hits)
  if (recent.size > 10000) recent.clear()
  return false
}

clientErrorRoutes.post('/', async (c) => {
  const now = new Date()
  const ip = (c.req.header('X-Forwarded-For') || '').split(',')[0]?.trim() || 'unknown'
  if (throttled(ip, now.getTime())) return c.json({ error: 'too_many' }, 429)
  let payload
  try {
    payload = parseClientErrors(await c.req.text())
  } catch (e) {
    if (e instanceof ClientErrorsTooLarge) return c.json({ error: 'payload_too_large' }, 413)
    if (e instanceof ZodError || e instanceof SyntaxError) return c.json({ error: 'invalid_errors' }, 422)
    throw e
  }
  const at = now.toISOString()
  const browser = browserOf(c.req.header('User-Agent'))
  const route = normalizeRoute(payload.route)
  if (payload.hello) await countReporter(payload.channel, at.slice(0, 10))
  for (const e of payload.errors) {
    await recordError(payload.channel, {
      fingerprint: fingerprint(e),
      appVersion: payload.appVersion,
      kind: e.kind,
      message: e.msg,
      sample: { stack: e.stack ?? null, src: e.src ?? null, route, locale: payload.locale ?? null, standalone: payload.standalone ?? null, dataVersion: payload.dataVersion ?? null },
      browser,
      route,
      at,
    })
  }
  return c.body(null, 204)
})
