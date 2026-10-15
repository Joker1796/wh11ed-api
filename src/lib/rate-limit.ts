import { createMiddleware } from 'hono/factory'
import { clientIp, makeWindowCounter } from './throttle.js'

// The ceiling over the whole API, per address (it stood in for the Yandex gateway's global limit
// when the API left Yandex on 2026-10-11). The routes keep their own, tighter fences (sign-in,
// mail, party joins); this one only stops a single address from hammering everything else: a
// client stuck in a loop, a script.
//
// Set for a tournament hall, not for one player: every phone there shares the venue's address, and
// a shared game polls every two seconds — sixty phones are ~1800 requests a minute, all legitimate.
export const RATE_LIMIT_PER_MINUTE = 2400

export function rateLimit(max = RATE_LIMIT_PER_MINUTE, windowMs = 60_000) {
  const over = makeWindowCounter(max, windowMs)
  return createMiddleware(async (c, next) => {
    // The uptime check and Docker's healthcheck must never be the ones turned away.
    if (c.req.path === '/health' || c.req.path === '/health/mail') return next()
    if (over(clientIp(c.req.header('X-Forwarded-For')), Date.now())) {
      c.header('Retry-After', String(Math.ceil(windowMs / 1000)))
      return c.json({ error: 'too_many' }, 429)
    }
    return next()
  })
}
