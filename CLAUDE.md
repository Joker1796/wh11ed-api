# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The backend for **wh11ed** — a bilingual EN/RU Warhammer 40,000 11th ed rules reference and offline
game tracker ([wh11ed.ru](https://wh11ed.ru), frontend in
[Joker1796/wh11ed](https://github.com/Joker1796/wh11ed)).

Its whole job is **cloud backup of finished games and army lists**: let a player sign in and keep
their tracker history and rosters across devices. That's all. The app deliberately works without it — rules, tracker and PWA
are entirely client-side — so this service is **optional infrastructure, not the product**. If it's
down, nobody loses a game; they lose sync.

That framing explains the shape of the code:

- **It's small on purpose.** A handful of tables, a handful of routes. The complexity in this product lives
  in the frontend; resist moving logic here.
- **The game payload is an opaque blob.** `domain/game.ts` validates only the envelope the API
  actually needs and uses `.passthrough()` everywhere — the client owns the game's internal shape and
  evolves it freely. **This is the one real coupling between the two repos**: change the saved-game
  format or the auth flow on the frontend and you must check it here, and vice versa.
- **One long-lived Node process over PostgreSQL.** Until 2026-10-11 it was a Yandex Cloud Function
  over YDB; the Yandex outage of that day moved it (hub journal `2026-10-11-backend-move.md`). The
  core is still runtime-agnostic (`app.fetch(Request)`), and the in-memory caches in the party
  routes assume ONE process — scaling out would need them rethought.
- **Some things are deliberate and must not be "fixed"** — `SameSite=None` on the session cookie
  (an earlier `Strict` broke the deployed login), the `OAUTH_YANDEX_*` overrides existing only for
  the stand. Each is explained below where it appears; check before changing.

**Where to start:** [`README.md`](README.md) has the full HTTP contract, auth flow, deploy runbook
and security notes — read it for the API surface. This file covers what you'd otherwise only learn
by reading several files at once: layering, the singleton driver, the auth invariants, build gotchas.

Node ≥22 required. `npm install && npm test` needs no database — routes, domain and config. The SQL
is tested against real Postgres by `npm run stand:test` (`test/db/`). **The local stand is the
development environment: `DEVELOPMENT.md`.**

## Commands

```bash
npm run stand      # the local stand: Postgres + API + fake Yandex sign-in + Mailpit (docker compose)
npm run stand:seed # test players and data; stand:reset wipes and reseeds
npm run stand:test # test/db/*.test.ts — the repos against real Postgres (a *_test database)
npm test           # node --test over test/*.test.ts — no database
npm run typecheck  # tsc --noEmit
npm run dev        # API on :8787 outside docker (tsx --watch, loads .env)
npm run migrate    # apply new files in migrations/ (needs DATABASE_URL)
```

Run a single test: `node --import tsx --test test/game.test.ts`. Node ≥22 is required (uses the
built-in test runner and `--env-file-if-exists`).

## Architecture

**Runtime-agnostic core.** All HTTP logic is a Hono app exposed only as
`app.fetch(Request): Promise<Response>` (`src/app.ts`). `src/server.ts` serves it with
`@hono/node-server` (stand and production alike), starts the expiry sweep and closes the pool on
SIGTERM.

**Layering:** `routes/*` (HTTP, zod validation) → `domain/*` + `db/*.repo.ts` (logic, queries) →
`db/driver.ts` (Postgres). Routes never touch the driver directly.

**Config (`src/config.ts`):** env-derived values are **lazy getters**, so importing `config` never
throws — only *accessing* a missing required var does. This keeps the domain layer importable in
tests without a full env, while preserving fail-fast at the server/handler entrypoints. Plain
constants (`maxGameBytes` 64 KB, `maxGamesPerUser` 500) are fields. `oauthProvider(name)` returns
the per-provider OAuth endpoints; add a provider here + in `ProviderName`/`isProviderName`.

**Database access (`src/db/driver.ts`):** `db()` is the one pool per process, made on first use
(importing a repo opens nothing — the unit tests import half the tree with no database). Queries
are `postgres` tagged templates — `` db()`… WHERE id = ${id}` `` sends `id` as a PARAMETER, never
text; `db().unsafe` only ever takes constants. `transaction(fn)` runs `fn` SERIALIZABLE and
retries on 40001/40P01, which is what YDB's `doTx` did on its own: the compare-then-write in the
party sync and the prefs versions depend on it, and `test/db/party.test.ts` fails without it
(checked: it goes red under READ COMMITTED).

**Schema (`migrations/*.sql`, applied by `src/db/schema.ts`):** `users`, `games` (PK
`(user_id, game_id)`), `rosters` (PK `(user_id, roster_id)`), `user_prefs`, `sessions`,
`broadcasts`, `feedback`, `changelog` (PK `rank` = the version as a number), and the three party
tables. The YDB columns were carried over **meaning for meaning**: blobs and the client's ISO /
epoch-ms timestamps are `text`, `''` still means absent where the code writes `''`, and text
ordering uses `COLLATE "C"` where it must match YDB's byte order. `expires_at` is `timestamptz`,
and `src/db/sweep.ts` deletes expired rows every ten minutes — Postgres has no TTL. A schema
change is a NEW migration file; an edited one is never re-applied (`schema_migrations`).
YDB's `UPSERT` wrote only the columns it named — the ports use `ON CONFLICT … DO UPDATE SET`
the same columns, or a plain `UPDATE` where the row must already exist.

**Game payload (`src/domain/game.ts`):** the tracker game is stored as an **opaque JSON blob**.
`gameSchema` validates only the envelope the API relies on (`id`, `players`, `createdAt`,
`finishedAt`, `result.totals`) and uses `.passthrough()` everywhere — the client owns the internal
shape and may evolve it, so unknown fields are preserved. `extractMetadata` denormalizes the small
fields used by the history list view into dedicated columns.

**Roster payload (`src/domain/roster.ts`):** the same opaque-blob treatment as a game, with four
differences worth knowing. Its client timestamps are **epoch milliseconds**, not ISO strings, and
`updatedAt` is mirrored into its own column because the client's last-write-wins merge compares on
it. `GET /rosters` returns **metadata only** — that one request is the whole cost of opening the
app's roster screen, and blobs are fetched only for the lists whose `updatedAt` moved. And a wizard
draft (`draft: true`) is rejected with 422: an unfinished list never leaves the device it was
started on, so `rosterSchema` accepts only `draft: false`/absent. Finally, **DELETE tombstones**
(`deleted_at`) rather than removing the row, and the list endpoint reports tombstones alongside
live lists — a second device has no other way to learn a list was deleted elsewhere, and would
otherwise re-upload its copy. `tombstoneRoster` is an `UPDATE`, not an `UPSERT`, so deleting an id
the cloud never held can't conjure a row; `purgeOldTombstones` sweeps anything older than 180 days
on the next delete, which is why the table needs no TTL column.

**Shared live game (`src/domain/party.ts`, `src/db/parties.repo.ts`, `src/routes/party.ts`):**
the one place this service holds LIVE state rather than backups, and the one place it compares
numbers server-side (slice versions, the party `seq` — `integer` columns). Everything that decides
who may write what is in the domain module, pure, and `test/party.test.ts` covers it;
`test/party-routes.test.ts` drives the routes end to end against an in-memory repo through
`mock.module` (hence `--experimental-test-module-mocks` in `npm test`), and
`test/db/party.test.ts` runs the SQL — the concurrent-write race above all. `writeSlices` is the reason `driver.ts` has `transaction()`: compare-then-write must
be one serializable unit. Two credentials meet in the routes — the host's account JWT creates a
party and reclaims it, then EVERY phone speaks with a per-party member token (`requireMember`,
not `requireAuth`). In-process caches (state 3 s, member rows 15 s, last-seen writes 30 s)
are what keep four polling phones at one database read per party per tick; every admin action drops
the entries it invalidates. The contract is in README "A shared live game".

**Auth.** Authorization Code + PKCE; the client secret never leaves the server. **Host-aware
domains:** the auth routes derive cookie domain / post-login redirect / OAuth `redirect_uri` from
the request `Host` via `siteForHost()` (`src/config.ts`) so one function serves both
`api.wh11ed.ru` and `api.wh-rules.ru` during the domain migration; unknown Hosts fall back to the
env defaults — don't rebuild redirects from raw headers anywhere else. Sessions
(`src/auth/sessions.ts`): refresh tokens are opaque random strings stored only as SHA-256 hashes,
**single-use** (rotated on every `/auth/refresh`), with reuse-detection that destroys the session.
The cookie value is `sessionId.secret` so refresh is an O(1) PK lookup. Access tokens are
short-lived JWTs (`src/auth/jwt.ts`); `requireAuth` middleware (`src/auth/middleware.ts`) verifies
the Bearer token and sets `c.var.userId`. `/games*` is Bearer-only (not CSRF-able); the refresh
cookie is `HttpOnly; Secure; Path=/auth`. **SameSite is deliberately `None` at issue** (login
callback, over HTTPS) — an earlier `Strict` broke the deployed login/refresh flow, so do **not**
change it back. CSRF is still covered: `originAllowed()` runs on both `/auth` POST endpoints and
`/games*` is Bearer-only. (The `/auth/refresh` handler currently re-sets the cookie `Strict`; this
asymmetry is harmless because the SPA and API are the same site — don't "normalize" it without
re-testing real login.)

## The local stand

`docker-compose.yml` + `stand/` — the walkthrough is `DEVELOPMENT.md`. Two things worth knowing
before changing it:

- **Sign-in runs the production code.** `stand/fake-oauth.mjs` answers Yandex's authorize, token
  and info requests in Yandex's own shapes; the API differs from production only in three
  `OAUTH_YANDEX_*` URLs. Don't add stand-only routes to the API for sign-in — that is what the fake
  provider exists to avoid. (`/dev/jwt` predates it and stays for the frontend's dev mock.)
- **The fixtures are snapshots made by the frontend's own code** — `stand/fixtures/rosters.json`
  from wh11ed's test rosters (`buildTestRoster` + `summarize`), `games.json` by playing the tracker
  store. A roster stores wargear as indices into generated data, so after an appdata bump a seeded
  list can show the wrong gear: regenerate rather than hand-edit.

## Deploy

Being rebuilt for a VPS (Docker, Caddy, PostgreSQL, nightly `pg_dump` off-site) — README "Deploy"
and the hub journal. `infra/` is the retired Yandex Cloud setup, kept as a description until it is
shut down; nothing deploys from it.
