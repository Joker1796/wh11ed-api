// Mark an error fixed: `errors-resolve <fingerprint-prefix> <version> [--beta]`. Every row of it is
// stamped; one sent later by a NEWER version counts as open again in the list and the digest.
import { errorsByPrefix, resolveErrors, type Channel } from '../src/db/clientErrors.repo.js'
import { closeDb } from '../src/db/driver.js'

const args = process.argv.slice(2)
const channel: Channel = args.includes('--beta') ? 'beta' : 'prod'
const [prefix, version] = args.filter((a) => !a.startsWith('--'))
if (!prefix || !version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: errors-resolve <fingerprint-prefix> <version, e.g. 2.9.2> [--beta]')
  process.exit(1)
}
const fps = [...new Set((await errorsByPrefix(channel, prefix)).map((r) => r.fingerprint))]
if (fps.length !== 1) {
  console.error(fps.length ? `"${prefix}" matches ${fps.length} errors — longer prefix` : `No ${channel} error matching "${prefix}".`)
  await closeDb()
  process.exit(1)
}
console.log(`${fps[0]}: ${await resolveErrors(channel, fps[0]!, version)} row(s) resolved in ${version}`)
await closeDb()
