# wh11ed-api

Backend microservice for **cloud backup of the wh11ed Game Tracker history and army lists**.
Users log in with Yandex (OAuth, no passwords) and back up / list / view / restore / delete their
finished games and rosters. `localStorage` stays the primary store; the cloud is a backup.

- **Runtime:** Yandex Cloud Functions (`nodejs22`) behind Yandex API Gateway
- **DB:** YDB serverless (scales to zero — effectively free at this scale)
- **Code:** TypeScript + [Hono](https://hono.dev), runtime-agnostic via a thin adapter
- **Secrets:** Yandex Lockbox (injected as env vars)
- **Infra:** described in Terraform (`infra/`), but deployed with the `yc` CLI — see Deploy

## Architecture

```
SPA (wh-rules.ru)  ──fetch──▶  API Gateway (api.wh-rules.ru)  ──▶  Cloud Function  ──▶  YDB
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
| POST | `/games/{id}/broadcast` | Bearer | enable **or regenerate** the game's broadcast → `{ token }` (a fresh token always replaces the old one, which stops resolving) |
| GET | `/games/{id}/broadcast` | Bearer | `{ token }` of the enabled broadcast, 404 if none |
| DELETE | `/games/{id}/broadcast` | Bearer | disable (the share link dies) |
| PUT | `/broadcast/live/{gameId}` | Bearer | push the latest client-projected read-only state (≤16 KB; 404 until enabled) |
| GET | `/broadcast/{token}` | – | **public** read for the OBS overlay: `{ payload, updatedAt }`, `ETag`/`If-None-Match` → 304 |
| POST | `/feedback` | – | anonymous bug report `{ message, context?, attachment?, website? }` (honeypot `website`; per-IP throttle; read via `npm run feedback:list`) |
| POST | `/party` | Bearer | the host shares the game in progress: `{ gameId, slices, seat, name }` → `{ partyId, memberId, memberToken, seq, versions, you, invite: { token, code, codeExpiresAt } }` |
| POST | `/party/join` | – | exchange an invite for a member token: `{ code }` or `{ invite }` → `{ partyId, memberId, memberToken, seq, status, slices, members, you }` (per-IP throttle; the code lives 10 minutes) |
| POST | `/party/{id}/reclaim` | Bearer | the creating account gets a fresh host token (a lost phone); same body as join's answer |
| GET | `/party/{id}` | member | the whole game: `{ seq, status, slices, members, you }` |
| POST | `/party/{id}/seat` | member | take a seat `{ side, mi, name }` → `{ seq, you }`; 409 `seat_taken` with `heldBy` when a live member holds it |
| POST | `/party/{id}/sync` | member | `{ since, slices? }` → 204 nothing new · 200 `{ seq, status, you, written, slices }` · 409 `version_conflict` · 423 `read_only` · 403 `forbidden_slice` — see below |
| POST | `/party/{id}/leave` | member | a guest leaves: its token dies, its seat is free (the host ends or hands over instead) |
| GET | `/party/{id}/members` | member | who is in: `{ members: [{ memberId, name, side, mi, host, lastSeenAt, you }] }` |
| GET | `/party/{id}/invite` | host | the current invite (`code` null once it expired) |
| POST | `/party/{id}/invite` | host | a fresh code; `{ link: true }` also replaces the link token (the old link dies) |
| POST | `/party/{id}/members/{mid}/seat` | host | move another member (`side: null` unseats) |
| POST | `/party/{id}/members/{mid}/kick` | host | revoke that member's token now; its seat is free |
| POST | `/party/{id}/host` | host | hand the host role to `{ memberId }` |
| DELETE | `/party/{id}` | host | end the party: every row and every token |
| GET | `/rosters?limit=` | Bearer | list metadata **only** — live `{ rosterId, name, faction, updatedAt, points, unitCount }` and tombstones `{ rosterId, deleted: true, deletedAt }` |
| GET | `/rosters/{id}` | Bearer | full roster blob |
| PUT | `/rosters/{id}` | Bearer | idempotent upsert (body = roster JSON; `id` must match path; a wizard draft is rejected 422) |
| DELETE | `/rosters/{id}?at=` | Bearer | tombstone (`at` = deleting client's epoch-ms clock; defaults to the server's) |

### The broadcast feed (for custom overlays)

`GET https://api.wh-rules.ru/broadcast/{token}` is a **public, read-only JSON feed of one live
game**, meant to be fetched from anywhere: it answers with open CORS (`*`, no credentials) and
exposes `ETag`, so a custom HTML/CSS overlay can poll it every second or two and send
`If-None-Match` to get a cheap `304` while nothing moves. The app's own overlay
(`wh-rules.ru/broadcast/{token}`) is one consumer of this feed and has no privileged data.

```jsonc
{
  "updatedAt": "2026-09-13T09:41:02.118Z",   // when the phone last pushed
  "payload": {
    "v": 1,                     // payload version; fields are ADDED without bumping it
    "gameType": "singles",      // | "doubles"
    "scoreMode": "vp",          // what the players play to: "vp" | "bp"
    "battleSize": "strikeForce",// "incursion" | "strikeForce" | "onslaught" | "combatPatrol"
    "phase": "playing",         // | "finished"
    "endReason": null,          // "played" | "early" | "friendly-concede" | "opponent-concede"
    "round": 3,                 // battle round, 1..5
    "turn": 0,                  // index into sides[] — whose turn it is
    "battlePhase": "shooting",  // null unless the game keeps the phase clock
    "layout": "B",
    "twist": null,
    "sides": [{
      "teamName": "Alpha Strike",
      "players": [{ "name": "Ann", "faction": "Orks", "factionSlug": "orks",
                    "detachments": ["War Horde"] }],   // 2 entries in doubles
      "role": "attacker",       // | "defender"
      "forceType": null,        // doubles only: "unified" | "convenience"
      "disposition": "Battle Lines",
      "battleReady": true,
      "firstTurn": true,
      "cp": 3,
      "primary": { "slug": "secure-asset", "name": "Secure Asset", "vp": 22 },
      "secondaries": [          // drawn cards are face-up, so they are public
        { "slug": "assassination", "name": "Assassination", "vp": 5, "active": true },
        { "slug": "cleanse", "name": "Cleanse", "vp": 3, "active": false }  // set aside
      ],
      "secondaryVp": 8,
      "battleReadyVp": 10,
      "total": 40,              // primary + secondary + battle-ready, the VP result
      "bp": 12,                 // Battle Points as they stand now
      "rounds": [               // always five entries
        { "round": 1, "primary": 8, "secondary": 3, "vp": 11, "cumulativeVp": 11, "bp": 10 }
      ]
    }]
  }
}
```

**Polling etiquette.** Send `If-None-Match` and poll no faster than once a second: the gateway's
budget is 600 requests a minute for the WHOLE API (logins and sync included), and the app's own
overlay spends 12 of them per viewer at its 5-second cadence. The read protects itself — a
warm-instance micro-cache (2 s) means every viewer of one game shares a single database read,
responses carry `Cache-Control: public, max-age=2`, and a single IP is capped at 60 reads a
minute (`429` with `Retry-After: 2` past that) so one runaway client cannot spend the budget
everyone else needs.

Notes for a consumer: `sides` is always two, `sides[0]` is the first-turn side, and every name
is baked in (mission and faction names stay English by product convention) so an overlay needs
no data files of its own. `rounds[i].bp` is the Battle Points that round would have ended on —
the running result, not a per-round award; the two sides' `bp` always sum to 20. A token that
was revoked, regenerated or left untouched for a week answers `404`; a token of the wrong shape
`400`. Nothing here can be written through: the push endpoint is Bearer-only and lives
elsewhere.

**Broadcast** is the live-game overlay feed (OBS on a second device polls it every ~2 s while
the phone tracks the match). The payload is opaque like a game blob — the client projects the
read-only scoreboard itself, so nothing private can reach the public endpoint. The token is 128
random bits (an unlisted-link model: the URL is the credential); rows live in the `broadcasts`
table under a YDB TTL (`broadcastTtlDays`, 7 days past the last touch). The public GET is served
under the normal CORS policy — our own overlay page is same-site; third-party overlay hosts are
deliberately not supported (v1).

### A shared live game (`/party`)

Several phones run ONE game in progress: the host — the only one who needs an account — shares
it, the others join by link, QR or a six-digit code and take a seat. The server is the authority
on the game's state; the host owns the rights.

**Slices.** The game travels in five independently versioned parts — the tracker's own cut
(`gameSlices.js` in the frontend): `shared` (the clock, the settings, finished or not), `side0` /
`side1` (one side's scores, cards, CP, army state) and `roster0` / `roster1` (that side's army
list, sent once and again only when it changes). The blobs are opaque, like a game. A slice is
the unit of conflict — two phones scoring different sides never collide — and the unit of
rights: a seat on side N writes `sideN`, `rosterN` and `shared`; the host writes anything
(swapping who goes first rewrites all five); a member without a seat writes nothing.

**The handshake is one request.** `POST /party/{id}/sync` carries `since` (the last `seq` the
phone saw) and, when the phone has changes, `slices: { name: { version, data } }` where
`version` is the one the phone based its edit on. The answer is `204` when nothing was sent and
nothing moved; otherwise `200 { seq, status, you, written, slices }` — `written` the new version
of each slice that landed, `slices` every slice someone ELSE changed since `since` (never an echo
of the phone's own write), `you` the phone's own standing (its seat, whether it is host), which
is how a seat moved by the host reaches it, and `held` the sides OTHER live members sit on —
what a phone locks on its screen (the host included: the right to write a side is wider than
the lock, because editing the setup rewrites both sides; freeing the seat is how the host takes
a side back). Every write is a batch, all or nothing: a stale
version anywhere in it answers `409 { stale, seq, status, you, slices }` with the current state
of what moved and of the stale slices, and the phone replaces its copies (the server wins). A
finished party (the shared slice's `phase` is `finished`) is read-only for everyone — `423` —
except the host reopening it. A slice outside the member's rights is `403 forbidden_slice`.
Administrative changes (a seat, a kick, a hand-over) bump `seq` without touching a slice, so
polling phones get a `200` carrying their fresh `you` instead of a silent `204`.

**Cost.** The gateway charges per request, so the reads behind them are shared: a party's state
is served from warm-instance memory for three seconds after a read and dropped on any write to
it — every phone of one party in that window costs one YDB read. A member's `lastSeenAt` is
written at most every 30 s. Joins are throttled per address (10 a minute — a code is six digits
and lives ten minutes, so a guesser sees it expire long before the odds mean anything); syncs per
MEMBER (60 a minute), never per address, because a tournament hall puts every phone behind one
NAT. **The gateway's `rpm: 600` is the number to watch**: four phones at a three-second tick are
80 requests a minute for ONE game, so ~7 concurrent parties fill the whole API's budget together
with logins and backups. Raise it in the gateway spec (`infra/openapi.yaml` is the record, but
Terraform cannot apply it — edit the live spec with `yc` or the console) BEFORE this feature
reaches players.

**Lifetime.** Rows in `parties`, `party_members` and `party_state` sit under a YDB TTL (7 days
past the last write; members past their last touch); `DELETE /party/{id}` ends it at once. A
member token is stored hashed like a refresh token; the invite token is stored plain like a
broadcast token — the link is the credential. Kicking a member clears its token immediately (the
in-memory member cache is dropped with it; another warm instance learns within 15 s).

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
`http://localhost:8787/auth/yandex/callback`. Without one, `npm run dev:jwt` prints a week-long
access token signed with the local `.env` key: the frontend's dev mock sends it when forwarding
`/party` calls to this server (`localStorage['wh11ed-dev-jwt']`), which is how a shared game is
tried on a stand with no real login.

## Deploy

```bash
bash scripts/deploy.sh --dry-run   # build and print the plan, change nothing
bash scripts/deploy.sh             # ship a new function version
```

It copies the config of the version currently serving traffic (runtime, memory, service account,
environment, Lockbox bindings) and changes only the code, plus whatever a gitignored `deploy.env`
overrides — so a secret binding cannot be silently dropped. Terraform is **not** the deploy path;
see "Terraform is not usable" below.

Then, **first time only** (a brand-new environment, not a routine deploy):
1. Create the DNS records: `CNAME api → <gateway default domain>` (`yc serverless api-gateway get`)
   and the certificate-validation `CNAME` from Certificate Manager. Wait for the managed cert to
   reach **Issued**.
2. `npm run migrate` against the new YDB (set `YDB_ENDPOINT`/`YDB_DATABASE` to its endpoint).
3. Register the production redirect URI (`https://api.wh-rules.ru/auth/yandex/callback`)
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
2. **Build and ship the function** — `bash scripts/deploy.sh` (build, zip, and
   `yc serverless function version create` off the live version's config).
3. **Smoke-test with a real token** before believing it: `GET /health`, then a
   `GET`/`PUT`/`GET`/`DELETE` round trip on the endpoints that changed.
4. **Frontend** (`wh11ed/deploy.sh`) — only if the client half is also ready to ship.

#### Two things worth knowing before you deploy (2026-08-26)

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

## Feedback notifications (optional)

Bug reports always land in the `feedback` table and are read with `npm run feedback:list`. A
mail notification on top is opt-in and inert until four env vars exist — `POSTBOX_KEY_ID` and
`POSTBOX_SECRET` (a Yandex Cloud Postbox API key with the `yc.postbox.send` scope, bound from
Lockbox) plus `FEEDBACK_MAIL_FROM` (an address verified in Postbox) and `FEEDBACK_MAIL_TO`.
Missing any of them, `sendFeedbackMail` returns immediately and nothing else changes.

The send is deliberately defensive: a 4-second timeout, at most 20 mails an hour per warm
instance, and every error swallowed after a log line. The report is saved before the mail is
attempted, so a broken SMTP path can lose a notification but never a report.

One-time setup, all of it outside this repo: create the sending service account with the
`postbox.sender` role, create the API key, add the Postbox address for the domain and its DKIM
records in the DNS zone, put the key in Lockbox, then bind the secret and set the two addresses
in `deploy.env`.

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
