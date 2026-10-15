// A best-effort fixed-window counter in process memory: `max` hits per key per window,
// the key being whatever the caller wants to fence (an IP, a member token). An abuse fence, not
// an accounting system — a restart forgets, and the API-wide ceiling (rate-limit.ts) backs it up.
// The same recipe the broadcast and feedback routes carry inline; new fences use this one.
export function makeThrottle(max: number, windowMs: number): (key: string, now: number) => boolean {
  const hits = new Map<string, number[]>()
  return (key, now) => {
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs)
    if (recent.length >= max) {
      hits.set(key, recent)
      return true
    }
    recent.push(now)
    hits.set(key, recent)
    if (hits.size > 10000) hits.clear() // the map only grows on distinct keys; sweep when silly
    return false
  }
}

/** The client's address as the proxy reports it (Caddy overwrites X-Forwarded-For). */
export function clientIp(forwardedFor: string | undefined): string {
  return (forwardedFor || '').split(',')[0]?.trim() || 'unknown'
}

/**
 * A fixed-window count per key: `max` hits per window, O(1) per hit — for a ceiling high enough that
 * keeping every timestamp, as makeThrottle does, would cost real memory. Coarser at the window edge
 * (a burst can straddle two windows), which a ceiling this far above normal use can afford.
 */
export function makeWindowCounter(max: number, windowMs: number): (key: string, now: number) => boolean {
  const windows = new Map<string, { start: number; count: number }>()
  return (key, now) => {
    let w = windows.get(key)
    if (!w || now - w.start >= windowMs) {
      if (windows.size > 10000) windows.clear()
      w = { start: now, count: 0 }
      windows.set(key, w)
    }
    w.count++
    return w.count > max
  }
}
