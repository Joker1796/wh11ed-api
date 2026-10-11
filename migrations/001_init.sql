-- The schema as it stood in YDB, moved to PostgreSQL (2026-10-11, the Yandex Cloud outage).
--
-- Column meanings are carried over unchanged on purpose: the repos, the domain modules and the
-- frontend all agree on them, and a port is not the moment to change a contract. So JSON blobs and
-- the client's ISO / epoch-ms timestamps stay TEXT ('' still means "absent" where the YDB code
-- wrote ''), and only the columns a sweep or a comparison needs are typed.
--
-- `expires_at` replaces YDB's TTL: Postgres has none, so src/db/sweep.ts deletes expired rows on a
-- timer. YDB's TTL was lazy too (rows could outlive their stamp by hours), so nothing that reads
-- these tables ever relied on the purge being prompt.

CREATE TABLE users (
  user_id      text PRIMARY KEY,
  email        text,
  display_name text,
  created_at   text
);

CREATE TABLE games (
  user_id        text NOT NULL,
  game_id        text NOT NULL,
  blob           text,
  created_at     text,
  finished_at    text,
  result_summary text,
  players        text,
  updated_at     text,
  PRIMARY KEY (user_id, game_id)
);

-- updated_at / deleted_at are the CLIENT's epoch-ms clock as text (13 digits until 2286, so text
-- order is numeric order); '' in deleted_at = live. See rosters.repo.ts.
CREATE TABLE rosters (
  user_id           text NOT NULL,
  roster_id         text NOT NULL,
  blob              text,
  name              text,
  faction           text,
  updated_at        text,
  points            text,
  unit_count        text,
  deleted_at        text,
  server_updated_at text,
  PRIMARY KEY (user_id, roster_id)
);

CREATE TABLE user_prefs (
  user_id           text NOT NULL,
  scope             text NOT NULL,
  data              text,
  version           integer,
  updated_at        text,
  server_updated_at text,
  PRIMARY KEY (user_id, scope)
);

CREATE TABLE sessions (
  session_id   text PRIMARY KEY,
  user_id      text,
  refresh_hash text,
  created_at   text,
  expires_at   timestamptz
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE broadcasts (
  user_id    text NOT NULL,
  game_id    text NOT NULL,
  token      text,
  payload    text,
  updated_at text,
  expires_at timestamptz,
  PRIMARY KEY (user_id, game_id)
);
CREATE INDEX idx_broadcasts_token ON broadcasts (token);
CREATE INDEX idx_broadcasts_expires ON broadcasts (expires_at);

CREATE TABLE parties (
  party_id        text PRIMARY KEY,
  host_user_id    text,
  game_id         text,
  invite_token    text,
  code            text,
  code_expires_at text,
  seq             integer,
  status          text,
  created_at      text,
  updated_at      text,
  expires_at      timestamptz
);
CREATE INDEX idx_parties_invite ON parties (invite_token);
CREATE INDEX idx_parties_code ON parties (code);
CREATE INDEX idx_parties_expires ON parties (expires_at);

CREATE TABLE party_members (
  party_id     text NOT NULL,
  member_id    text NOT NULL,
  token_hash   text,
  role         text,
  side         integer,
  mi           integer,
  name         text,
  created_at   text,
  last_seen_at text,
  revoked_at   text,
  expires_at   timestamptz,
  PRIMARY KEY (party_id, member_id)
);
CREATE INDEX idx_party_members_token ON party_members (token_hash);
CREATE INDEX idx_party_members_expires ON party_members (expires_at);

CREATE TABLE party_state (
  party_id   text NOT NULL,
  slice      text NOT NULL,
  version    integer,
  seq        integer,
  data       text,
  updated_at text,
  expires_at timestamptz,
  PRIMARY KEY (party_id, slice)
);
CREATE INDEX idx_party_state_expires ON party_state (expires_at);

CREATE TABLE feedback (
  feedback_id text PRIMARY KEY,
  created_at  text,
  user_id     text,
  app_version text,
  route       text,
  message     text,
  context     text,
  attachment  text
);

-- rank = the version as a number (domain/changelog.ts versionRank). YDB's Uint32 → bigint here:
-- a rank can reach 0xffffffff territory and integer is signed.
CREATE TABLE changelog (
  rank    bigint PRIMARY KEY,
  version text,
  date    text,
  en      text,
  ru      text
);
