# wh11ed-api

Backend microservice for **cloud backup of the wh11ed Game Tracker history and army lists**.
Users log in with Yandex (OAuth, no passwords) and back up / list / view / restore / delete their
finished games and rosters. `localStorage` stays the primary store; the cloud is a backup.

- **Runtime:** Yandex Cloud Functions (`nodejs22`) behind Yandex API Gateway
- **DB:** YDB serverless (scales to zero — effectively free at this scale)
- **Code:** TypeScript + [Hono](https://hono.dev), runtime-agnostic via a thin adapter
- **Secrets:** Yandex Lockbox (injected as env vars)
- **IaC:** Terraform (`infra/`)

## Architecture

```
SPA (wh11ed.ru)  ──fetch──▶  API Gateway (api.wh11ed.ru)  ──▶  Cloud Function  ──▶  YDB
   Bearer access token (in memory) on /games,/me                (Hono + adapter)      Lockbox
   credentials:'include' on /auth/refresh
```

All HTTP logic lives behind `app.fetch(Request): Promise<Response>` (`src/app.ts`). The only
Yandex-specific file is `adapters/yc-apigw.ts`, which converts the gateway event ⇄ Web
Request/Response. Porting to another runtime later = a new adapter; `src/` is untouched.

### Auth (Authorization Code + PKCE)
1. SPA → `GET /auth/{provider}/login` — function stores `state`+PKCE in a short signed cookie, redirects to provider.
2. Provider → `GET /auth/{provider}/callback` — function exchanges the code **server-side**
   (client secret from Lockbox), fetches identity, upserts the user, creates a session, sets the
   **refresh** cookie (`HttpOnly; Secure; SameSite=None; Path=/auth` — `None` is intentional and
   required for the flow; don't change it to `Strict`), and 302s back to the SPA.
3. SPA → `POST /auth/refresh` (`credentials:'include'`) — rotates the refresh token, returns a
   short-lived **access** JWT kept in memory and sent as `Authorization: Bearer` on API calls.

**Host-aware domains (migration):** one function serves both `api.wh11ed.ru` and
`api.wh-rules.ru`. The auth routes derive the cookie domain, post-login redirect and OAuth
`redirect_uri` from the request's `Host` header (`siteForHost` in `src/config.ts` — only Hosts
matching `api.<host>` of an https `ALLOWED_ORIGINS` entry are recognised; anything else falls
back to the `API_BASE_URL`/`APP_AFTER_LOGIN_URL`/`COOKIE_DOMAIN` env defaults). Both callback
URLs must stay registered as Redirect URIs of the Yandex OAuth app.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | – | liveness |
| GET | `/auth/{provider}/login` | – | start OAuth (`provider` = `yandex`) |
| GET | `/auth/{provider}/callback` | – | OAuth redirect target |
| POST | `/auth/refresh` | refresh cookie | `{ accessToken, expiresIn }`, rotates cookie |
| POST | `/auth/logout` | refresh cookie | revoke session |
| GET | `/me` | Bearer | `{ id, email, displayName }` |
| GET | `/games?limit=` | Bearer | list metadata `{ gameId, createdAt, finishedAt, resultSummary, players }` |
| GET | `/games/{id}` | Bearer | full game blob |
| PUT | `/games/{id}` | Bearer | idempotent upsert (body = game JSON; `id` must match path) |
| DELETE | `/games/{id}` | Bearer | delete |
| GET | `/rosters?limit=` | Bearer | list metadata **only** — live `{ rosterId, name, faction, updatedAt, points, unitCount }` and tombstones `{ rosterId, deleted: true, deletedAt }` |
| GET | `/rosters/{id}` | Bearer | full roster blob |
| PUT | `/rosters/{id}` | Bearer | idempotent upsert (body = roster JSON; `id` must match path; a wizard draft is rejected 422) |
| DELETE | `/rosters/{id}?at=` | Bearer | tombstone (`at` = deleting client's epoch-ms clock; defaults to the server's) |

`/rosters` mirrors `/games` with two deliberate differences. The list endpoint returns metadata
without blobs, so entering the app's roster screen costs one small request and only the lists
whose `updatedAt` actually moved are downloaded. And **DELETE tombstones instead of removing**:
the row stays, emptied of everything but its id and `deleted_at`, and the list endpoint reports
it — otherwise a second device still holding the list would see an id the cloud lacks and upload
it straight back. A tombstone is outranked by a list saved after it (both timestamps are the
client's epoch-ms clock, so they compare directly), and tombstones older than 180 days are swept
on the next delete. Caps: 32 KB per roster, 200 rosters per user; tombstones don't count.

## Local development

```bash
npm install
cp .env.example .env          # fill YDB_* and a YDB_ACCESS_TOKEN (`yc iam create-token`)
npm run migrate               # create tables in the target YDB
npm run dev                   # http://localhost:8787
npm test                      # adapter + domain unit tests
npm run typecheck
```

OAuth locally needs an app registration with redirect URI
`http://localhost:8787/auth/yandex/callback`.

## Deploy

```bash
# infra/secret.auto.tfvars (gitignored): jwt_signing_key, yandex_* + api_base_url etc.
bash scripts/deploy.sh
```

Then, **first time only**:
1. Create the DNS records from the Terraform outputs: `CNAME api → <gateway_default_domain>` and
   the certificate-validation `CNAME`. Wait for the managed cert to reach **Issued**.
2. `npm run migrate` against the new YDB (set `YDB_ENDPOINT`/`YDB_DATABASE` from outputs).
3. Register the production redirect URI (`https://api.wh11ed.ru/auth/yandex/callback`)
   in the Yandex OAuth cabinet.

### Rolling out a change that touches the schema

**Order matters, always the same one — schema, then function, then client.** A function version
that queries a column the database doesn't have yet fails every request touching it; a database
with a column nothing reads yet costs nothing. The frontend goes last because it is the only
layer that tolerates the others being behind (every cloud call there is best-effort).

1. **`npm run migrate`** — idempotent (`CREATE TABLE IF NOT EXISTS` / `ALTER`), so re-running is
   safe. Needs `YDB_ENDPOINT`/`YDB_DATABASE` and a `YDB_ACCESS_TOKEN` (`yc iam create-token`).
   Note the file's own caveat: `CREATE TABLE IF NOT EXISTS` does **not** add a column to a table
   that already exists — a new column on a live table needs its own `ALTER TABLE … ADD COLUMN`
   statement in the list.
2. **Build and ship the function.** `npm run build` + zip `dist/{handler.js,package.json}`, then
   `yc serverless function version create`. `scripts/deploy.sh` still ends in `terraform apply`
   and therefore does NOT work — see the note below.
3. **Smoke-test with a real token** before believing it: `GET /health`, then a
   `GET`/`PUT`/`GET`/`DELETE` round trip on the endpoints that changed.
4. **Frontend** (`wh11ed/deploy.sh`) — only if the client half is also ready to ship.

#### Two things the steps above no longer describe (2026-08-26)

**Terraform is not usable — the state is gone, not drifted.** It was a local state file (there is
no `backend` block in `infra/versions.tf`) living in a checkout that has since been deleted; a
search of the whole machine turns up neither `*.tfstate` nor `secret.auto.tfvars`. Running
`terraform apply` against an empty state would try to CREATE all eleven resources, including
`yandex_ydb_database_serverless` — the database holding users' games. Deploy with
`yc serverless function version create` instead, mirroring the live version's config
(`yc serverless function version get <id>` prints everything you need: runtime, entrypoint,
memory, timeout, service account and the Lockbox secret bindings). Restoring IaC means importing
the eleven resources into a fresh state — a separate job, not something to improvise mid-deploy.

**`npm run migrate` broke once and is fixed.** ydb-sdk 5.11.1's ESM build omits exactly one name
from its named exports — `Driver` — so importing it by name threw under Node's own ESM resolution
while esbuild (which builds the deployed bundle) papered over it. `src/db/driver.ts` now takes the
class off the default export, which works under both. If a future bump makes `import { Driver }`
work again, that comment can go.

## Security notes
- TLS only; CORS locked to `ALLOWED_ORIGINS` with credentials (no wildcard).
- Refresh tokens are opaque, stored only as SHA-256 hashes, single-use (rotated on every refresh), and
  auto-expire via a YDB TTL column. `/games*` is Bearer-only → not CSRF-able.
- All inputs validated with zod; per-game (64 KB) and per-user (500 games) caps.
- Secrets only in Lockbox; least-privilege service accounts; gateway rate limit.

## Frontend integration (separate task)
The SPA still needs: a login button (`/auth/{provider}/login`), an `/auth/refresh` call on load to
obtain the access token, and sync calls in `useTracker.js` (PUT finished games, list/restore).
The API contract above is the integration surface.
