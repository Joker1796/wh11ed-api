// How the site performs on visitors' phones (POST /errors `perf`, migrations/004_client_perf.sql),
// production unless `--beta`, the last `--days` days (7). The site sends only screens that looked
// wrong (a tap of 200 ms or more, or long tasks over 2% of the time), once a day per browser, so a
// row counts slow sessions; the daily hellos of the reporting browsers are the denominator.
// One line per screen: sessions, the p75 of
// the slowest tap-to-paint, the share of sessions whose slowest tap took 200 ms or more, and the
// long tasks per visible minute. `--by=browser|device|version` splits each screen further.
// Needs DATABASE_URL (on the server: `docker compose … exec -T api node --import tsx scripts/perf-list.ts`).
import { listPerf, type PerfRow } from '../src/db/clientPerf.repo.js'
import type { Channel } from '../src/db/clientErrors.repo.js'
import { p75Bucket } from '../src/domain/clientErrors.js'
import { closeDb, db } from '../src/db/driver.js'

const args = process.argv.slice(2)
const channel: Channel = args.includes('--beta') ? 'beta' : 'prod'
const days = Number(args.find((a) => a.startsWith('--days='))?.slice(7) ?? 7)
const by = args.find((a) => a.startsWith('--by='))?.slice(5) as 'browser' | 'device' | 'version' | undefined
const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)

const rows = await listPerf(channel, since)
const groups = new Map<string, PerfRow & { key: string }>()
for (const r of rows) {
  const sub = by === 'browser' ? r.browser : by === 'device' ? r.device : by === 'version' ? r.app_version : ''
  const key = sub ? `${r.route}  [${sub}]` : r.route
  const g = groups.get(key) ?? { ...r, key, sessions: 0, seconds: 0, inp_hist: [0, 0, 0, 0, 0], long_n: 0, long_ms: 0 }
  g.sessions += r.sessions
  g.seconds += r.seconds
  g.long_n += r.long_n
  g.long_ms += r.long_ms
  g.inp_hist = g.inp_hist.map((n, i) => n + (r.inp_hist[i] ?? 0))
  groups.set(key, g)
}
if (!groups.size) console.log(`No ${channel} performance data in ${days} day(s).`)
const list = [...groups.values()].sort((a, b) => b.sessions - a.sessions)
for (const g of list) {
  const taps = g.inp_hist.reduce((s, n) => s + n, 0)
  const slow = taps ? Math.round((100 * (g.inp_hist[2]! + g.inp_hist[3]! + g.inp_hist[4]!)) / taps) : 0
  const perMin = g.seconds ? ((g.long_ms / g.seconds) * 60) / 1000 : 0
  console.log(`${g.key.padEnd(48)} ${String(g.sessions).padStart(5)} sess  p75 tap ${(p75Bucket(g.inp_hist) ?? '—').padStart(6)} ms  slow ${String(slow).padStart(3)}%  long tasks ${perMin.toFixed(1)} s/min`)
}
const [rep] = await db()<{ n: number }[]>`SELECT COALESCE(SUM(sessions), 0)::int AS n FROM client_error_reporters WHERE channel = ${channel} AND day >= ${since}`
if (list.length) console.log(`\n${list.reduce((s, g) => s + g.sessions, 0)} slow session(s) since ${since}, out of ${rep?.n ?? 0} reporting browser-days. Slow tap = ≥200 ms.`)
await closeDb()
