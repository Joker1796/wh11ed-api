# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The backend for **wh11ed** — a bilingual EN/RU Warhammer 40,000 11th ed rules reference and offline
game tracker ([wh11ed.ru](https://wh11ed.ru), frontend in
[Joker1796/wh11ed](https://github.com/Joker1796/wh11ed)).

Its whole job is **cloud backup of finished games**: let a player sign in and keep their tracker
history across devices. That's all. The app deliberately works without it — rules, tracker and PWA
are entirely client-side — so this service is **optional infrastructure, not the product**. If it's
down, nobody loses a game; they lose sync.

That framing explains the shape of the code:

- **It's small on purpose.** Three tables, a handful of routes. The complexity in this product lives
  in the frontend; resist moving logic here.
- **The game payload is an opaque blob.** `domain/game.ts` validates only the envelope the API
  actually needs and uses `.passthrough()` everywhere — the client owns the game's internal shape and
  evolves it freely. **This is the one real coupling between the two repos**: change the saved-game
  format or the auth flow on the frontend and you must check it here, and vice versa.
- **Serverless shapes the design.** It runs as a Yandex Cloud Function, so warm invocations reuse
  state: the YDB driver is a module-scope singleton, never per-request. The core is
  runtime-agnostic (`app.fetch(Request)`), with Yandex confined to `adapters/`.
- **Some things are deliberate and must not be "fixed"** — `SameSite=None` on the session cookie
  (an earlier `Strict` broke the deployed login), `@yandex-cloud/nodejs-sdk` marked external in the
  bundle, `dist/package.json` forcing CommonJS. Each is explained below where it appears; check
  before changing.

**Where to start:** [`README.md`](README.md) has the full HTTP contract, auth flow, deploy runbook
and security notes — read it for the API surface. This file covers what you'd otherwise only learn
by reading several files at once: layering, the singleton driver, the auth invariants, build gotchas.

Node ≥22 required. `npm install && npm test` needs no cloud credentials — the tests are unit tests
over the adapter and domain layers.

## Commands

```bash
npm run dev        # local server at http://localhost:8787 (tsx --watch, loads .env if present)
npm test           # node --test over test/*.test.ts (adapter + domain unit tests)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + bundle to dist/handler.js (esbuild, single CJS file)
npm run migrate    # create/alter YDB tables (idempotent); needs YDB_* env set
bash scripts/deploy.sh  # build + zip + terraform apply (infra/)
```

Run a single test: `node --import tsx --test test/game.test.ts`. Node ≥22 is required (uses the
built-in test runner and `--env-file-if-exists`). Copy `.env.example` → `.env` for local dev; a
local `YDB_ACCESS_TOKEN` (`yc iam create-token`) is needed to hit a real YDB.

## Architecture

**Runtime-agnostic core, one adapter.** All HTTP logic is a Hono app exposed only as
`app.fetch(Request): Promise<Response>` (`src/app.ts`). Nothing in `src/` knows about Yandex.
Two drivers feed it the same way:
- `src/server.ts` — `@hono/node-server` for local dev.
- `adapters/handler.ts` — the deployed Yandex Cloud Functions entrypoint (`adapters.handler`).
  `adapters/yc-apigw.ts` converts the API Gateway event ⇄ Web `Request`/`Response`.

Porting to another runtime = a new adapter under `adapters/`; `src/` is untouched. The adapter
boundary is the one thing that has its own unit test (`test/adapter.test.ts`).

**Layering:** `routes/*` (HTTP, zod validation) → `domain/*` + `db/*.repo.ts` (logic, queries) →
`db/driver.ts` (YDB). Routes never touch the driver directly.

**Config (`src/config.ts`):** env-derived values are **lazy getters**, so importing `config` never
throws — only *accessing* a missing required var does. This keeps the domain layer importable in
tests without a full env, while preserving fail-fast at the server/handler entrypoints. Plain
constants (`maxGameBytes` 64 KB, `maxGamesPerUser` 500) are fields. `oauthProvider(name)` returns
the per-provider OAuth endpoints; add a provider here + in `ProviderName`/`isProviderName`.

**YDB access (`src/db/driver.ts`):** the `Driver` is a **module-scope singleton promise** so warm
function invocations reuse the gRPC connection — never construct a `Driver` per request. Auth is
chosen at runtime: `YDB_ACCESS_TOKEN` (local dev) → `TokenAuthService`; empty (in YCF) →
`MetadataTokenAuthService` (the function's attached service account via the metadata endpoint).
All queries go through `query<T>(yql, params)` — parameterized YQL only (param keys keep the
leading `$`, values are `ydb-sdk` `TypedValues`); never string-interpolate user input.

**Schema (`src/db/schema.ts`):** three tables — `users`, `games` (PK `(user_id, game_id)`),
`sessions`. JSON blobs and ISO timestamps are stored as `Utf8` (never queried server-side); only
`sessions.expires_at` is a real `Timestamp` because a YDB **TTL** column auto-purges expired
sessions. Migrations are a list of idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER` statements.

**Game payload (`src/domain/game.ts`):** the tracker game is stored as an **opaque JSON blob**.
`gameSchema` validates only the envelope the API relies on (`id`, `players`, `createdAt`,
`finishedAt`, `result.totals`) and uses `.passthrough()` everywhere — the client owns the internal
shape and may evolve it, so unknown fields are preserved. `extractMetadata` denormalizes the small
fields used by the history list view into dedicated columns.

**Auth.** Authorization Code + PKCE; the client secret never leaves the server. Sessions
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

## Build & deploy specifics

`scripts/bundle.mjs` (esbuild) produces a single CJS `dist/handler.js` with deps inlined (ydb-sdk,
grpc, hono are pure JS — no `node_modules` shipped). Two gotchas baked in: `@yandex-cloud/nodejs-sdk/*`
is marked **external** (ydb-sdk lazily requires it for an auth path we don't use — our own
`metadata-auth.ts` replaces it), and a `dist/package.json` with `"type":"commonjs"` is written so
the CJS bundle loads correctly despite the root being `"type":"module"`.

Infra is Terraform in `infra/` (Cloud Function, API Gateway with `openapi.yaml`, YDB, Lockbox,
service accounts, managed cert). Secrets come from `infra/secret.auto.tfvars` (gitignored) or
`TF_VAR_*`. First-ever deploy needs manual DNS + cert-validation CNAMEs and a one-time `npm run migrate`
against the new YDB — see README "Deploy".
