import { readdir, readFile } from 'node:fs/promises'
import { db } from './driver.js'

// Migrations are plain SQL files in /migrations, applied in name order, each once, each in its own
// transaction (Postgres runs DDL transactionally, so a file either lands whole or not at all). The
// `schema_migrations` table remembers which ran. A change to the schema is a NEW file — never an
// edit to one that has already run somewhere, because nothing would re-apply it there.
const DIR = new URL('../../migrations/', import.meta.url)

export async function migrate(): Promise<string[]> {
  const sql = db()
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name))
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const name of files) {
    if (done.has(name)) continue
    const text = await readFile(new URL(name, DIR), 'utf8')
    await sql.begin(async (tx) => {
      await tx.unsafe(text)
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`
    })
    applied.push(name)
  }
  return applied
}
