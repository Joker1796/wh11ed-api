// The database tests run against a real PostgreSQL — the stand's, in a database of their own
// (`<name>_test`), so a run never touches the data a developer seeded by hand. Imported first by
// every file in test/db: it points DATABASE_URL at the test database (creating it the first time)
// before any repo opens the pool, and gives each test a clean schema.
//
//   npm run stand:test    inside the stand's api container (DATABASE_URL already set there)
import postgres from 'postgres'

const base = process.env.DATABASE_URL
if (!base) {
  console.error('test/db needs DATABASE_URL — run it as `npm run stand:test` with the stand up.')
  process.exit(2)
}
const url = new URL(base)
const testDb = `${url.pathname.slice(1) || 'postgres'}_test`

const admin = postgres(base, { max: 1, onnotice: () => {} })
const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${testDb}`
if (!exists.length) await admin.unsafe(`CREATE DATABASE "${testDb}"`)
await admin.end()

url.pathname = `/${testDb}`
process.env.DATABASE_URL = url.toString()
process.env.REFRESH_TOKEN_TTL_SECONDS ??= '3600'
process.env.JWT_SIGNING_KEY ??= 'test-key-000000000000000000000000'

const { db } = await import('../../src/db/driver.js')
const { migrate } = await import('../../src/db/schema.js')

/** Drop everything and migrate from nothing — each test starts from the schema a fresh deploy has. */
export async function freshSchema(): Promise<void> {
  await db().unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await migrate()
}

export { db }
export { closeDb } from '../../src/db/driver.js'
