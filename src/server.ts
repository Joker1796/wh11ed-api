import { serve } from '@hono/node-server'
import { app } from './app.js'
import { closeDb } from './db/driver.js'
import { startSweeper } from './db/sweep.js'
import { probeMail } from './mail/smtp.js'

// The API as a long-lived Node process — the local stand and production alike (since the move off
// Yandex Cloud Functions, 2026-10-11). `npm run dev` loads .env and watches; production runs the
// same file under `npm start`.
const port = Number(process.env.PORT ?? 8787)
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`wh11ed-api on http://localhost:${info.port}`)
})
const stopSweeper = startSweeper()
// Ask the mail relay "are you there" now and every 30 min, so /health/mail knows even on a day
// nobody sends anything.
void probeMail()
const mailProbe = setInterval(() => void probeMail(), 30 * 60 * 1000)
mailProbe.unref()

// docker stop sends SIGTERM: finish what is in flight, close the pool, leave.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopSweeper()
    clearInterval(mailProbe)
    server.close(() => {
      void closeDb().finally(() => process.exit(0))
    })
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
