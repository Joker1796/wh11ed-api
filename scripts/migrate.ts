import { migrate } from '../src/db/schema.js'

// Create/verify the YDB schema. Safe to re-run (CREATE TABLE IF NOT EXISTS + idempotent TTL).
migrate()
  .then(() => {
    console.log('Schema applied.')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
