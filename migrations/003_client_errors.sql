-- Errors the site's visitors ran into, sent only by those who switched sending on (owner,
-- 2026-10-14: off by default). Stored as AGGREGATES, not events: one row per error per site
-- version, counted up — a thousand identical crashes are one row. No IP and no account is kept;
-- the route is stored without its query and hash (a shared roster rides in the hash).
--
-- Production and the beta site are kept apart (owner): two tables of one shape, two digests.

CREATE TABLE client_errors (
  fingerprint text NOT NULL,                -- domain/clientErrors.ts: kind + normalized message + top frame
  app_version text NOT NULL,
  kind        text NOT NULL,                -- 'error' | 'rejection' | 'chunk'
  message     text NOT NULL,                -- the first message seen, capped
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL,
  count       integer NOT NULL DEFAULT 1,
  sample      jsonb NOT NULL,               -- stack, src, route, locale, standalone, dataVersion of the last one
  browsers    jsonb NOT NULL DEFAULT '{}',  -- "Safari iOS" -> count
  routes      jsonb NOT NULL DEFAULT '{}',  -- "/roster/:id" -> count (at most 20 distinct)
  resolved_in text,                         -- the version that fixed it (errors-resolve.ts); a later version reopens it
  alerted_at  timestamptz,                  -- the release watch mailed it
  PRIMARY KEY (fingerprint, app_version)
);
CREATE INDEX idx_client_errors_last_seen ON client_errors (last_seen);

CREATE TABLE client_errors_beta (LIKE client_errors INCLUDING ALL);

-- How many sessions had sending on, per day and site: once a day a reporting browser says hello.
-- It is the denominator — "3 errors" reads differently out of 5 reporters and out of 500.
CREATE TABLE client_error_reporters (
  day      date NOT NULL,
  channel  text NOT NULL,                   -- 'prod' | 'beta'
  sessions integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, channel)
);
