// A best-effort fixed-window counter in warm-instance memory: `max` hits per key per window,
// the key being whatever the caller wants to fence (an IP, a member token). An abuse fence, not
// an accounting system — a cold start forgets, and the gateway's global rate limit backs it up.
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

/** The client's address as the gateway reports it. */
export function clientIp(forwardedFor: string | undefined): string {
  return (forwardedFor || '').split(',')[0]?.trim() || 'unknown'
}
