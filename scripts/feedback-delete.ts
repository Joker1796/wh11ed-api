// Clear dealt-with reports out of the feedback inbox. Same YDB env as `npm run feedback:list`.
//   npm run feedback:delete -- <id-prefix> [<id-prefix> …]
// Each prefix must match exactly one of the latest 500 reports (the 8-character prefix the digest
// prints is enough); an ambiguous or unknown prefix stops the run before anything is deleted.
// Deletion is final — the verdict belongs in the changelog / the hub journal before this runs.
import { deleteFeedback, listFeedback } from '../src/db/feedback.repo.js'

const prefixes = process.argv.slice(2)
if (!prefixes.length) {
  console.error('usage: npm run feedback:delete -- <id-prefix> [<id-prefix> …]')
  process.exit(2)
}

const rows = await listFeedback(500)
const ids: string[] = []
for (const p of prefixes) {
  const hits = rows.filter((r) => r.feedback_id === p || r.feedback_id.startsWith(p))
  const [hit] = hits
  if (!hit || hits.length > 1) {
    console.error(hit ? `"${p}" matches ${hits.length} reports — give more of the id.` : `No report matching "${p}" in the latest 500.`)
    process.exit(1)
  }
  ids.push(hit.feedback_id)
}

const removed = await deleteFeedback(ids)
for (const id of removed) {
  const r = rows.find((x) => x.feedback_id === id)!
  console.log(`deleted ${id.slice(0, 8)}  ${r.created_at}  ${(r.message || '').replace(/\s+/g, ' ').slice(0, 60)}`)
}
console.log(`${removed.length} report(s) deleted, ${rows.length - removed.length} left.`)
process.exit(0)
