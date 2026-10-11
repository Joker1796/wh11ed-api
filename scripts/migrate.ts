import { migrate } from '../src/db/schema.js'

// Apply the SQL files in /migrations that have not run yet. Safe to re-run: what ran is recorded
// in `schema_migrations`. Needs DATABASE_URL (the stand's compose file sets it).
migrate()
  .then((applied) => {
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is up to date.')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
