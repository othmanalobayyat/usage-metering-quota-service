# Usage Metering and Quota Service

A backend that other applications call before they perform a metered action. The calling application (an account) identifies itself with an API key and asks the service to consume a number of units for one of its users. The service checks the account's plan and the user's plan, accepts the full amount only if every rule allows it, records the decision, and counts the units if it accepted them. Accounts can use predefined plans or create their own, and plan changes take effect on the next request, with no redeploy. Usage and request history are kept per month in PostgreSQL.

Stack: TypeScript, Express 5, Drizzle ORM, PostgreSQL 16, Zod, Vitest + Supertest, Docker Compose, k6.

## Contents

1. [Quick start](#quick-start): [demo client](#demo-client), [tests](#tests), [configuration](#configuration), [running without Docker](#running-the-api-without-docker)
2. [Accounts, users and API keys](#accounts-users-and-api-keys)
3. [API reference](#api-reference): [errors](#errors)
4. [Rules](#rules): [supported rules](#supported-rules), [predefined plans](#predefined-plans), [check order](#check-order), [plan changes](#plan-changes), [retries and replays](#retries-and-replays), [plan changes under concurrency](#plan-changes-under-concurrency)
5. [Design decisions](#design-decisions): [the consume transaction](#the-consume-transaction), [other decisions](#other-decisions), [WORKERS](#workers)
6. [Assumptions](#assumptions)
   - [API shape](#api-shape)
   - [Plans](#plans)
   - [Consume and retries](#consume-and-retries)
   - [Usage and history](#usage-and-history)
   - [Example client](#example-client)
   - [Operation](#operation)
   - [Known limitations](#known-limitations)
7. [Load test summary](#load-test-summary)

## Quick start

Requires Docker with Compose v2.

```sh
docker compose up --build
```

This starts three services:

| Service | URL | Notes |
|---|---|---|
| `db` | `localhost:5433` (`DB_PORT`) | PostgreSQL 16, user/password/database `quota` |
| `api` | `http://localhost:3000` | Runs migrate, then seed, then the server. Healthy once `GET /healthz` returns 200. |
| `client` | `http://localhost:8081` (`CLIENT_PORT`) | Example client. Starts after the API is healthy. |

No manual steps are needed on a fresh clone. The seed is idempotent, so restarting the API is safe. `docker compose down -v` stops everything and drops the database volume.

All data (accounts, plans, usage, request history) is in PostgreSQL, on the named Compose volume `db-data`. It survives `docker compose restart` and `docker compose down` followed by `up`. Only `docker compose down -v` deletes it.

### Demo client

Open `http://localhost:8081` and press **Run demo**. The client's own server runs the whole demo against the API on a fresh account and the page shows each step: the decision, `reasonCode`, `rejectedBy`, `limit`, and both remaining values. The same run is available without a browser:

```sh
curl -s -X POST http://localhost:8081/demo/run
```

Setup: create an account, then a custom account plan with 200 units/month and 50/request, and assign it to the account. Register Alice on Basic and Bob on Premium. Then:

1. Alice consumes 10: accepted.
2. Alice consumes 25: rejected, `USER` / `PER_REQUEST_LIMIT_EXCEEDED` (Basic allows 20 per request).
3. Switch Alice to Premium.
4. Alice consumes 25 again with a new `requestId`: accepted. The client code didn't change, only Alice's plan.
5. Bob consumes 50, 50, 50, 15 (accepted, the account reaches exactly 0 remaining), then 50: rejected, `ACCOUNT` / `MONTHLY_LIMIT_EXCEEDED`, limit 200.

Each step is checked against fixed expected values in `client/src/demo.ts`. The run reports `"ok": true` only if all of them match.

### Tests

Requires Node 22+. The integration tests use a separate `quota_test` database on the Compose PostgreSQL, so only `db` has to run:

```sh
npm install
docker compose up -d db
npm test
```

`tests/global-setup.ts` creates, migrates and seeds `quota_test` before the first test file. Tests truncate its tables, so the setup refuses any database whose name doesn't end in `_test`. Override the URL with `TEST_DATABASE_URL` (default `postgres://quota:quota@localhost:5433/quota_test`). If the database is unreachable, the integration suites skip themselves. Set `REQUIRE_DB=1` to make that a failure instead.

Other commands:

| Command | What it does |
|---|---|
| `npx vitest run tests/consume.db.test.ts` | One test file |
| `npx vitest run -t "returns 503"` | Tests whose name matches |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |
| `npm run lint` | ESLint |
| `npm run build` / `npm start` | Compile to `dist/` and run it. Needs the environment from `.env.example` ([running without Docker](#running-the-api-without-docker)). |
| `npm run dev` | `src/server.ts` under tsx in watch mode. Same environment as `npm start`. |

### Configuration

The API reads its environment through `src/config.ts` and exits on startup if it is invalid.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgres://` or `postgresql://` URL |
| `PORT` | `3000` | HTTP port |
| `WORKERS` | `1` | API processes, 1 to 8. See [WORKERS](#workers). |

### Running the API without Docker

`npm start` and `npm run dev` read the same variables as the container. Nothing loads a `.env` file, so export the variables from `.env.example` into the shell first. It points `DATABASE_URL` at the Compose database on `localhost:5433`:

```sh
docker compose up -d db
set -a; . ./.env.example; set +a       # exports DATABASE_URL, PORT, WORKERS, DB_PORT
npm run db:migrate && npm run db:seed  # what the container entrypoint does before starting
npm run dev                            # or: npm run build && npm start
```

Without `DATABASE_URL`, the server exits on startup with `Invalid environment configuration`. The Compose `api` service also listens on port 3000, so stop it first (`docker compose stop api`) or run with `PORT=3001`.

## Accounts, users and API keys

- An **account** is an application calling the service. It has one account plan, whose limits are shared by all its users, and one API key.
- A **user** belongs to one account and has one user plan, with the user's individual limits. The calling application chooses the user's ID (`externalUserId`, 1 to 128 characters), and the API addresses users only by it. The same `externalUserId` can exist under different accounts.
- A **plan** is either an `ACCOUNT` plan or a `USER` plan. Predefined plans are visible to every account and are read-only. An account can create, view and update its own custom plans and assign them to itself or its users. Several users can share a plan, and each still has its own usage total.
- New accounts start on Starter and new users on Basic.

Both plans apply to every consume. A larger user plan doesn't increase the account's shared allowance.

**Getting a key.** [`POST /accounts`](#post-accounts) creates the account and returns its key once. It is the only endpoint, besides `/healthz`, that needs no key. The key is `mk_` followed by 32 random bytes in base64url. The service stores only its SHA-256 hash, so a lost key can't be recovered or shown again.

**Using it.** Send the key in the `X-API-Key` header on every other request. It identifies the account. Every query is scoped to that account, and any resource of another account (a user, a custom plan) returns 404, the same as one that doesn't exist.

## API reference

All bodies are JSON. The examples need `curl` and `jq`, and they build on each other: run them in order and they work on a fresh stack. Each response below is the real output of that command, run in this order against the Compose stack on a new account. IDs, timestamps, cursors and the key differ on every run. The JSON below is pretty-printed for reading. `curl -s` prints each body on one line; append `| jq .` to get the same layout. Long responses are shortened where marked with `...`. Every error code is listed in the [error table](#errors).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | [`/healthz`](#get-healthz) | no | Process and database check |
| POST | [`/accounts`](#post-accounts) | no | Create an account; returns the API key once |
| GET | [`/account`](#get-account) | yes | The account, its plan and its current-month usage |
| GET | [`/plans`](#get-plans) | yes | Predefined plans and this account's custom plans |
| POST | [`/plans`](#post-plans) | yes | Create a custom plan |
| GET | [`/plans/:id`](#get-plansid) | yes | One plan |
| PATCH | [`/plans/:id`](#patch-plansid) | yes | Update a custom plan |
| PUT | [`/account/plan`](#put-accountplan) | yes | Switch the account plan |
| POST | [`/users`](#post-users) | yes | Register a user |
| GET | [`/users`](#get-users) | yes | List users, cursor-paginated |
| GET | [`/users/:externalUserId`](#get-usersexternaluserid) | yes | One user, its plan and its current-month usage |
| PUT | [`/users/:externalUserId/plan`](#put-usersexternaluseridplan) | yes | Switch a user's plan |
| POST | [`/consume`](#post-consume) | yes | Consume units for a user; returns the decision |
| GET | [`/usage`](#get-usage) | yes | Account usage for a month |
| GET | [`/users/:externalUserId/usage`](#get-usersexternaluseridusage) | yes | User usage for a month |
| GET | [`/requests`](#get-requests) | yes | Decision history, newest first, cursor-paginated |

Conventions:

- Request bodies are strict: an unknown field is a 400.
- Names (`name` on accounts, plans and users) are trimmed and must be 1 to 200 characters. `externalUserId` and `requestId` are 1 to 128 characters.
- Unknown query parameters are ignored.
- Lists return `{ "data": [...] }`. Paginated lists add `nextCursor`, which is `null` on the last page. Pass it back as `cursor`; anything that isn't a cursor the API issued is a 400. `limit` is 1 to 100, default 20.
- Usage always has the shape `{ "month": "YYYY-MM", "consumed", "remaining" }`. `GET /account` and `GET /users/:externalUserId` embed it as `usage`. `GET /usage` returns it on its own, and `GET /users/:externalUserId/usage` returns it with `externalUserId` added.
- `month` query parameters are strict `YYYY-MM` and default to the current UTC month on the usage endpoints.

### GET /healthz

```sh
curl -s http://localhost:3000/healthz
```

`200`:

```json
{
  "status": "ok",
  "db": "up"
}
```

If the database check fails it returns `503` with `{ "status": "unavailable", "db": "down" }`. The Compose healthcheck uses this endpoint.

### POST /accounts

Body: `name` (1 to 200 characters). No plan can be chosen here: the account starts on Starter. This command creates the account and keeps its key in `KEY` for the examples that follow:

```sh
KEY=$(curl -s -X POST http://localhost:3000/accounts \
  -H 'Content-Type: application/json' \
  -d '{"name":"Acme Docs"}' | jq -r .apiKey)
```

`201`, the full body before `jq` picks out the key, with the key shortened:

```json
{
  "id": "47518d57-8eff-4f64-836b-552a1911380a",
  "name": "Acme Docs",
  "apiKey": "mk_...",
  "plan": {
    "id": "00000000-0000-4000-8000-000000000001",
    "name": "Starter",
    "type": "ACCOUNT",
    "monthlyLimit": 10000,
    "perRequestLimit": 100,
    "predefined": true,
    "createdAt": "2026-10-15T18:12:07.725Z",
    "updatedAt": "2026-10-15T18:12:07.725Z"
  },
  "usage": {
    "month": "2026-10",
    "consumed": 0,
    "remaining": 10000
  },
  "createdAt": "2026-10-18T17:59:42.119Z"
}
```

`apiKey` appears only in this response.

### GET /account

```sh
curl -s http://localhost:3000/account -H "X-API-Key: $KEY"
```

`200`: the same shape as above without `apiKey`.

```json
{
  "id": "47518d57-8eff-4f64-836b-552a1911380a",
  "name": "Acme Docs",
  "plan": {
    "id": "00000000-0000-4000-8000-000000000001",
    "name": "Starter",
    "type": "ACCOUNT",
    "monthlyLimit": 10000,
    "perRequestLimit": 100,
    "predefined": true,
    "createdAt": "2026-10-15T18:12:07.725Z",
    "updatedAt": "2026-10-15T18:12:07.725Z"
  },
  "usage": {
    "month": "2026-10",
    "consumed": 0,
    "remaining": 10000
  },
  "createdAt": "2026-10-18T17:59:42.119Z"
}
```

### GET /plans

Optional `?type=ACCOUNT` or `?type=USER`. Predefined plans come first in seed order (Starter, Pro, Basic, Premium), then the account's custom plans, oldest first.

```sh
curl -s http://localhost:3000/plans -H "X-API-Key: $KEY"
```

`200`:

```json
{
  "data": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "name": "Starter",
      "type": "ACCOUNT",
      "monthlyLimit": 10000,
      "perRequestLimit": 100,
      "predefined": true,
      "createdAt": "2026-10-15T18:12:07.725Z",
      "updatedAt": "2026-10-15T18:12:07.725Z"
    },
    { "id": "00000000-0000-4000-8000-000000000002", "name": "Pro", ... },
    { "id": "00000000-0000-4000-8000-000000000003", "name": "Basic", ... },
    { "id": "00000000-0000-4000-8000-000000000004", "name": "Premium", ... }
  ]
}
```

Any other `type`:

```sh
curl -s "http://localhost:3000/plans?type=TEAM" -H "X-API-Key: $KEY"
```

`400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "type: Invalid option: expected one of \"ACCOUNT\"|\"USER\""
  }
}
```

### POST /plans

Body: `name` (1 to 200 characters, unique among this account's plans), `type` (`ACCOUNT` or `USER`), `monthlyLimit` (0 to 2147483647), `perRequestLimit` (1 to 2147483647). This command keeps the new plan's ID in `TEAM_ID`:

```sh
TEAM_ID=$(curl -s -X POST http://localhost:3000/plans -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Team","type":"ACCOUNT","monthlyLimit":500,"perRequestLimit":50}' | jq -r .id)
```

`201`, the full body before `jq`:

```json
{
  "id": "e6ae3635-82e3-4cf1-811d-8c633daadaf4",
  "name": "Team",
  "type": "ACCOUNT",
  "monthlyLimit": 500,
  "perRequestLimit": 50,
  "predefined": false,
  "createdAt": "2026-10-18T17:59:42.227Z",
  "updatedAt": "2026-10-18T17:59:42.227Z"
}
```

A second custom plan, used in the rename example under `PATCH`:

```sh
INTERNS_ID=$(curl -s -X POST http://localhost:3000/plans -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Interns","type":"USER","monthlyLimit":100,"perRequestLimit":10}' | jq -r .id)
```

`201` with `"id": "9ae9aaf8-e342-4fa0-a882-2658d19aba6e"` and the same shape as above.

A name this account already uses, of either type:

```sh
curl -s -X POST http://localhost:3000/plans -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Team","type":"USER","monthlyLimit":1,"perRequestLimit":1}'
```

`409`:

```json
{
  "error": {
    "code": "ALREADY_EXISTS",
    "message": "A plan named \"Team\" already exists"
  }
}
```

### GET /plans/:id

```sh
curl -s http://localhost:3000/plans/$TEAM_ID -H "X-API-Key: $KEY"
```

`200`: the plan, as in the `POST /plans` response. Another account's custom plan, an unknown ID or a malformed ID returns `404`.

### PATCH /plans/:id

Body: any of `name`, `monthlyLimit`, `perRequestLimit`, at least one. `type` can't be changed, because that would invalidate existing assignments. There is no `DELETE`.

The plan is checked before the body: a malformed ID, an unknown plan or another account's plan is `404`, and a predefined plan is `403`, whatever the body contains. Then the body is validated (`400`), and a new `name` this account already uses is `409`.

```sh
curl -s -X PATCH http://localhost:3000/plans/$TEAM_ID -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"monthlyLimit":600}'
```

`200`:

```json
{
  "id": "e6ae3635-82e3-4cf1-811d-8c633daadaf4",
  "name": "Team",
  "type": "ACCOUNT",
  "monthlyLimit": 600,
  "perRequestLimit": 50,
  "predefined": false,
  "createdAt": "2026-10-18T17:59:42.227Z",
  "updatedAt": "2026-10-18T17:59:42.370Z"
}
```

The new limits apply to the next consume by every account or user on this plan.

A predefined plan:

```sh
curl -s -X PATCH http://localhost:3000/plans/00000000-0000-4000-8000-000000000001 \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"monthlyLimit":1}'
```

`403`:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Predefined plans are read-only"
  }
}
```

Renaming Interns to a name the account already uses:

```sh
curl -s -X PATCH http://localhost:3000/plans/$INTERNS_ID -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Team"}'
```

`409`:

```json
{
  "error": {
    "code": "ALREADY_EXISTS",
    "message": "A plan named \"Team\" already exists"
  }
}
```

A malformed ID is `404`, even with a body that would be a 400 (`type` can't be patched):

```sh
curl -s -X PATCH http://localhost:3000/plans/not-a-uuid -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"type":"USER"}'
```

`404`:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Plan not found"
  }
}
```

The Team plan, patched with a second account's key:

```sh
OTHER_KEY=$(curl -s -X POST http://localhost:3000/accounts \
  -H 'Content-Type: application/json' \
  -d '{"name":"Other Co"}' | jq -r .apiKey)
curl -s -X PATCH http://localhost:3000/plans/$TEAM_ID -H "X-API-Key: $OTHER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"monthlyLimit":1}'
```

`404`, the same as an unknown plan:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Plan not found"
  }
}
```

### PUT /account/plan

Body: `planId` (required). The plan must be predefined or owned by this account (else `404`) and of type `ACCOUNT` (else `400`). Usage is kept.

```sh
curl -s -X PUT http://localhost:3000/account/plan -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"planId\":\"$TEAM_ID\"}"
```

`200`:

```json
{
  "id": "47518d57-8eff-4f64-836b-552a1911380a",
  "name": "Acme Docs",
  "plan": {
    "id": "e6ae3635-82e3-4cf1-811d-8c633daadaf4",
    "name": "Team",
    "type": "ACCOUNT",
    "monthlyLimit": 600,
    "perRequestLimit": 50,
    "predefined": false,
    "createdAt": "2026-10-18T17:59:42.227Z",
    "updatedAt": "2026-10-18T17:59:42.370Z"
  },
  "usage": {
    "month": "2026-10",
    "consumed": 0,
    "remaining": 600
  },
  "createdAt": "2026-10-18T17:59:42.119Z"
}
```

A user plan (here Basic) is the wrong type:

```sh
curl -s -X PUT http://localhost:3000/account/plan -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"planId":"00000000-0000-4000-8000-000000000003"}'
```

`400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "planId: expected a plan of type ACCOUNT, got USER"
  }
}
```

### POST /users

Body: `externalUserId` (1 to 128 characters, unique within the account), `name` (optional, 1 to 200 characters), `planId` (optional, default Basic; the same checks as `PUT /account/plan`, with type `USER`).

```sh
curl -s -X POST http://localhost:3000/users -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","name":"Alice"}'
```

`201`:

```json
{
  "externalUserId": "alice",
  "name": "Alice",
  "plan": {
    "id": "00000000-0000-4000-8000-000000000003",
    "name": "Basic",
    "type": "USER",
    "monthlyLimit": 1000,
    "perRequestLimit": 20,
    "predefined": true,
    "createdAt": "2026-10-15T18:12:07.725Z",
    "updatedAt": "2026-10-15T18:12:07.725Z"
  },
  "createdAt": "2026-10-18T17:59:42.610Z",
  "usage": {
    "month": "2026-10",
    "consumed": 0,
    "remaining": 1000
  }
}
```

Bob, with no name and no plan, so on Basic:

```sh
curl -s -X POST http://localhost:3000/users -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"bob"}'
```

`201` with `"name": null` and the Basic plan.

Registering `alice` again:

```sh
curl -s -X POST http://localhost:3000/users -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice"}'
```

`409`:

```json
{
  "error": {
    "code": "ALREADY_EXISTS",
    "message": "A user with externalUserId \"alice\" already exists"
  }
}
```

A 201-character name:

```sh
curl -s -X POST http://localhost:3000/users -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"externalUserId\":\"dave\",\"name\":\"$(printf '%201s' | tr ' ' x)\"}"
```

`400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "name: Too big: expected string to have <=200 characters"
  }
}
```

### GET /users

`?limit=` (1 to 100, default 20) and `?cursor=`. Oldest first. List entries have no `usage`.

```sh
curl -s "http://localhost:3000/users?limit=1" -H "X-API-Key: $KEY"
```

`200`:

```json
{
  "data": [
    {
      "externalUserId": "alice",
      "name": "Alice",
      "plan": { "id": "00000000-0000-4000-8000-000000000003", "name": "Basic", ... },
      "createdAt": "2026-10-18T17:59:42.610Z"
    }
  ],
  "nextCursor": "WyIyMDI2LTEwLTE4VDE3OjU5OjQyLjYxMFoiLCI3NWFmNGE2OC0yNmRiLTRmZjEtOGY2Ni03YTVkOGJkMTc3MTAiXQ"
}
```

The next page, passing `nextCursor` back:

```sh
CURSOR=$(curl -s "http://localhost:3000/users?limit=1" -H "X-API-Key: $KEY" | jq -r .nextCursor)
curl -s "http://localhost:3000/users?limit=1&cursor=$CURSOR" -H "X-API-Key: $KEY"
```

`200`:

```json
{
  "data": [
    {
      "externalUserId": "bob",
      "name": null,
      "plan": { "id": "00000000-0000-4000-8000-000000000003", "name": "Basic", ... },
      "createdAt": "2026-10-18T17:59:42.642Z"
    }
  ],
  "nextCursor": null
}
```

A cursor the API didn't issue:

```sh
curl -s "http://localhost:3000/users?cursor=abc" -H "X-API-Key: $KEY"
```

`400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "cursor: invalid cursor"
  }
}
```

### GET /users/:externalUserId

```sh
curl -s http://localhost:3000/users/alice -H "X-API-Key: $KEY"
```

`200`: the same shape as the `POST /users` response. `usage.remaining` is against the user's own plan only.

```json
{
  "externalUserId": "alice",
  "name": "Alice",
  "plan": {
    "id": "00000000-0000-4000-8000-000000000003",
    "name": "Basic",
    "type": "USER",
    "monthlyLimit": 1000,
    "perRequestLimit": 20,
    "predefined": true,
    "createdAt": "2026-10-15T18:12:07.725Z",
    "updatedAt": "2026-10-15T18:12:07.725Z"
  },
  "createdAt": "2026-10-18T17:59:42.610Z",
  "usage": {
    "month": "2026-10",
    "consumed": 0,
    "remaining": 1000
  }
}
```

An unknown user, or another account's user:

```sh
curl -s http://localhost:3000/users/carol -H "X-API-Key: $KEY"
```

`404`:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found"
  }
}
```

The same `404` comes back on every route that names a user: `GET /users/:externalUserId`, `GET /users/:externalUserId/usage`, `PUT /users/:externalUserId/plan`, `POST /consume`, and `GET /requests?externalUserId=`. In a URL path, an `externalUserId` longer than 128 characters is also a 404. In the `/consume` body or the `/requests` query it is a 400.

### PUT /users/:externalUserId/plan

Body: `planId` (required). The same checks as `PUT /account/plan`, with type `USER`. Usage is kept. Switch Bob to Premium:

```sh
curl -s -X PUT http://localhost:3000/users/bob/plan -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"planId":"00000000-0000-4000-8000-000000000004"}'
```

`200`:

```json
{
  "externalUserId": "bob",
  "name": null,
  "plan": {
    "id": "00000000-0000-4000-8000-000000000004",
    "name": "Premium",
    "type": "USER",
    "monthlyLimit": 5000,
    "perRequestLimit": 100,
    "predefined": true,
    "createdAt": "2026-10-15T18:12:07.725Z",
    "updatedAt": "2026-10-15T18:12:07.725Z"
  },
  "createdAt": "2026-10-18T17:59:42.642Z",
  "usage": {
    "month": "2026-10",
    "consumed": 0,
    "remaining": 5000
  }
}
```

### POST /consume

Body: `externalUserId`, `units` (integer, 1 to 2147483647), `requestId` (1 to 128 characters, chosen by the caller, unique per account).

The response is `200` for both accepted and rejected decisions. `remaining` is the allowance left after the decision. On an accepted decision, `reasonCode`, `rejectedBy` and `limit` are `null`. On a rejection, `limit` is the limit of the rule that blocked it. How a repeated `requestId` is handled is described in [Retries and replays](#retries-and-replays).

At this point the account is on Team (600/month, 50/request), Alice on Basic (1,000/month, 20/request) and Bob on Premium (5,000/month, 100/request).

```sh
curl -s -X POST http://localhost:3000/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":10,"requestId":"req-001"}'
```

`200`:

```json
{
  "requestId": "req-001",
  "status": "ACCEPTED",
  "reasonCode": null,
  "rejectedBy": null,
  "limit": null,
  "remaining": {
    "account": 590,
    "user": 990
  },
  "replayed": false
}
```

The same request again. Nothing is consumed, and the stored decision comes back with `replayed: true`:

```sh
curl -s -X POST http://localhost:3000/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":10,"requestId":"req-001"}'
```

`200`:

```json
{
  "requestId": "req-001",
  "status": "ACCEPTED",
  "reasonCode": null,
  "rejectedBy": null,
  "limit": null,
  "remaining": {
    "account": 590,
    "user": 990
  },
  "replayed": true
}
```

The same `requestId` with a different `units`:

```sh
curl -s -X POST http://localhost:3000/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":11,"requestId":"req-001"}'
```

`409`:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "requestId \"req-001\" was already used with a different externalUserId or units"
  }
}
```

25 units is over Basic's 20 per request:

```sh
curl -s -X POST http://localhost:3000/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":25,"requestId":"req-002"}'
```

`200`:

```json
{
  "requestId": "req-002",
  "status": "REJECTED",
  "reasonCode": "PER_REQUEST_LIMIT_EXCEEDED",
  "rejectedBy": "USER",
  "limit": 20,
  "remaining": {
    "account": 590,
    "user": 990
  },
  "replayed": false
}
```

The same 25 units for Bob, on Premium:

```sh
curl -s -X POST http://localhost:3000/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"bob","units":25,"requestId":"req-003"}'
```

`200`:

```json
{
  "requestId": "req-003",
  "status": "ACCEPTED",
  "reasonCode": null,
  "rejectedBy": null,
  "limit": null,
  "remaining": {
    "account": 565,
    "user": 4975
  },
  "replayed": false
}
```

Premium allows 100 per request, but the account plan allows 50:

```sh
curl -s -X POST http://localhost:3000/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"bob","units":60,"requestId":"req-004"}'
```

`200`:

```json
{
  "requestId": "req-004",
  "status": "REJECTED",
  "reasonCode": "PER_REQUEST_LIMIT_EXCEEDED",
  "rejectedBy": "ACCOUNT",
  "limit": 50,
  "remaining": {
    "account": 565,
    "user": 4975
  },
  "replayed": false
}
```

An unknown user:

```sh
curl -s -X POST http://localhost:3000/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"carol","units":1,"requestId":"req-005"}'
```

`404`:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found"
  }
}
```

Invalid input:

```sh
curl -s -X POST http://localhost:3000/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":0,"requestId":"req-006"}'
```

`400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "units: Too small: expected number to be >=1"
  }
}
```

### GET /usage

`?month=YYYY-MM`, default the current UTC month. Reading never creates usage rows: a month with no usage reads as 0 consumed.

```sh
curl -s http://localhost:3000/usage -H "X-API-Key: $KEY"
```

`200`:

```json
{
  "month": "2026-10",
  "consumed": 35,
  "remaining": 565
}
```

A past month. `remaining` is against the current plan (see [Usage and history](#usage-and-history)):

```sh
curl -s "http://localhost:3000/usage?month=2026-09" -H "X-API-Key: $KEY"
```

`200`:

```json
{
  "month": "2026-09",
  "consumed": 0,
  "remaining": 600
}
```

A malformed month:

```sh
curl -s "http://localhost:3000/usage?month=2026-9" -H "X-API-Key: $KEY"
```

`400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "month: expected YYYY-MM"
  }
}
```

### GET /users/:externalUserId/usage

`?month=YYYY-MM`, default the current UTC month. `remaining` is against the user's plan.

```sh
curl -s http://localhost:3000/users/alice/usage -H "X-API-Key: $KEY"
```

`200`:

```json
{
  "externalUserId": "alice",
  "month": "2026-10",
  "consumed": 10,
  "remaining": 990
}
```

### GET /requests

Decision history, newest first. Query: `externalUserId` (optional; unknown → 404), `month` (optional; default all months), `limit`, `cursor`. Each entry is the snapshot stored with the decision, including the plan IDs it was decided against. Replays add no entry.

```sh
curl -s "http://localhost:3000/requests?limit=2" -H "X-API-Key: $KEY"
```

`200`:

```json
{
  "data": [
    {
      "requestId": "req-004",
      "externalUserId": "bob",
      "units": 60,
      "month": "2026-10",
      "status": "REJECTED",
      "reasonCode": "PER_REQUEST_LIMIT_EXCEEDED",
      "rejectedBy": "ACCOUNT",
      "limit": 50,
      "remaining": {
        "account": 565,
        "user": 4975
      },
      "accountPlanId": "e6ae3635-82e3-4cf1-811d-8c633daadaf4",
      "userPlanId": "00000000-0000-4000-8000-000000000004",
      "createdAt": "2026-10-18T17:59:43.155Z"
    },
    {
      "requestId": "req-003",
      "externalUserId": "bob",
      "units": 25,
      "month": "2026-10",
      "status": "ACCEPTED",
      "reasonCode": null,
      "rejectedBy": null,
      "limit": null,
      "remaining": {
        "account": 565,
        "user": 4975
      },
      "accountPlanId": "e6ae3635-82e3-4cf1-811d-8c633daadaf4",
      "userPlanId": "00000000-0000-4000-8000-000000000004",
      "createdAt": "2026-10-18T17:59:43.106Z"
    }
  ],
  "nextCursor": "WyIyMDI2LTEwLTE4VDE3OjU5OjQzLjEwNloiLCI1YmE1MTM5ZS1iYzlmLTQzNWItOWQwZi0wOGI2YTI0ZmFiZTMiXQ"
}
```

Filtered by user and month:

```sh
curl -s "http://localhost:3000/requests?externalUserId=alice&month=2026-10&limit=1" -H "X-API-Key: $KEY"
```

`200`:

```json
{
  "data": [
    {
      "requestId": "req-002",
      "externalUserId": "alice",
      "units": 25,
      "month": "2026-10",
      "status": "REJECTED",
      "reasonCode": "PER_REQUEST_LIMIT_EXCEEDED",
      "rejectedBy": "USER",
      "limit": 20,
      ...
      "userPlanId": "00000000-0000-4000-8000-000000000003",
      "createdAt": "2026-10-18T17:59:43.058Z"
    }
  ],
  "nextCursor": "WyIyMDI2LTEwLTE4VDE3OjU5OjQzLjA1OFoiLCI5MzQ5N2M0My02YWIxLTQ2NDItOTZlYS1lZDAwMjEzYTk2MDUiXQ"
}
```

An invalid `cursor` is `400` with `"message": "cursor: invalid cursor"`, as on `GET /users`.

### Errors

Every error has one shape:

```json
{
  "error": {
    "code": "...",
    "message": "..."
  }
}
```

The codes are defined in `src/errors/codes.ts`. There is no quota error code: a rejection is a `200` decision.

| Code | HTTP | When |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | Invalid body or query: a missing or out-of-range field, a name or ID over its length limit, an unknown body field, an invalid `cursor`, `month` or `type`, malformed or oversized JSON, or a plan of the wrong type for the target |
| `UNAUTHORIZED` | 401 | Missing or invalid `X-API-Key` |
| `FORBIDDEN` | 403 | Modifying a predefined plan |
| `NOT_FOUND` | 404 | Unknown route; a user or plan that doesn't exist or belongs to another account; a malformed plan ID or `externalUserId` in the URL |
| `IDEMPOTENCY_CONFLICT` | 409 | Same `requestId` with a different `externalUserId` or `units` |
| `ALREADY_EXISTS` | 409 | Duplicate `externalUserId`, or a plan name this account already uses (on create or rename) |
| `INTERNAL_ERROR` | 500 | Unexpected failure. Details are logged, never returned. |

No key:

```sh
curl -s http://localhost:3000/account
```

`401`:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing X-API-Key header"
  }
}
```

A wrong key returns `401` with `"message": "Invalid API key"`. An unknown route:

```sh
curl -s http://localhost:3000/nope -H "X-API-Key: $KEY"
```

`404`:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /nope not found"
  }
}
```

## Rules

### Supported rules

Each plan sets two limits, and both apply at account level (shared by all the account's users) and at user level:

- **Monthly allowance** (`monthlyLimit`): units that can be consumed per UTC calendar month.
- **Maximum units per request** (`perRequestLimit`): the largest `units` a single consume may ask for.

No additional rule types are implemented.

An additional rule would fit into the plans the same way. Take a daily cap as the example:

- **It is defined on both plan types.** Plans get a `dailyLimit` column, so `ACCOUNT` and `USER` plans each set their own cap, custom plans can change it, and switching or editing a plan takes effect on the next consume like the other limits.
- **It takes a place in the check order, and the first failure still wins.** For example: user per-request → account per-request → user daily → account daily → user monthly → account monthly. Where it goes decides which `reasonCode` a caller sees when several limits would fail.
- **It has an owner and a reason.** A failure reports `rejectedBy: USER` or `ACCOUNT`, depending on which plan's cap blocked it, and a new `reasonCode` such as `DAILY_LIMIT_EXCEEDED`, with that cap as `limit`.
- **It is all or nothing.** If the request would take today's usage over the cap, the whole request is rejected and nothing is consumed, as with the existing rules.
- **It goes in `evaluate()`, without changing the transaction.** The rule is one more entry in the rule list in `src/services/rules.ts`, and `evaluate()` stays pure. The consume transaction keeps its steps and its lock order: it passes today's account and user usage to `evaluate()` alongside the monthly totals, read under the same usage row locks.

### Predefined plans

Seeded on every start with fixed IDs. They are read-only.

| Plan | Type | ID | Monthly limit | Per-request limit |
|---|---|---|---:|---:|
| Starter (default for accounts) | `ACCOUNT` | `00000000-0000-4000-8000-000000000001` | 10,000 | 100 |
| Pro | `ACCOUNT` | `00000000-0000-4000-8000-000000000002` | 100,000 | 1,000 |
| Basic (default for users) | `USER` | `00000000-0000-4000-8000-000000000003` | 1,000 | 20 |
| Premium | `USER` | `00000000-0000-4000-8000-000000000004` | 5,000 | 100 |

### Check order

A consume is evaluated by `evaluate()` in `src/services/rules.ts`, a pure function with no database access. The rules run in this order, and the first one that fails decides the rejection:

1. User per-request: `units <= userPlan.perRequestLimit`
2. Account per-request: `units <= accountPlan.perRequestLimit`
3. User monthly: `userUsed + units <= userPlan.monthlyLimit`
4. Account monthly: `accountUsed + units <= accountPlan.monthlyLimit`

- A request that reaches a limit exactly is accepted.
- The full amount is accepted or none of it. A rejection consumes nothing, but it is recorded in the history.
- `remaining = max(0, monthlyLimit - used)`, after the decision. If a plan's allowance is lowered below what was already used, `remaining` is 0 and the next request is rejected.
- Months are UTC calendar months. A new month starts at 0, and earlier months stay queryable.

### Plan changes

- Switching a plan (`PUT /account/plan`, `PUT /users/:externalUserId/plan`) and editing a custom plan (`PATCH /plans/:id`) take effect on the next consume. No restart is needed.
- Usage is kept across a plan switch. Only the limits change.
- Every assignment goes through one guard (`src/services/plan-guard.ts`), checked in this order: the plan exists and is predefined or owned by this account, else 404; then its type matches the target, else 400. No foreign key can express the ownership rule, so the guard is its only enforcement.
- Custom plans can't be deleted, and a plan's `type` can't be changed. Either would invalidate existing assignments.

### Retries and replays

- `requestId` is scoped per account. The first decision for a `requestId` is final.
- **Same input, same answer.** Sending the same `requestId` with the same `externalUserId` and `units` returns the stored decision with `replayed: true`. The replay is the **original snapshot**: `status`, `reasonCode`, `rejectedBy`, `limit` and `remaining` are what they were at decision time, not current balances.
- **Replays are 200**, like the original, whether it was accepted or rejected.
- **Different input is a conflict.** The same `requestId` with a different `externalUserId` or `units` returns `409 IDEMPOTENCY_CONFLICT`.
- **A rejected `requestId` is spent.** Rejections are recorded like acceptances, so retrying the same `requestId` after an upgrade replays the original rejection. A retry means "the same request again", and the replay must not depend on current balances. To try again under the new plan, the caller sends a new `requestId`.
- **Unknown user beats idempotency conflict.** The user is resolved before the `requestId` is looked up (consume step 1), so a reused `requestId` with an unknown `externalUserId` returns 404, not 409. Users are never deleted, so a valid replay always resolves its user.
- **Retrying after an error is always safe.** A 4xx (validation, unknown user, conflict) writes nothing, and so does almost every 500, because the transaction rolls back. The exception is a `COMMIT` that times out on the client: Postgres may still have committed the decision, so the caller gets a 500 for a request that was in fact decided. Either way, a retry with the same `requestId` is correct: it returns the stored decision if one was committed, and decides the request fresh if not. Callers should retry 500s with the same `requestId`, never a new one.
- **Concurrent copies are decided once.** The others replay the result (see [the consume transaction](#the-consume-transaction), step 6).

### Plan changes under concurrency

Consume reads both plans after taking the usage row locks, in one statement, at `READ COMMITTED`.

- A consume that starts after a plan change has committed uses the new plan.
- A consume that read the old plan and commits after the change is ordered before the change. That is a valid serial order, because plan updates never read usage, so no extra locking on plan rows is needed.
- Each request row stores the plan IDs it was decided against (`accountPlanId`, `userPlanId` in the history), so the history shows which plan applied.

## Design decisions

### The consume transaction

`src/services/consume.service.ts` runs these steps in this order. The code comments use the same numbers.

1. Validate the input. Resolve the user by `(account_id, external_user_id)`, else 404.
2. Fast path, outside any transaction: look up the `requestId`. A match replays (or returns 409).
3. `BEGIN`.
4. Upsert this month's usage rows with `INSERT ... ON CONFLICT DO NOTHING`, account then user.
5. `SELECT ... FOR UPDATE` the account usage row, then the user usage row.
6. Recheck the `requestId` now that the lock is held.
7. Load the account plan and the user plan in one join query.
8. `evaluate()`.
9. If accepted, increment both usage rows.
10. Insert the request row with its snapshot: plan IDs, limit, remaining.
11. `COMMIT`.
12. On a unique violation (`23505`) of `(account_id, request_id)`, roll back, re-read the stored decision and return it.

Why it is built this way:

- **Row locks instead of check-then-update.** Reading usage, deciding and then writing lets two concurrent requests both see the same remaining allowance and both be accepted. `FOR UPDATE` on the account's usage row for the month makes every consume of one account wait its turn, so each one decides against the total the previous one committed. A conditional `UPDATE ... WHERE used + n <= limit` per row would also enforce the limits under the same row lock. But a rejection would still need a locked read to report which rule failed in check order and to snapshot `remaining`, and the rules would move from `evaluate()` into SQL.
- **Upsert before locking (step 4).** `FOR UPDATE` can only lock a row that exists. Creating the month's rows first means every consume locks the same two rows, including the first one of a month.
- **Fixed lock order (step 5).** Every consume locks the account row first, then the user row. If one transaction took user then account while another took account then user, each could hold the lock the other needs, and Postgres would abort one as a deadlock. With one order, no cycle can form.
- **Recheck after the lock (step 6).** The fast path (step 2) runs without a lock, so two copies of the same request can both miss it. The copy that gets the lock second waits until the first commits, then sees its request row and replays it. The recheck is the real idempotency guarantee. The fast path only keeps plain retries off the account lock. Step 12 covers the remaining case, where two copies hold different locks (for example on two sides of a month boundary) and the unique constraint stops the second insert.
- **Plans read after the lock (step 7).** Reading plans before locking could decide against a plan that changed while the request waited. One join gives both plans from one snapshot, without locking plan rows. See [Plan changes under concurrency](#plan-changes-under-concurrency) for the guarantee.
- **Rules outside the transaction code.** `evaluate()` is pure, so its rules are unit-tested without a database, and a new rule (for example a daily cap) goes there without touching the locking.
- **Snapshots on the request row (step 10).** A replay is built from that row alone, which is what makes it identical to the original response.
- **One clock read per request** picks the usage month and every timestamp the request writes (see [Consume and retries](#consume-and-retries)).

Invariant: for every account and month, account usage equals the sum of its users' usage. Steps 9 and 10 commit together, so the invariant holds after every commit. The tests assert it, and `load/check-invariants.sql` checks it after every load run.

The cost of this design is that one account's consumes are serialized on its usage row. The [load test](#bottlenecks) measures that.

### Other decisions

- **SHA-256 for API keys, not bcrypt.** A key has 256 bits of entropy, so there is nothing to brute-force, and bcrypt on every request would dominate the request cost.
- **404, not 403, for another account's resources.** A 403 would confirm that the resource exists.
- **Fixed UUIDs for predefined plans, seeded with `ON CONFLICT (id) DO NOTHING`.** Every environment agrees on their IDs, and seeding on every start is idempotent.
- **Cursor pagination on `(created_at, id)`, not offset.** Requests are inserted while a caller pages through history. With an offset, a new row shifts every later page and causes duplicates. A cursor keeps its position.
- **A database CHECK ties `status` to `reason_code`, `rejected_by` and `limit_value`.** An accepted row has all three null, a rejected row has all three set.
- **Composite foreign keys `(account_id, user_id)`** on `user_usage` and `requests`, so a usage or request row can't point at another account's user.

### WORKERS

`WORKERS` sets how many API processes run, 1 to 8, default 1.

- **`WORKERS=1`** skips the cluster and runs the server in one process.
- **`WORKERS` > 1** makes the process a `node:cluster` primary that only manages workers. It forks that many, each running the same server with its own pool of 10 connections, so at 8 the API holds at most 80 of Postgres's default `max_connections` of 100 and leaves room for migrations, psql and the load-test samplers.
- The primary replaces a worker that dies. If the worker died before listening or within 1s of it, the restart waits 1s, and after 5 such early deaths in a row the primary logs it and exits 1, so a server that can't start fails visibly instead of restarting forever. Uptime counts from listening, not from the fork, because loading the code alone can take over a second.
- The primary forwards SIGTERM/SIGINT to every worker for the usual graceful shutdown.

**Why the default is 1.** The decision rests on the 50-VU results, replicated in two sessions ([measurements](#improvement-several-api-processes)). With 4 workers, a single busy account got 9.0% and 10.2% slower, with p95 66.4% and 70.9% longer, while many accounts gained 31.3% and 35.5% throughput. Pool timeouts at 200 VUs are not part of the reason: both settings have them, and the probes don't show which has fewer ([pool timeouts](#pool-timeouts-at-200-vus)). More processes can't help a single account, because its limit is the usage row lock: extra connections only add waiters on that row. The default follows a **product assumption, not backed by traffic data:** the common case is one company with many users, which is the single-account case.

Raise `WORKERS` only when traffic is spread over many accounts and the single API process is the limit: API CPU near one full core and DB connections mostly idle in transaction.

```sh
WORKERS=4 docker compose up --build
```

## Assumptions

Behavior the brief leaves unspecified, with the reason for each choice.

### API shape

- **List response shape:** lists return `{ data: [...] }`, and paginated lists add `nextCursor` (`null` on the last page). One envelope everywhere leaves room to add fields without breaking clients.
- **Page size:** `GET /users` and `GET /requests` return 20 per page by default and allow `limit` from 1 to 100, with the same `{ data, nextCursor }` envelope and cursor format. The cap bounds each query's cost, and 20 is a common default.
- **Plan ordering:** `GET /plans` lists predefined plans first in seed order (Starter, Pro, Basic, Premium), then the account's custom plans oldest first. The ordering is stable and puts the well-known plans on top.
- **`predefined` flag:** every plan includes `predefined: boolean`, derived from `account_id IS NULL`. Callers need to know which plans are read-only, and deriving the flag means it can't drift from the column.
- **Usage shape:** usage is always `{ month: "YYYY-MM", consumed, remaining }`. `GET /account` and `GET /users/:externalUserId` embed it as `usage` for the current UTC month; `GET /usage` returns it on its own, and `GET /users/:externalUserId/usage` returns it plus `externalUserId`. A missing usage row reads as 0 and `remaining = max(0, monthlyLimit - consumed)`, which matches the "reads never create rows" rule. One shape everywhere means a client parses it once.
- **Malformed IDs in the URL → 404:** a non-UUID plan ID or an `externalUserId` longer than 128 characters can't name an existing resource, so it returns 404 like any other unknown resource (a malformed `planId` in a body is still 400).
- **Unknown body fields → 400:** bodies are strict, so typos and read-only fields (such as `type` on PATCH) fail loudly instead of being silently ignored.
- **Unknown query params are ignored:** clients and proxies often add extra params (such as cache-busters), and ignoring them is harmless for reads.
- **Body-parser errors → 400:** malformed JSON, an oversized body, or a bad charset returns 400 `VALIDATION_ERROR`, because the error table maps invalid bodies to that one code (an oversized body would otherwise be a 413).
- **Cursors are opaque but not secret:** a pagination cursor is base64url of `[createdAt, id]`, so anyone can decode it and see an internal row ID. That grants nothing: every query is scoped by the caller's `account_id`, so a cursor naming another account's row only sets a position and returns the caller's own rows. Clients should still treat cursors as opaque. An HMAC-signed or encrypted cursor would hide the IDs if that ever matters.

### Plans

- **User `remaining` uses the user's plan only:** the user view reports the user's own allowance, while the account view reports the shared allowance. Mixing the two would hide which limit applies.
- **Custom plans may reuse predefined names:** uniqueness is per owner (`UNIQUE NULLS NOT DISTINCT (account_id, name)`), so an account may create its own "Starter". Plans are always referenced by ID, so a name collision is never ambiguous.
- **A monthly limit of 0 blocks all requests (it does not mean unlimited):** the schema allows `monthly_limit >= 0`, and the monthly rule accepts only when `used + units <= monthlyLimit`, so a limit of 0 rejects every request (units are always at least 1). Reading 0 as "unlimited" would need a special case in every rule and in every `remaining` calculation, and it would turn a typo or an unset value into unlimited usage. A 0 limit is also useful on purpose, for example to suspend a user or account without deleting anything.
- **Plan changes during an in-flight consume** are ordered as described in [Plan changes under concurrency](#plan-changes-under-concurrency).

### Consume and retries

- **Retry behavior:** a rejected `requestId` is spent, retrying after an error is always safe, replays are 200, and an unknown user beats an idempotency conflict. Each is described with its reasoning in [Retries and replays](#retries-and-replays).
- **The month is read once per request:** consume reads the clock once, before its transaction. That instant picks the usage month and is written as the request's `created_at`, so a request that waits on the lock across midnight UTC of the 1st still counts against the month it arrived in, and its history row agrees with its usage row.
- **A rejected consume may create zero usage rows:** the month's usage rows are upserted before the lock (consume step 4), so the first request of a month creates them with `units_used = 0` even if it is rejected. They read the same as a missing row, and creating them is what lets every consume lock the same rows in the same order.

### Usage and history

- **`month` is strict `YYYY-MM`:** the usage endpoints and `GET /requests` accept exactly four digits, a dash and `01`-`12`, so years run 0001-9999: four digits can't express more, and 0000 is rejected because `toUtcMonth()` only accepts years from 1. Anything else, including `2026-1`, a full date, an empty value or a repeated param, is 400. A loose parser would turn typos into a silently different month.
- **Any month can be queried, past or future:** a month with no usage row (before the account existed, or not reached yet) reads as `consumed: 0`, and reading creates nothing. Rejecting such months would need a rule for "too early" or "too late" with no benefit to the caller.
- **`remaining` for any month uses the current plan:** only the current plan assignment is stored, so `remaining` for a past month is `max(0, current monthlyLimit - consumed)`. The plan that actually applied to each decision is in that request's history entry (`accountPlanId`, `userPlanId`).
- **History without `month` covers all months:** `GET /requests` defaults to every month, unlike the usage endpoints, which default to the current one. A usage total only makes sense for one month, but a history list is already bounded by its page size, and "everything, newest first" is what a caller browsing history expects.
- **History entries are the stored snapshot:** each entry returns the decision as it was made (`status`, `reasonCode`, `rejectedBy`, `limit`, `remaining` after the decision, the two plan IDs, `units`, `month`, `createdAt`), plus the user's `externalUserId`. No request or response field carries an internal UUID (the row ID, the user ID). Replays add no entry, since they decide nothing new.
- **A malformed `externalUserId` query param is 400, not 404:** on `GET /requests` it is query input, and the error table maps invalid query input to 400 (as in the `/consume` body). Only in a URL path does a malformed ID mean "no such resource" and return 404. A well-formed but unknown `externalUserId` is 404 in both places.

### Example client

- **The demo creates a new account on every run:** the example client never reuses or cleans up an earlier run's account, so each run starts from zero usage and gives the same results, and nothing is ever deleted (the service has no delete). Old demo accounts stay in the database as ordinary accounts.
- **The demo's API key never reaches the browser:** the client's own server creates the account, keeps the plaintext key only for the length of that run, and makes every API call itself. The page receives only decisions. This is also why the service needs no CORS.
- **The demo finds Basic and Premium by name:** it reads `GET /plans?type=USER` and picks the predefined plans named Basic and Premium, instead of hardcoding the seed UUIDs. A client should only depend on the public API.
- **Bob fills the account exactly, then goes over:** in demo step 5, Bob sends a fixed sequence of 50, 50, 50, 15, 50 units. After Alice's 35, the first four are accepted and bring the account to exactly 0 remaining, and the last 50 is rejected by `ACCOUNT` / `MONTHLY_LIMIT_EXCEEDED` with limit 200. This shows the cap reached exactly, not just a request that would cross it. The sizes are fixed, not computed from the API's `remaining`, so the demo checks the service instead of following it.
- **The demo checks fixed expected values:** every consume step has a fixed expected `status`, `reasonCode`, `rejectedBy`, `limit`, and account and user `remaining`, written in the client code. A step passes only if all six match. None are derived from the API's answers, so a wrong `remaining` fails the demo instead of shifting the next step's expectation. The setup steps check that the account starts on Starter and that the custom plan comes back with 200/month and 50/request.

### Operation

- **`WORKERS` defaults to 1** because of a product assumption, not traffic data: the common case is one company with many users. The full reasoning and the limits on the setting are in [WORKERS](#workers).

### Known limitations

- **History filtered by both `externalUserId` and `month` has no exact index:** that query uses `(account_id, user_id, created_at DESC, id DESC)` and checks `month` row by row, so an old month of a busy user scans that user's newer rows first. It's still in index order, with no Sort. An index on `(account_id, user_id, month, created_at DESC, id DESC)` would fix it at scale.
- **Only the current plan assignment is stored.** There is no plan history, so a past month's `remaining` is computed against the current plan. Each request row keeps the plan IDs it was decided against, but not the limits those plans had at the time: a later `PATCH` of a custom plan changes what that ID means.
- **`GET /users` doesn't include usage.** List entries have no `usage`, so a caller that wants per-user usage needs one request per user (`GET /users/:externalUserId` or `GET /users/:externalUserId/usage`).
- **One account's consumes are serialized** on its usage row lock, so a single account's throughput is bounded by the interval between decisions on that row ([bottlenecks](#bottlenecks)).
- **Under overload, requests fail on the pool wait.** A request that waits more than 2s for a free connection gets a 500 ([pool timeouts](#pool-timeouts-at-200-vus)).

## Load test summary

Full method, raw evidence and analysis: [docs/LOAD_TEST.md](docs/LOAD_TEST.md). Every run's files are in `load/results/`.

Setup: k6 (`grafana/k6:1.3.0`) under the Compose profile `load`, on one Linux machine (`host_cpus 12`) shared by k6, the API and PostgreSQL 16 with image defaults. Each run is 50 VUs for 30s, no think time, and only `POST /consume` is measured. The custom plans allow 2,000,000,000 units/month and 1,000/request, so every request is accepted and takes the full write path.

| Scenario | Shape |
|---|---|
| hot account | 1 account, 200 users, a new `requestId` per request. Every consume locks the same account usage row. |
| many accounts | 100 accounts × 5 users, same request mix |
| retry storm | 1 account, 50 users, 5,000 `requestId`s; each iteration sends the same request 3 times at once |

### Baseline (one API process)

| Scenario | Consumes | RPS | p50 | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|---:|
| hot account | 2,556 | 85.2 | 593.2 ms | 686.8 ms | 731.4 ms | 0 |
| many accounts | 5,032 | 167.7 | 284.8 ms | 417.0 ms | 485.7 ms | 0 |
| retry storm | 4,647 | 154.9 | 1,023.1 ms | 1,170.3 ms | 1,221.9 ms | 0 |

In the retry storm, 1,339 of the 4,647 responses were fresh decisions and 3,308 were replays, with zero 409s. All invariants held after every run: account usage = sum of user usage, no usage over a monthly limit, account usage = sum of accepted request units, and fresh responses = request rows.

### Bottlenecks

- **Hot account: the account usage row lock.** On average 8.25 of the 10 connections wait on the `SELECT ... FOR UPDATE` of consume step 5, so one consume per account runs at a time. Decisions on the account are 1 / 85.2 = 11.7 ms apart. That interval includes the holder's statements, the lock hand-off and event-loop delay in the API. An estimated 2.8 ms of it is database work.
- **Many accounts: the single Node process.** Lock waits almost disappear (0.16 connections on average). Connections are mostly idle in transaction (6.05 of 9.83), waiting for the API to send the next statement, and API CPU averages 107% of one core.
- **Retry storm: duplicates queue on the hot row.** 2,677 of the 4,016 consume transactions were copies that replayed at the step 6 recheck after waiting for the account lock. 631 replays took the fast path and skipped the lock.

### Improvement: several API processes

`load/compare.sh` runs `WORKERS=1` and `WORKERS=4` alternately in one session, 3 rounds, and restores `WORKERS=1` when it exits. It ran in two sessions on the same host (`compare-b94e9fcc.txt` and `compare-66ef619b.txt`). Medians of 3 runs, 50 VUs, 30s:

| Scenario | WORKERS | Session 1 RPS | p50 | p95 | p99 | Session 2 RPS | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| many accounts | 1 | 201.1 | 241.6 ms | 324.8 ms | 380.5 ms | 197.5 | 242.4 ms | 335.0 ms | 396.6 ms |
| many accounts | 4 | 264.1 (+31.3%) | 180.5 ms | 292.3 ms | 381.3 ms | 267.6 (+35.5%) | 177.7 ms | 285.2 ms | 374.7 ms |
| hot account | 1 | 88.7 | 543.0 ms | 788.7 ms | 1,033.5 ms | 95.9 | 520.8 ms | 601.9 ms | 685.0 ms |
| hot account | 4 | 80.7 (−9.0%) | 737.6 ms | 1,312.2 ms | 1,661.8 ms | 86.1 (−10.2%) | 684.6 ms | 1,028.5 ms | 1,223.1 ms |

In both sessions the W1 and W4 ranges don't overlap, and correctness held in all 28 runs. This is why the default stays `WORKERS=1` ([WORKERS](#workers)).

A single account needs a shorter lock hold, not more processes. Proposed, not implemented: fewer round trips while the row is locked (7 down to 4, estimated ~85 → ~150 decisions/s), and taking concurrent duplicates off the account row with a per-`requestId` advisory lock. See docs/LOAD_TEST.md §6.

### Pool timeouts at 200 VUs

Hot account at 200 VUs for 20s, every probe run so far:

| Run | WORKERS | Consumes | RPS | p50 | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline session (`c2df73fc`) | 1 | 1,902 | 95.1 | 2,305.5 ms | 2,507.5 ms | 2,546.2 ms | 8 (0.42%) |
| comparison session 1 (`76c60ef4`) | 1 | 2,066 | 103.3 | 2,044.7 ms | 2,267.8 ms | 2,530.5 ms | 0 |
| comparison session 1 (`f5e0610e`) | 4 | 1,914 | 95.7 | 2,280.3 ms | 2,819.9 ms | 3,365.7 ms | 206 (10.76%) |
| standalone (`fc0db82b`) | 1 | 1,799 | 90.0 | 2,335.2 ms | 2,923.2 ms | 3,242.5 ms | 225 (12.51%) |
| comparison session 2 (`a20894b9`) | 1 | 2,052 | 102.6 | 2,080.3 ms | 2,310.6 ms | 2,618.7 ms | 0 |
| comparison session 2 (`a7959b5d`) | 4 | 1,921 | 96.1 | 2,191.8 ms | 3,005.9 ms | 3,462.9 ms | 171 (8.90%) |

At 200 VUs both configurations fail on the pool wait. Every error is pg-pool's `timeout exceeded when trying to connect`: the request waited more than `connectionTimeoutMillis` (2s) for a free connection and got a 500. `WORKERS=1` had 8, 0, 225 and 0 errors with the same settings, and `WORKERS=4` had 206 and 171, so the comparison is inconclusive. Throughput stays at 90.0–103.3 req/s, because the row lock is still the limit. Nothing was decided twice or lost: fresh responses equal request rows in every run.

### Reproduce

From the repo root. `load/run.sh` needs bash, Docker with Compose v2, `jq` and `od`.

```sh
docker compose up -d --build --wait db api       # build and start the API + DB
load/run.sh hot-account
load/run.sh many-accounts
load/run.sh retry-storm
VUS=200 DURATION=20s load/run.sh hot-account     # the stress probe
load/uncontended.sh                              # single-request timings
load/compare.sh                                  # WORKERS=1 vs WORKERS=4, alternating
```

Each `run.sh` run samples `pg_stat_activity` and container CPU during the k6 run, runs `load/check-invariants.sql` afterwards, and saves everything to `load/results/<scenario>-<run_id>-*`. `WORKERS=n load/run.sh <scenario>` runs it against n API processes. Load runs leave their accounts in the database; `docker compose down -v` removes them. The absolute numbers are specific to the test host.
