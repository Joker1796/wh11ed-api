import { executeScheme } from './driver.js'

// Idempotent schema. Run once after provisioning (`tsx scripts/migrate.ts`, or the deploy
// script). YDB DDL is executed via scheme queries, one statement at a time.
//
// JSON payloads and ISO timestamps are stored as Utf8 (we never query inside them server-side,
// so a plain string column is simplest and avoids type-coercion surprises). Only
// sessions.expires_at is a real Timestamp because the TTL sweeper needs it.

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     user_id Utf8 NOT NULL,
     email Utf8,
     display_name Utf8,
     created_at Utf8,
     PRIMARY KEY (user_id)
   );`,

  `CREATE TABLE IF NOT EXISTS games (
     user_id Utf8 NOT NULL,
     game_id Utf8 NOT NULL,
     blob Utf8,
     created_at Utf8,
     finished_at Utf8,
     result_summary Utf8,
     players Utf8,
     updated_at Utf8,
     PRIMARY KEY (user_id, game_id)
   );`,

  `CREATE TABLE IF NOT EXISTS sessions (
     session_id Utf8 NOT NULL,
     user_id Utf8,
     refresh_hash Utf8,
     created_at Utf8,
     expires_at Timestamp,
     PRIMARY KEY (session_id),
     INDEX idx_sessions_user GLOBAL ON (user_id)
   );`,

  // TTL: expired sessions are purged automatically by YDB.
  `ALTER TABLE sessions SET (TTL = Interval("PT0S") ON expires_at);`,
]

export async function migrate(): Promise<void> {
  for (const stmt of STATEMENTS) {
    await executeScheme(stmt)
  }
}
