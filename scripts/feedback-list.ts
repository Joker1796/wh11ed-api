// The feedback inbox: prints recent bug reports, newest first. Needs the same YDB env as
// `npm run migrate` (`YDB_ENDPOINT`/`YDB_DATABASE` + `YDB_ACCESS_TOKEN` from `yc iam
// create-token`). `npm run feedback:list` for the digest; add an id argument to dump one
// report in full (context, errors, attachment).
import { listFeedback } from '../src/db/feedback.repo.js'

const wanted = process.argv[2] || null

const rows = await listFeedback(wanted ? 500 : 50)
if (!rows.length) {
  console.log('No feedback yet.')
  process.exit(0)
}

if (wanted) {
  const row = rows.find((r) => r.feedback_id === wanted || r.feedback_id.startsWith(wanted))
  if (!row) {
    console.error(`No report matching "${wanted}" in the latest 500.`)
    process.exit(1)
  }
  console.log(`# ${row.feedback_id}`)
  console.log(`date:    ${row.created_at}`)
  console.log(`user:    ${row.user_id || '(anonymous)'}`)
  console.log(`version: ${row.app_version || '?'}   route: ${row.route || '?'}`)
  console.log(`\n${row.message}\n`)
  if (row.context) console.log('── context ──\n' + JSON.stringify(JSON.parse(row.context), null, 2))
  if (row.attachment) console.log('── attachment ──\n' + JSON.stringify(JSON.parse(row.attachment), null, 2))
  process.exit(0)
}

for (const r of rows) {
  const oneLine = (r.message || '').replace(/\s+/g, ' ').slice(0, 100)
  const who = r.user_id ? 'user' : 'anon'
  console.log(`${r.created_at}  ${r.feedback_id.slice(0, 8)}  ${who}  v${r.app_version || '?'}  ${r.route || '?'}`)
  console.log(`    ${oneLine}${(r.message || '').length > 100 ? '…' : ''}`)
}
console.log(`\n${rows.length} report(s). Full view: npm run feedback:list -- <id-prefix>`)
process.exit(0)
