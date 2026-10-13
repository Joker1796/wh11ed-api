# Developing WH Rules locally

Everything the site needs, on your machine: the backend (PostgreSQL, this API, a stand-in for
Yandex sign-in, a mail catcher) in Docker, and the frontend's dev server next to it. No cloud
account, no secrets, no production data — and nothing you do here reaches the real site.

## What you need

- **Docker Desktop** (or any Docker with Compose v2), running.
- **Node 22+** and npm.
- Both repositories cloned **side by side**:

  ```bash
  git clone https://github.com/Joker1796/wh11ed.git
  git clone https://github.com/Joker1796/wh11ed-api.git
  ```

## First run

```bash
cd wh11ed-api
npm run stand          # pulls images the first time (a few minutes), then waits until all is healthy
npm run stand:seed     # test players and their data

cd ../wh11ed
npm install            # once
npm run dev            # the site: http://localhost:5173
```

That is all. The site's default API address is already `http://localhost:8787`, so the frontend
needs no configuration.

| What | Where |
|---|---|
| The site | http://localhost:5173 (`/ru` for Russian) |
| The API | http://localhost:8787/health |
| The API description (Swagger), stand only | http://localhost:8787/swagger — the raw spec at `/openapi.json` |
| Mail (Mailpit): bug reports, confirm-email and reset-password letters | http://localhost:8025 |
| The sign-in page | opens by itself from "Войти" in the ⚙ menu |
| The database | `npm run stand:psql`, or any client on `localhost:5433`, user/password/db `wh` |

## Signing in

"Войти" in the site's ⚙ menu goes through the API's real sign-in code to a page that plays Yandex
(`stand/fake-oauth.mjs`). Pick a player:

| Player | What the account holds after `stand:seed` |
|---|---|
| **Алиса** | three army lists, three finished games, two pinned factions, a live broadcast |
| **Боб** | one list, and one deleted list (a tombstone another device must learn about) |
| **Вера** | nothing — sign in with lists already on the device and watch them go up to the cloud |

Or type any name: a new, empty account, the same one every time you type that name.

**By email and password** — "Войти" → the email form. Every seeded login has the password
`stand-password` (`stand/email-logins.json`):

| Email | The account |
|---|---|
| `alice@stand.local` | Алиса's Yandex account — the same lists and games, a second way in |
| `gosha@stand.local` | Гоша: email only, no Yandex; one list |
| `dina@stand.local` | Дина: the address was never confirmed — the reminder and "send again" |

Registering a new address, confirming it and "Forgot your password?" all mail a link: open
Mailpit at http://localhost:8025 and follow it. To add an email sign-in to a Yandex account, sign in
as Боб or Вера — they have none. A re-seed puts `stand-password` back on the seeded logins;
`stand:reset` also drops the accounts registered by hand.

## Several "phones" in one browser

A shared game needs two to four devices. The browser keeps storage per **origin**, and the port is
part of the origin, so each port is an independent phone with its own lists and games:

```bash
cd wh11ed
npm run dev                      # 5173 — the host
npm run dev -- --port 5174       # the opponent
npm run dev -- --port 5175       # a partner, in doubles
```

The API allows 5173–5176. A sign-in returns to the port it started from when the frontend says
where it came from (`?return=` — the tracker beta does; until that reaches `main`, a sign-in on
5174 lands on 5173: open 5174 again and it is signed in, the session cookie is shared by
`localhost`).

**One browser is one account.** Cookies ignore the port, so every port shares the sign-in: phones
on 5173–5176 keep separate lists and games, but the account is the same. A second account at the
same time — a private window, or another browser. A shared game itself needs only one account:
guests join by the invite and never sign in.

## The API description (Swagger)

http://localhost:8787/swagger lists the routes with what each takes and returns, and runs them
against the stand. A route behind an account needs a token: open `/dev/jwt`, copy `token`, paste it
into **Authorize** (it survives a reload).

It exists on the stand only — `SWAGGER: "1"` in `docker-compose.yml`, like `DEV_JWT`; without the
flag the two routes are not registered, and the production image does not even install the packages
(`devDependencies`). It is generated from the code's own zod schemas (`src/openapi/`): a request is
described by the schema the route validates with, and where an answer has a type in `domain/`
(the roster, game and marks lists) that type is inferred from the described schema.

**On the stand every JSON answer is checked against its description** as it goes out: an answer
that does not match, or a status nobody described, is a `[openapi]` line in `npm run stand:logs`.
The answer itself is untouched. `test/openapi-check.test.ts` makes that check fire.

**A new route** is described in `src/openapi/<area>.ts` with `describe()` (copy `rosters.ts`):
export the route's zod schemas and read them there, never restate them. `test/openapi.test.ts`
fails on a route the description does not list. The exact thresholds of the abuse fences are not
written into descriptions — a route says it can answer 429, and that is all.

## Everyday commands (in wh11ed-api)

```bash
npm run stand          # start (or restart after a change to docker-compose.yml)
npm run stand:seed     # add the test data — safe to repeat
npm run stand:reset    # wipe the database, migrate from scratch, seed
npm run stand:logs     # follow the API's log
npm run stand:psql     # a psql prompt in the stand's database
npm run stand:test     # the database tests (in a separate *_test database — your data stays)
npm test               # the unit tests — no database, no docker
npm run stand:down     # stop everything (the data survives; stand:reset clears it)
```

The API in the container reloads on every save under `src/`. A new file in `migrations/` is applied
the next time the container starts (`npm run stand`), or right away with
`docker compose exec api npm run migrate`.

## When something is off

- **A port is taken.** Every host port moves with a variable: `STAND_PG_PORT` (5433),
  `STAND_OAUTH_PORT` (8790), `STAND_MAIL_PORT` (8025) — e.g. `STAND_PG_PORT=5444 npm run stand`.
  The API's 8787 stays: it is the frontend's default address.
- **A phone on another port gets CORS errors.** Only 5173–5176 are allowed (`ALLOWED_ORIGINS` in
  `docker-compose.yml`).
- **Signed in, but the site still says "not signed in".** A leftover dev-mock session: in the ⚙
  menu choose «тест-выход», then sign in again.
- **`npm run stand` stops at "dependency fake-oauth failed to start".** Its health check can break
  after Docker restarts under it ("current working directory is outside of container mount
  namespace"); `docker compose restart fake-oauth`, then `npm run stand` again.
- **The API container keeps restarting.** `npm run stand:logs` — usually a failed migration or an
  install error. After a dependency change: `docker compose down -v` (drops the database and the
  container's node_modules) and `npm run stand`.
- **Start over completely:** `docker compose down -v && npm run stand && npm run stand:seed`.

## Where to read next

- `README.md` — the HTTP contract, sign-in flow, what each endpoint guarantees.
- `CLAUDE.md` — the code's layout and the things in it that must not be "fixed".
- `../wh11ed/CLAUDE.md` — the frontend, which is most of the product.
