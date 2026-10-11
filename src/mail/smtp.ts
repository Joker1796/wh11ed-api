import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'

// Feedback notifications over SMTP — any relay: the provider's in production, Mailpit on the
// local stand. Everything here is OPTIONAL and best-effort by construction:
//
//   * with no SMTP host or addresses set, `sendFeedbackMail` is a no-op — a deployment without
//     mail behaves exactly as it did before the feature existed;
//   * a failure is logged and swallowed: the report is already in the database, and the
//     player must not see an error because an SMTP server was slow;
//   * the send is capped by a timeout AND an hourly ceiling: the route awaits it, so every
//     second here is a second the player waits, and a spam wave that slips past the per-IP
//     throttle must not turn into a mail flood.

const SEND_TIMEOUT_MS = 4000
const MAX_MAILS_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000
let sent: number[] = []

let transport: Transporter | null = null
function getTransport(): Transporter | null {
  if (!config.mail.enabled) return null
  if (!transport) {
    // Module-scope, like the database pool: one transport for the life of the process.
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure, // false = STARTTLS when offered, which nodemailer negotiates itself
      ...(config.mail.user ? { auth: { user: config.mail.user, pass: config.mail.pass } } : {}),
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    })
  }
  return transport
}

export interface FeedbackMail {
  feedbackId: string
  createdAt: string
  userId: string | null
  appVersion: string | null
  route: string | null
  message: string
  hasAttachment: boolean
}

function body(m: FeedbackMail): string {
  return [
    m.message,
    '',
    '—',
    `id:      ${m.feedbackId}`,
    `время:   ${m.createdAt}`,
    `кто:     ${m.userId || 'аноним'}`,
    `версия:  ${m.appVersion || '?'}`,
    `страница: ${m.route || '?'}`,
    m.hasAttachment ? 'вложение: есть (партия или ростер)' : 'вложение: нет',
    '',
    `Полностью: npm run feedback:list -- ${m.feedbackId.slice(0, 8)}`,
  ].join('\n')
}

/** Best-effort notification. Never throws, never blocks longer than SEND_TIMEOUT_MS. */
export async function sendFeedbackMail(m: FeedbackMail): Promise<void> {
  const tx = getTransport()
  if (!tx) return

  const now = Date.now()
  sent = sent.filter((t) => now - t < HOUR_MS)
  if (sent.length >= MAX_MAILS_PER_HOUR) {
    console.warn(`[feedback] mail skipped (${MAX_MAILS_PER_HOUR}/h reached); report ${m.feedbackId} is saved`)
    return
  }
  sent.push(now)

  try {
    await Promise.race([
      tx.sendMail({
        from: config.mail.from,
        to: config.mail.to,
        subject: `wh-rules: баг-репорт${m.appVersion ? ` (v${m.appVersion})` : ''}`,
        text: body(m),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('smtp timeout')), SEND_TIMEOUT_MS)),
    ])
    record(true)
  } catch (e) {
    record(false, e)
    console.error('[feedback] mail failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * A message to the owner from the server itself (scripts/notify.ts — a failed nightly backup, say).
 * Unlike a bug report it is the whole point of the run, so a failure here is reported to the
 * caller: true = handed to the relay, false = not sent (no mail configured, or the relay refused).
 */
export async function sendAdminMail(subject: string, text: string): Promise<boolean> {
  const tx = getTransport()
  if (!tx) return false
  try {
    await tx.sendMail({ from: config.mail.from, to: config.mail.to, subject, text })
    record(true)
    return true
  } catch (e) {
    record(false, e)
    console.error('[mail] admin mail failed:', e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * A letter to a player — the welcome link, a password reset. Bounded by a timeout like the rest; the
 * result is the caller's to report ("we could not send the mail, try again").
 */
export async function sendUserMail(to: string, subject: string, text: string): Promise<boolean> {
  const tx = getTransport()
  if (!tx) return false
  try {
    await Promise.race([
      tx.sendMail({ from: config.mail.from, to, subject, text }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('smtp timeout')), USER_SEND_TIMEOUT_MS)),
    ])
    record(true)
    return true
  } catch (e) {
    record(false, e)
    console.error('[mail] user mail failed:', e instanceof Error ? e.message : e)
    return false
  }
}

// ── Is mail getting out? ───────────────────────────────────────────────────────────────────────
// Every send and every probe lands here; GET /health/mail answers from it, and the uptime check at
// another company watches that endpoint — so a dead relay is reported by a channel that does not
// depend on the relay. "Delivered" is beyond reach (spam folders, bounces arrive later as mail);
// this is "the relay took it".
const USER_SEND_TIMEOUT_MS = 10_000
const FAILING_AFTER = 2
const stats = { lastOkAt: '', lastFailAt: '', consecutiveFailures: 0, lastError: '' }

function record(ok: boolean, e?: unknown) {
  const now = new Date().toISOString()
  if (ok) {
    stats.lastOkAt = now
    stats.consecutiveFailures = 0
  } else {
    stats.lastFailAt = now
    stats.consecutiveFailures++
    stats.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200)
  }
}

export function mailHealth(): { ok: boolean; enabled: boolean } & typeof stats {
  const enabled = config.mail.enabled
  return { ok: enabled && stats.consecutiveFailures < FAILING_AFTER, enabled, ...stats }
}

/** Log in to the relay without sending anything — SMTP's own "are you there". */
export async function probeMail(): Promise<void> {
  const tx = getTransport()
  if (!tx) return
  try {
    await Promise.race([
      tx.verify(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('smtp probe timeout')), USER_SEND_TIMEOUT_MS)),
    ])
    record(true)
  } catch (e) {
    record(false, e)
    console.error('[mail] probe failed:', e instanceof Error ? e.message : e)
  }
}
