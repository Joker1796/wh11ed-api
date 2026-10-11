import { db } from './driver.js'

// What YDB's TTL did on its own: drop the rows whose `expires_at` has passed — sessions, live
// broadcasts and the three party tables. YDB swept lazily (hours late was normal), so nothing
// relies on promptness; the one read where a stale row would matter, the public broadcast token,
// checks `expires_at` itself (broadcasts.repo.ts).
const TABLES = ['sessions', 'broadcasts', 'party_state', 'party_members', 'parties'] as const

export async function sweepExpired(): Promise<Record<string, number>> {
  const sql = db()
  const out: Record<string, number> = {}
  for (const table of TABLES) {
    const res = await sql`DELETE FROM ${sql(table)} WHERE expires_at < now()`
    out[table] = res.count
  }
  return out
}

const EVERY_MS = 10 * 60 * 1000

/** Sweep now and then every ten minutes. A failed sweep is logged and tried again next time. */
export function startSweeper(): () => void {
  const run = () =>
    sweepExpired()
      .then((n) => {
        const total = Object.values(n).reduce((a, b) => a + b, 0)
        if (total) console.log('[sweep] removed expired rows', n)
      })
      .catch((e) => console.error('[sweep] failed:', e instanceof Error ? e.message : e))
  void run()
  const timer = setInterval(run, EVERY_MS)
  timer.unref()
  return () => clearInterval(timer)
}
