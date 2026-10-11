// Mail the owner from the server: `… | node --import tsx scripts/notify.ts "<subject>"` — the body is
// stdin. Used by deploy/backup.sh when the nightly backup fails, through the API container, which
// already holds the SMTP settings. Exit 0 = sent, 1 = not sent (the caller's log says why).
import { sendAdminMail } from '../src/mail/smtp.js'

const subject = process.argv[2] || 'wh-rules: server notice'
let body = ''
for await (const chunk of process.stdin) body += chunk
const ok = await sendAdminMail(subject, body || '(no details)')
console.log(ok ? 'notice sent' : 'notice NOT sent')
process.exit(ok ? 0 : 1)
