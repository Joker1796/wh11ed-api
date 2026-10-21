// The errors' mail, production and the beta apart (owner, 2026-10-14). Run from cron on the server:
//   errors-digest            once a day: what is open and was seen in the last 24 hours — new ones
//                            first — with the day's reporting browsers; no mail on a quiet day.
//                            Also drops rows quiet for 30 days (the owner's retention).
//   errors-digest --watch    every 10 minutes: the release watch — an error the current version
//                            brought, seen 3+ times within 2 hours of that version's first report,
//                            mailed at once, once.
// `--dry-run` prints instead of mailing.
import { compareVersions, isOpen } from '../src/domain/clientErrors.js'
import { fingerprintsBefore, listErrors, markAlerted, purgeErrors, reporters, versionStart, type Channel, type ErrorRow } from '../src/db/clientErrors.repo.js'
import { purgePerf } from '../src/db/clientPerf.repo.js'
import { decodeStack } from '../src/lib/sourcemaps.js'
import { sendAdminMail } from '../src/mail/smtp.js'
import { closeDb } from '../src/db/driver.js'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const CHANNELS: Channel[] = ['prod', 'beta']
const NAME: Record<Channel, string> = { prod: 'сайт', beta: 'бета' }
const PERF_RETENTION_DAYS = 90
const RETENTION_DAYS = 30
const WATCH_MS = 2 * 3600e3
const WATCH_COUNT = 3

const top = (o: Record<string, number>, n = 3) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ×${v}`).join(', ')
const firstFrame = (r: ErrorRow) => {
  const stack = (r.sample as { stack?: string | null }).stack
  if (!stack) return ''
  const line = decodeStack(stack, r.app_version).split('\n').find((l) => /:\d+:\d+/.test(l))
  return line ? `\n      ${line.trim().slice(0, 160)}` : ''
}
const describe = (r: ErrorRow) =>
  `  ${r.fingerprint.slice(0, 8)}  v${r.app_version}  ${r.kind}  ×${r.count}\n      ${r.message.replace(/\s+/g, ' ').slice(0, 160)}\n      ${top(r.browsers)} · ${top(r.routes, 2)}${firstFrame(r)}`

async function send(subject: string, text: string) {
  if (dry) { console.log(`── ${subject} ──\n${text}\n`); return }
  console.log(await sendAdminMail(subject, text) ? `mailed: ${subject}` : `NOT mailed: ${subject}`)
}

if (args.includes('--watch')) {
  const now = new Date()
  for (const ch of CHANNELS) {
    const recent = await listErrors(ch, new Date(now.getTime() - WATCH_MS))
    if (!recent.length) continue
    const current = recent.map((r) => r.app_version).sort(compareVersions).pop()!
    const start = await versionStart(ch, current)
    if (!start || now.getTime() - start.getTime() > WATCH_MS) continue
    const before = await fingerprintsBefore(ch, current)
    const hits = recent.filter((r) => r.app_version === current && r.count >= WATCH_COUNT && !r.alerted_at && !before.has(r.fingerprint) && isOpen(r))
    if (!hits.length) continue
    await send(`[WH Rules] ${NAME[ch]} v${current}: новая ошибка после выката`,
      `Ошибки, которых не было до v${current}, у ${WATCH_COUNT}+ посетителей за первые 2 часа:\n\n${hits.map(describe).join('\n\n')}\n\nПодробно: errors-list <отпечаток>${ch === 'beta' ? ' --beta' : ''}`)
    if (!dry) for (const r of hits) await markAlerted(ch, r.fingerprint, r.app_version, now)
  }
} else {
  const since = new Date(Date.now() - 24 * 3600e3)
  const yesterday = since.toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  const parts: string[] = []
  let total = 0
  for (const ch of CHANNELS) {
    const rows = (await listErrors(ch, since)).filter(isOpen)
    if (!rows.length) continue
    total += rows.length
    const fresh = rows.filter((r) => r.first_seen >= since)
    const old = rows.filter((r) => r.first_seen < since)
    const who = (await reporters(ch, yesterday)) + (await reporters(ch, today))
    parts.push(`══ ${NAME[ch]} — ${rows.length} ошиб., отправку включили ~${who} сеанс(ов) за сутки ══` +
      (fresh.length ? `\n\nНовые:\n${fresh.map(describe).join('\n\n')}` : '') +
      (old.length ? `\n\nЕщё случаются:\n${old.map(describe).join('\n\n')}` : ''))
  }
  if (total) await send(`[WH Rules] Ошибки на сайте: ${total}`, `${parts.join('\n\n')}\n\nПодробно: errors-list <отпечаток> [--beta] · исправлено: errors-resolve <отпечаток> <версия>`)
  else console.log('no open errors in 24 hours')
  if (!dry) console.log(`purged ${await purgeErrors(RETENTION_DAYS)} row(s) older than ${RETENTION_DAYS} days`)
  // Performance is read as a trend across releases, so it keeps three months (client_perf).
  if (!dry) console.log(`purged ${await purgePerf(PERF_RETENTION_DAYS)} perf row(s) older than ${PERF_RETENTION_DAYS} days`)
}
await closeDb()
