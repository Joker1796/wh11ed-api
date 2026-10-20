import { db } from './driver.js'
import { inpBucket } from '../domain/clientErrors.js'
import type { Channel } from './clientErrors.repo.js'

// How the site performs on visitors' phones (migrations/004_client_perf.sql): one row per day,
// site, version, screen, browser and device class, counted up.

export interface PerfHit {
  day: string
  channel: Channel
  appVersion: string
  route: string
  browser: string
  device: string
  inp?: number
  longN: number
  longMs: number
  secs: number
}

/** One more session on a screen: a new row, or the existing one counted up. */
export async function recordPerf(h: PerfHit): Promise<void> {
  const hist = [0, 0, 0, 0, 0]
  if (h.inp != null) hist[inpBucket(h.inp)] = 1
  const sql = db()
  await sql`
    INSERT INTO client_perf AS p (day, channel, app_version, route, browser, device, sessions, seconds, inp_hist, long_n, long_ms)
    VALUES (${h.day}, ${h.channel}, ${h.appVersion}, ${h.route}, ${h.browser}, ${h.device}, 1, ${h.secs}, ${sql.json(hist)}, ${h.longN}, ${h.longMs})
    ON CONFLICT (day, channel, app_version, route, browser, device) DO UPDATE SET
      sessions = p.sessions + 1,
      seconds = p.seconds + EXCLUDED.seconds,
      inp_hist = (SELECT jsonb_agg((p.inp_hist->>i)::int + (EXCLUDED.inp_hist->>i)::int ORDER BY i) FROM generate_series(0, 4) AS i),
      long_n = p.long_n + EXCLUDED.long_n,
      long_ms = p.long_ms + EXCLUDED.long_ms`
}

export interface PerfRow {
  app_version: string
  route: string
  browser: string
  device: string
  sessions: number
  seconds: number
  inp_hist: number[]
  long_n: number
  long_ms: number
}

/** Every row of a site since `since` (a date). */
export async function listPerf(channel: Channel, since: string): Promise<PerfRow[]> {
  return db()<PerfRow[]>`
    SELECT app_version, route, browser, device, sessions, seconds::int AS seconds, inp_hist, long_n::int AS long_n, long_ms::int AS long_ms
    FROM client_perf WHERE channel = ${channel} AND day >= ${since}`
}

/** Days older than `days` go. */
export async function purgePerf(days: number): Promise<number> {
  return (await db()`DELETE FROM client_perf WHERE day < (now() - make_interval(days => ${days}))::date RETURNING 1`).length
}
