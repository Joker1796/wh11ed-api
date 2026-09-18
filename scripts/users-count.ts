// How many accounts exist (people who signed in through Yandex for sync), and how many arrived
// each month. Read-only. Needs the same YDB env as `npm run migrate` (`YDB_ENDPOINT`/
// `YDB_DATABASE` + `YDB_ACCESS_TOKEN` from `yc iam create-token`). `npm run users:count`.
import { query } from '../src/db/driver.js'

const total = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM users;`, {})
const byMonth = await query<{ m: string; n: number }>(
  `SELECT m, COUNT(*) AS n
   FROM (SELECT SUBSTRING(CAST(created_at AS String), 0u, 7u) AS m FROM users)
   GROUP BY m ORDER BY m;`,
  {},
)
console.log(`users: ${total[0]?.n ?? 0}`)
for (const r of byMonth) console.log(`  ${String(r.m)}  ${r.n}`)
process.exit(0)
