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

  // Army lists. Same blob-plus-envelope shape as `games`; `updated_at` is the CLIENT's epoch-ms
  // timestamp (kept as Utf8 like every other value here) because last-write-wins compares on it,
  // while `server_updated_at` is only for diagnostics.
  //
  // `deleted_at` makes a delete a TOMBSTONE rather than a disappearance: the row stays, emptied,
  // and the list endpoint reports it so a second device learns the list is gone instead of
  // re-uploading its own copy. Empty string = live. It is the client's epoch-ms clock too, so it
  // is directly comparable with a roster's `updated_at` — that comparison is what lets a list
  // saved AFTER the delete win and come back. Old tombstones are swept on the next delete
  // (rosters.repo.ts), so no TTL column is needed.
  `CREATE TABLE IF NOT EXISTS rosters (
     user_id Utf8 NOT NULL,
     roster_id Utf8 NOT NULL,
     blob Utf8,
     name Utf8,
     faction Utf8,
     updated_at Utf8,
     points Utf8,
     unit_count Utf8,
     deleted_at Utf8,
     server_updated_at Utf8,
     PRIMARY KEY (user_id, roster_id)
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

  // Live-game broadcast (the OBS overlay). One row per (user, game): a random public read
  // token, the client-projected read-only payload, and a real Timestamp for TTL — a stream
  // nobody has updated for a week is garbage, and sweeping it automatically means a stale
  // token can never serve a months-old game. PK (user_id, game_id) so enabling twice (or
  // regenerating) overwrites the row in place — the old token dies with the overwrite; the
  // global index is what lets the public GET resolve a token without knowing the owner.
  `CREATE TABLE IF NOT EXISTS broadcasts (
     user_id Utf8 NOT NULL,
     game_id Utf8 NOT NULL,
     token Utf8,
     payload Utf8,
     updated_at Utf8,
     expires_at Timestamp,
     PRIMARY KEY (user_id, game_id),
     INDEX idx_broadcasts_token GLOBAL ON (token)
   );`,

  `ALTER TABLE broadcasts SET (TTL = Interval("PT0S") ON expires_at);`,

  // A live game shared by several phones (routes/party.ts). Three tables, all under TTL, because
  // a party is a single evening's thing and nothing here outlives the game it carried.
  //
  // `parties` — one row per shared game: the host's account (for reclaiming a lost phone), the
  // invite (a link token, plain like a broadcast token — the link IS the credential — and a
  // short-lived six-digit code), the global `seq` every write bumps (what a phone polls
  // "since"), and whether the game is finished. Versions and counters are Uint32 — the one
  // place this schema compares numbers server-side.
  `CREATE TABLE IF NOT EXISTS parties (
     party_id Utf8 NOT NULL,
     host_user_id Utf8,
     game_id Utf8,
     invite_token Utf8,
     code Utf8,
     code_expires_at Utf8,
     seq Uint32,
     status Utf8,
     created_at Utf8,
     updated_at Utf8,
     expires_at Timestamp,
     PRIMARY KEY (party_id),
     INDEX idx_parties_invite GLOBAL ON (invite_token),
     INDEX idx_parties_code GLOBAL ON (code)
   );`,
  `ALTER TABLE parties SET (TTL = Interval("PT0S") ON expires_at);`,

  // One row per phone in a party. The token is stored hashed like a refresh token — it grants
  // writes. A kicked member keeps its row with `revoked_at` set (the seat is free, the token dead);
  // the global index is how a Bearer resolves to its row without knowing the party.
  `CREATE TABLE IF NOT EXISTS party_members (
     party_id Utf8 NOT NULL,
     member_id Utf8 NOT NULL,
     token_hash Utf8,
     role Utf8,
     side Int32,
     mi Int32,
     name Utf8,
     created_at Utf8,
     last_seen_at Utf8,
     revoked_at Utf8,
     expires_at Timestamp,
     PRIMARY KEY (party_id, member_id),
     INDEX idx_party_members_token GLOBAL ON (token_hash)
   );`,
  `ALTER TABLE party_members SET (TTL = Interval("PT0S") ON expires_at);`,

  // The five slices of the game, one row each, created with the party so every write is an
  // UPDATE of an existing row. `version` is the slice's own optimistic-concurrency counter;
  // `seq` is the party's global sequence at the slice's last write, which is what "give me what
  // changed since N" selects on.
  `CREATE TABLE IF NOT EXISTS party_state (
     party_id Utf8 NOT NULL,
     slice Utf8 NOT NULL,
     version Uint32,
     seq Uint32,
     data Utf8,
     updated_at Utf8,
     expires_at Timestamp,
     PRIMARY KEY (party_id, slice)
   );`,
  `ALTER TABLE party_state SET (TTL = Interval("PT0S") ON expires_at);`,

  // Player bug reports (POST /feedback — public, anonymous unless a Bearer rode along).
  // `context` is the client-collected tech block (version/route/UA/recent JS errors) and
  // `attachment` an optional roster/game snapshot the player explicitly agreed to include —
  // both opaque JSON, read by a human via `npm run feedback:list`, never queried server-side.
  `CREATE TABLE IF NOT EXISTS feedback (
     feedback_id Utf8 NOT NULL,
     created_at Utf8,
     user_id Utf8,
     app_version Utf8,
     route Utf8,
     message Utf8,
     context Utf8,
     attachment Utf8,
     PRIMARY KEY (feedback_id)
   );`,
]

export async function migrate(): Promise<void> {
  for (const stmt of STATEMENTS) {
    await executeScheme(stmt)
  }
}
