# wh11ed-api

Backend microservice for **cloud backup of the wh11ed Game Tracker history**. Users log in with
Yandex (OAuth, no passwords) and back up / list / view / restore / delete their
finished games. `localStorage` stays the primary store; the cloud is a backup.

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
