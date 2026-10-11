-- Sign-in with an email and a password, next to Yandex (2026-10-11: Yandex OAuth answered 429 and
-- "internal" for an evening, and nothing else let a player in).
--
-- An account (`users.user_id`) is independent of how one signs in. A player who registers with a
-- password gets a fresh id (`u:<random>`); a Yandex account keeps the `yandex:<sub>` it always had.
-- The email login lives in its own table rather than in `users.email`: that column is whatever the
-- OAuth provider last reported, and a provider's address must never become a way to log in to an
-- account — only an address the player typed and proved is.

CREATE TABLE password_logins (
  user_id     text PRIMARY KEY,
  email       text NOT NULL,             -- lower-cased, trimmed
  hash        text NOT NULL,             -- scrypt$N$r$p$<salt b64>$<hash b64> (auth/password.ts)
  verified_at text,                      -- ISO; NULL until the link in the welcome mail is opened
  created_at  text NOT NULL,
  updated_at  text NOT NULL
);
CREATE UNIQUE INDEX idx_password_logins_email ON password_logins (email);

-- One-time links mailed to the player: confirm the address, set a new password. Only the SHA-256
-- of the token is kept, as with refresh tokens. A token is single-use (`used_at`) and expires.
CREATE TABLE email_tokens (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL,
  purpose    text NOT NULL,              -- 'verify' | 'reset'
  email      text NOT NULL,              -- the address it was sent to — it must still be the login's
  created_at text NOT NULL,
  used_at    text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX idx_email_tokens_user ON email_tokens (user_id);
CREATE INDEX idx_email_tokens_expires ON email_tokens (expires_at);
