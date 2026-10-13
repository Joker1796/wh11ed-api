# wh11ed-api

The backend of **[WH Rules](https://wh-rules.ru)** (frontend:
[Joker1796/wh11ed](https://github.com/Joker1796/wh11ed)). The app works without it — rules, roster
builder, tracker and offline mode are all client-side — so this service is optional
infrastructure: if it is down, nobody loses a game, they lose sync.

What it does:

- **Accounts and cloud backup** — sign-in with Yandex (OAuth, no passwords); finished games, army
  lists and a player's marks (favourite units, pinned factions, model collection) follow the
  account across devices. `localStorage` stays the primary store; the cloud is a copy.
- **A shared live game** (`/party`) — several phones play one game in progress, each scoring its own
  side, with a lobby for setting the game up together. The only place the server holds live state.
- **Broadcast** — a public read-only feed of one live game for an OBS overlay.
- **The release-notes archive** — older "What's new" entries the frontend no longer ships.
- **Bug reports** — the app's anonymous report form, with an optional mail notification.

Stack:

- **Code:** TypeScript + [Hono](https://hono.dev) on Node 22 (`@hono/node-server`), run by `tsx`
- **DB:** PostgreSQL 17 — plain SQL files in `migrations/`, the `postgres` driver
- **Mail:** any SMTP relay (Mailpit on the local stand)
- **Hosting:** one Selectel server with Docker and Caddy (README "Deploy"); until 2026-10-11 it ran
  on Yandex Cloud Functions + YDB, which the Yandex outage of that day retired. `infra/` still
  describes that old setup and goes when it is shut down.

## Architecture

```
SPA (wh-rules.ru)  ──fetch──▶  api.wh-rules.ru  ──▶  Node (Hono)  ──▶  PostgreSQL
   Bearer access token (in memory) on /games, /rosters, /prefs, /me
   member token on /party/{id}/*  ·  credentials:'include' on /auth/refresh
```

All HTTP logic lives behind `app.fetch(Request): Promise<Response>` (`src/app.ts`); `src/server.ts`
serves it and runs the sweep that removes expired sessions, broadcasts and parties
(`src/db/sweep.ts` — what YDB's TTL used to do). Routes never touch the database directly:
`routes/*` → `domain/*` + `db/*.repo.ts` → `db/driver.ts`.

## Auth (Authorization Code + PKCE)
1. SPA → `GET /auth/{provider}/login` — the API stores `state`+PKCE in a short signed cookie, redirects to provider.
2. Provider → `GET /auth/{provider}/callback` — the API exchanges the code **server-side**
   (client secret from the server's environment), fetches identity, upserts the user, creates a session, sets the
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

On the local stand the same contract is browsable and runnable as Swagger:
http://localhost:8787/swagger (the spec at `/openapi.json`), generated from the code's own zod
schemas — see [DEVELOPMENT.md](DEVELOPMENT.md#the-api-description-swagger). Stand only; production
does not have it.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | – | liveness |
| GET | `/auth/{provider}/login` | – | start OAuth (`provider` = `yandex`); optional `?return=<origin>` — an https origin from `ALLOWED_ORIGINS` (the tracker beta) the callback sends the player back to |
| GET | `/auth/{provider}/callback` | – | OAuth redirect target. A failed login redirects to the site's after-login page with `?error=<reason>` — the provider's own code (`unauthorized_client`, `access_denied`…) or ours (`missing_state_cookie`, `bad_state_cookie`, `state_mismatch`, `missing_code_or_state`, `oauth_failed`) — and logs `[auth] <provider> login failed: <reason>` with the user agent |
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
| GET | `/changelog?before=&limit=` | – | **public** release-notes archive, newest first: `{ entries: [{ version, date, en, ru }], more }` — entries strictly older than `before` (a version; omitted = from the newest archived), `limit` 1–20 (default 10); `Cache-Control: public, max-age=3600`. See "The release-notes archive" |
| POST | `/feedback` | – | anonymous bug report `{ message, context?, attachment?, website? }` (honeypot `website`; per-IP throttle; read via `npm run feedback:list`, cleared with `npm run feedback:delete`) |
| POST | `/party` | Bearer | the host shares the game in progress: `{ gameId, slices, seat, name }` → `{ partyId, memberId, memberToken, seq, versions, you, invite: { token, code, codeExpiresAt } }` |
| POST | `/party/join` | – | exchange an invite for a member token: `{ code }` or `{ invite }`, plus the phone's tracker generation `gen` (missing = 1) → `{ partyId, memberId, memberToken, seq, status, slices, members, you }` (per-IP throttle; the code lives 10 minutes). A `gen` other than the game's `shared.trackerGen` (missing = 1) is `409 { error: 'tracker_version', gen }` — the beta tracker and the site's do not share games |
| POST | `/party/{id}/reclaim` | Bearer | the creating account gets a fresh host token (a lost phone); body `{ gen? }` checked as on join; same body as join's answer |
| GET | `/party/{id}` | member | the whole game: `{ seq, status, slices, members, you }` |
| POST | `/party/{id}/seat` | member | take a seat `{ side, mi, name }` → `{ seq, you }`; 409 `seat_taken` with `heldBy` when a live member holds it |
| POST | `/party/{id}/sync` | member | `{ since, slices? }` → 204 nothing new · 200 `{ seq, status, you, written, slices }` · 409 `version_conflict` · 423 `read_only` · 403 `forbidden_slice` — see below |
| POST | `/party/{id}/leave` | member | a guest leaves: its token dies, its seat is free (the host ends or hands over instead) |
| GET | `/party/{id}/members` | member | who is in: `{ members: [{ memberId, name, side, mi, host, lastSeenAt, you }] }` |
| GET | `/party/{id}/invite` | host | the current invite (`code` null once it expired) |
| POST | `/party/{id}/invite` | host | a fresh code; `{ link: true }` also replaces the link token (the old link dies) |
| POST | `/party/{id}/members/{mid}/seat` | host | move another member (`side: null` unseats) |
| POST | `/party/{id}/reseat` | host | swap the two sides across every live seat in one statement → `{ seq, you, held }` (see "Setting the game up together") |
| POST | `/party/{id}/members/{mid}/kick` | host | revoke that member's token now; its seat is free |
| POST | `/party/{id}/host` | host | hand the host role to `{ memberId }` |
| DELETE | `/party/{id}` | host | end the party: every row and every token |
| GET | `/prefs` | Bearer | every scope of the player's own marks at once: `{ scopes: [{ scope, version, updatedAt, data }] }`; `ETag`/`If-None-Match` → 304 |
| PUT | `/prefs/{scope}` | Bearer | write one scope: `{ version, data }` → `{ ok, scope, version }`; 409 `version_conflict` with `current` attached when the version has been overtaken (`scope` = a faction slug, or `@factions` for the pinned-faction list) |
| GET | `/rosters?limit=` | Bearer | list metadata **only** — live `{ rosterId, name, faction, updatedAt, points, unitCount }` and tombstones `{ rosterId, deleted: true, deletedAt }` |
| GET | `/rosters/{id}` | Bearer | full roster blob |
| PUT | `/rosters/{id}` | Bearer | idempotent upsert (body = roster JSON; `id` must match path; a wizard draft is rejected 422) |
| DELETE | `/rosters/{id}?at=` | Bearer | tombstone (`at` = deleting client's epoch-ms clock; defaults to the server's) |

### The release-notes archive (`/changelog`)

The frontend's "What's new" page ships only its last few releases (`wh11ed/src/data/changelog.js`);
everything older lives here and is read page by page, only by a reader who asks for it — notes almost
nobody reads stay out of the app's first load and out of the installed app's offline download
(owner's call, 2026-09-27).

- **An entry is the frontend's own shape**: `{ version, date: 'YYYY-MM-DD', en, ru }`, where `en`/`ru`
  are parallel lists of bullet strings and `{ h }` headings. Validated for shape, EN/RU parity and
  size (`src/domain/changelog.ts`); the wording is the frontend's.
- **Ordered by version as a number** (`rank`, the table's key): 2.10.0 comes after 2.9.9.
- **Written only by `npm run changelog:publish -- <entries.json>`** (needs `DATABASE_URL`, like `migrate`), never
  over HTTP. It validates every entry before writing any, upserts (idempotent by version), reads
  the rows back and compares them byte for byte; exit 0 means they are there. The frontend's deploy
  calls it with the entries it is about to drop from its file, and drops them only on exit 0.
- A page never goes stale: new entries are always OLDER than what the page before them already
  returned (they move in from the top of the frontend's file), so a cached page stays right.

### A player's marks (`/prefs`)

Pinned factions, favourite datasheets and the "I own this box" collection — device-local until a
player signs in, and then theirs rather than their phone's. Opaque JSON like a game or a roster:
the server never looks inside, because deciding what a mark means (which datasheet id replaced
which, when a unit left the game) needs the rules data, and only the client ships that.

Two things differ from `/rosters`, and both follow from what these are:

- **One row per scope, not one document.** A mark is a single tap on a crowded screen, and a tap
  must not rewrite everything a player ever marked. `scope` is the faction slug; the pinned-faction
  list belongs to no faction and lives under `@factions` (an `@` cannot occur in a slug).
- **Optimistic concurrency, not last-write-wins.** Marks merge cell by cell on the client, so a
  blind overwrite would drop whatever another device added between this one's read and its write.
  A `PUT` carries the `version` it merged from; a stale one comes back `409 version_conflict` with
  the row that beat it attached, so the retry merges instead of guessing and costs no extra `GET`.

The read is one request per visit and carries an `ETag` over the `(scope, version)` pairs: a visit
that changed nothing is a `304` with no body. Fetching faction by faction would be the wrong trade
— the gateway's budget is counted in requests, and a whole shelf is a few kilobytes.

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

**Polling etiquette.** Send `If-None-Match` and poll no faster than once a second: one
address may make 1200 requests a minute across the WHOLE API (logins, sync and shared games included), and the
app's own overlay spends 12 of them per viewer at its 5-second cadence. The read protects itself — a
in-process micro-cache (2 s) means every viewer of one game shares a single database read,
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

**How it is stored.** The payload is opaque like a game blob — the phone projects the read-only
scoreboard itself, so nothing private can reach the public endpoint. The token is 128 random bits
(an unlisted-link model: the URL is the credential); rows live in the `broadcasts` table and expire
(`broadcastTtlDays`, 7 days past the last touch; the public read checks `expires_at`, the sweep removes the row). Only the public `GET` has open CORS
(`src/app.ts`); the push endpoint `/broadcast/live/*` keeps the allow-list like everything else.

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

**Setting the game up together.** A party may be created from a game the players are still
SETTING UP (`phase: 'setup'` in the shared slice) — the server does not care, the blobs are
opaque and only `finished` means anything to it. The whole lobby protocol (who fills in which
side, whether it is confirmed, a request to reopen it) lives inside the slices, so it needs
nothing here. One thing does: **`POST /party/{id}/reseat`** (host only) swaps the two sides
across every live seat in ONE statement — `side 0 ↔ 1`, the member index inside a doubles team
untouched — and answers `{ seq, you, held }`. The client puts the first-turn player at index 0
when the game starts, so the five slices are rewritten with the sides exchanged and the seats
have to travel with them; done with the seat endpoint it would take three calls and could stop
half way, leaving a guest with no seat and a `403` on everything it writes.

**Cost.** Polling phones are the load, so the reads behind them are shared: a party's state is
served from process memory for three seconds after a read and dropped on any write to it — every
phone of one party in that window costs one database read. A member's `lastSeenAt` is
written at most every 30 s. Joins are throttled per address (10 a minute — a code is six digits
and lives ten minutes, so a guesser sees it expire long before the odds mean anything); syncs per
MEMBER (60 a minute), never per address, because a tournament hall puts every phone behind one
NAT. Four phones at a three-second tick are 80 requests a minute for ONE game — the number the
API-wide ceiling of 1200 a minute per address (`src/lib/rate-limit.ts`) is sized by: a venue's
shared address carries a dozen games with room to spare.

**Lifetime.** Rows in `parties`, `party_members` and `party_state` expire 7 days past the last
write (members past their last touch) and are swept (`src/db/sweep.ts`); `DELETE /party/{id}` ends it at once. A
member token is stored hashed like a refresh token; the invite token is stored plain like a
broadcast token — the link is the credential. Kicking a member clears its token immediately (the
in-memory member cache is dropped with it; a second process, if one ever runs, learns within 15 s).

### Army lists (`/rosters`)

`/rosters` mirrors `/games` with two deliberate differences. The list endpoint returns metadata
without blobs, so entering the app's roster screen costs one small request and only the lists
whose `updatedAt` actually moved are downloaded. And **DELETE tombstones instead of removing**:
the row stays, emptied of everything but its id and `deleted_at`, and the list endpoint reports
it — otherwise a second device still holding the list would see an id the cloud lacks and upload
it straight back. A tombstone is outranked by a list saved after it (both timestamps are the
client's epoch-ms clock, so they compare directly), and tombstones older than 180 days are swept
on the next delete. Caps: 32 KB per roster, 200 rosters per user; tombstones don't count.

## The local stand (docker)

The whole backend on your machine — PostgreSQL, this API, a stand-in for Yandex sign-in and a mail
catcher — with no cloud account and no secrets. **[DEVELOPMENT.md](DEVELOPMENT.md) is the
walkthrough** (first run, test players, several "phones", tests, troubleshooting); the short form:

```bash
npm run stand          # everything up and healthy (docker compose)
npm run stand:seed     # test players Алиса / Боб / Вера and their data
cd ../wh11ed && npm run dev    # the site on :5173, already pointed at this API
```

Sign-in on the stand is the production code path end to end: the API redirects to
`stand/fake-oauth.mjs`, which answers Yandex's three requests in Yandex's own shapes. The only
switch is three `OAUTH_YANDEX_*` URLs in `config.ts`, set by the compose file and by nothing in
production.

## Local development without docker

```bash
npm install
cp .env.example .env          # DATABASE_URL to any Postgres you have
npm run migrate
npm run dev                   # http://localhost:8787
npm test                      # unit tests: routes, domain, config — no database
npm run test:db               # the SQL against the Postgres in DATABASE_URL (a `<db>_test` database)
npm run typecheck
```

## Deploy

One server (Selectel, Saint Petersburg, `wh-rules-api`), everything in Docker: Caddy (TLS, the only
thing listening outside) → the API → PostgreSQL. The files are `deploy/`; on the server they live
in `/opt/wh-rules/` with the code under `app/`. Login: `ssh -i ~/.ssh/wh_rules_vps wh@<server>`
(root and passwords are off; ufw allows 22/80/443 — and Docker publishes only Caddy's ports, since
its own iptables rules walk past ufw).

**First time on a server:**
1. `/opt/wh-rules/.env` from `deploy/.env.prod.example`, `chmod 600`.
2. Copy `deploy/Caddyfile` and `deploy/docker-compose.prod.yml` next to it; the code to `app/`
   (`git archive` of the release, or rsync of a checkout without `node_modules`).
3. `docker compose -f docker-compose.prod.yml up -d --build` — migrations run on the API's start.
4. Point DNS at the server (Selectel zone; TTL 300 a day before). Caddy issues each name's
   certificate once its record resolves here — not before, so do not start it with names that still
   point elsewhere for long (Let's Encrypt limits failed attempts).

**A release:** new code into `app/`, then `docker compose -f docker-compose.prod.yml up -d --build api`.
Schema first, API second, client last (below).

**Backups** (`deploy/backup.sh`, nightly from cron): `pg_dump` → `age` → S3 at a different company
than the server. The server holds only the age **public** key; the private one is on the owner's
machine (`~/.config/wh-rules/backup-age.key`), so neither a leaked server nor a leaked bucket
reveals anything. 14 dailies + 12 monthlies.

**Restore** (checked on the stand 2026-10-11 — every table's row count came back equal):
```bash
age -d -i ~/.config/wh-rules/backup-age.key wh-<stamp>.dump.age > wh.dump
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U wh -d wh --clean --if-exists --no-owner < wh.dump
```

### Changing the schema

A change is a **new** file in `migrations/` (`002_….sql`), never an edit to one that has run:
`schema_migrations` records what ran, so an edited file is never applied again anywhere. The API
container applies new files on start (`npm run migrate` in the compose entrypoint), and the order
of a release stays **schema, then API, then client** — a server that reads a column the database
lacks fails every request touching it; a column nothing reads yet costs nothing.

## Feedback notifications (optional)

Bug reports always land in the `feedback` table and are read with `npm run feedback:list`;
once dealt with they are removed with `npm run feedback:delete -- <id-prefix> …` — the table is an
inbox, the verdicts live in the changelog and the hub's journals (`npm run users:count` is the other
read-only admin query). All of them need `DATABASE_URL`.

A mail notification on top is opt-in and inert until `SMTP_HOST`, `FEEDBACK_MAIL_FROM` and
`FEEDBACK_MAIL_TO` exist (`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` as the relay needs).
Missing any of the three, `sendFeedbackMail` returns immediately and nothing else changes. On the
stand the mail goes to Mailpit, http://localhost:8025.

Production sends through a send-only app password of a Mail.ru mailbox. **The server's provider
(Selectel) blocks outgoing ports 25, 465 and 587** — a send there times out after 4 s with no other
sign; Mail.ru also listens on 2525 (STARTTLS), which is open. Check a port from the server with
`timeout 8 bash -c '</dev/tcp/smtp.mail.ru/2525'`.

The send is deliberately defensive: a 4-second timeout, at most 20 mails an hour per process, and
every error swallowed after a log line. The report is saved before the mail is attempted, so a
broken SMTP path can lose a notification but never a report.

## Security notes
- TLS only; CORS locked to `ALLOWED_ORIGINS` with credentials (no wildcard).
- Refresh tokens are opaque, stored only as SHA-256 hashes, single-use (rotated on every refresh), and
  expire: `expires_at` is checked on use and swept every ten minutes (`src/db/sweep.ts`). `/games*`, `/rosters*` and `/prefs*` are Bearer-only → not
  CSRF-able.
- A disallowed `Origin` gets the canonical origin back rather than no header (`corsOrigin` in
  `src/config.ts`) — on Yandex's platform an absent header used to be filled in with `*`, and a
  proxy in front could do the same. The one deliberate exception is the public broadcast read.
- All inputs validated with zod, every blob capped (`src/config.ts`): a game 64 KB and 500 per user,
  a roster 32 KB and 200 per user, a marks scope 64 KB, a party slice 32 KB, a broadcast 16 KB.
- Member and refresh tokens stored only as hashes; invite and broadcast tokens are the link itself.
- Secrets only in the server's environment (never in git); per-IP and per-member throttles where a
  route is public or polled, and over them one API-wide ceiling per address (1200 a minute,
  `429 too_many` with `Retry-After`; `/health` exempt) in place of the Yandex gateway's limit.
