// The errors visitors sent (POST /errors), production unless `--beta`. No argument: what was seen in
// the last `--days` days (7), newest first, one line each. A fingerprint prefix: that error in full —
// every version it came from, its browsers and routes, the last stack read back through the source
// maps. Needs DATABASE_URL (on the server: `docker compose … exec -T api node --import tsx scripts/errors-list.ts`).
import { errorsByPrefix, listErrors, type Channel } from '../src/db/clientErrors.repo.js'
import { decodeStack } from '../src/lib/sourcemaps.js'
import { isOpen } from '../src/domain/clientErrors.js'
import { closeDb } from '../src/db/driver.js'

const args = process.argv.slice(2)
const channel: Channel = args.includes('--beta') ? 'beta' : 'prod'
const daysArg = args.find((a) => a.startsWith('--days='))
const days = daysArg ? Number(daysArg.slice(7)) : 7
const wanted = args.find((a) => !a.startsWith('--'))
const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ')

if (wanted) {
  const rows = await errorsByPrefix(channel, wanted)
  if (!rows.length) { console.error(`No ${channel} error matching "${wanted}".`); await closeDb(); process.exit(1) }
  const r = rows[0]!
  console.log(`# ${r.fingerprint} (${channel}) — ${r.kind}\n${r.message}\n`)
  for (const v of rows) console.log(`v${v.app_version}: ×${v.count}, ${v.first_seen.toISOString()} → ${v.last_seen.toISOString()}${v.resolved_in ? `, resolved in ${v.resolved_in}` : ''}`)
  console.log(`\nbrowsers: ${top(r.browsers)}\nroutes:   ${top(r.routes)}`)
  const s = r.sample as { stack?: string | null; src?: string | null; locale?: string | null; standalone?: boolean | null; dataVersion?: number | null }
  console.log(`last: ${s.locale ?? '?'} · ${s.standalone ? 'installed app' : 'tab'} · data ${s.dataVersion ?? '?'}${s.src ? ` · ${s.src}` : ''}`)
  if (s.stack) console.log(`\n── stack (v${r.app_version}) ──\n${decodeStack(s.stack, r.app_version)}`)
} else {
  const rows = await listErrors(channel, new Date(Date.now() - days * 864e5))
  if (!rows.length) console.log(`No ${channel} errors in ${days} day(s).`)
  for (const r of rows) {
    const open = isOpen(r) ? '' : ' [resolved]'
    console.log(`${r.last_seen.toISOString().slice(0, 16)}  ${r.fingerprint.slice(0, 8)}  v${r.app_version}  ${r.kind}  ×${r.count}${open}`)
    console.log(`    ${r.message.replace(/\s+/g, ' ').slice(0, 110)}  — ${top(r.browsers).slice(0, 60)}`)
  }
  if (rows.length) console.log(`\n${rows.length} row(s). Full view: errors-list <fingerprint-prefix>${channel === 'beta' ? ' --beta' : ''}`)
}
await closeDb()
