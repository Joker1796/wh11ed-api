// How many accounts exist (people who signed in for sync), and how many arrived each month.
// Read-only. Needs DATABASE_URL. `npm run users:count`.
import { db } from '../src/db/driver.js'

const sql = db()
const total = await sql<{ n: string }[]>`SELECT COUNT(*) AS n FROM users`
const byMonth = await sql<{ m: string; n: string }[]>`
  SELECT substr(created_at, 1, 7) AS m, COUNT(*) AS n FROM users GROUP BY m ORDER BY m`
console.log(`users: ${total[0]?.n ?? 0}`)
for (const r of byMonth) console.log(`  ${r.m}  ${r.n}`)
process.exit(0)
