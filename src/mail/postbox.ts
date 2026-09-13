import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'

// Feedback notifications through Yandex Cloud Postbox (SMTP): the API key's id is the
// username, its secret the password, and the From address must be an identity verified in
// Postbox. Everything here is OPTIONAL and best-effort by construction:
//
//   * with no credentials bound, `sendFeedbackMail` is a no-op — a deployment without the
//     Lockbox secret behaves exactly as it did before the feature existed;
//   * a failure is logged and swallowed: the report is already in the database, and the
//     player must not see an error because an SMTP server was slow;
//   * the send is capped by a timeout AND an hourly ceiling, because a serverless function
//     has no "after the response" — every second here is a second the player waits, and a
//     spam wave that slips past the per-IP throttle must not turn into a mail flood.

const SEND_TIMEOUT_MS = 4000
const MAX_MAILS_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000
let sent: number[] = []

let transport: Transporter | null = null
function getTransport(): Transporter | null {
  if (!config.mail.enabled) return null
  if (!transport) {
    // Module-scope, like the YDB driver: a warm invocation reuses the connection pool.
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: false, // STARTTLS on 587, which nodemailer negotiates itself
      auth: { user: config.mail.keyId, pass: config.mail.secret },
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
  } catch (e) {
    console.error('[feedback] mail failed:', e instanceof Error ? e.message : e)
  }
}
