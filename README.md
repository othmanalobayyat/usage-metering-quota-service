# Usage Metering and Quota Service

## Overview

Applications call this service before they perform a metered action. The calling application (an **account**) identifies itself with an API key and asks the service to consume a number of units for one of its **users**. The service checks the account's plan and the user's plan, accepts the full amount only if every rule allows it, records the decision, and counts the units if it accepted them.

- Accounts can use predefined plans or create their own. Plan changes apply to the next request, with no redeploy.
- Usage is tracked per UTC calendar month. Every decision is stored with the inputs it was made from.
- Retries are safe: a repeated `requestId` returns the original decision and never charges twice.
- Consumes for one account are serialized on a database row lock, so limits hold under any concurrency.

Stack: TypeScript, Express 5, Drizzle ORM, PostgreSQL 16, Zod, Vitest + Supertest, Docker Compose, k6.

More detail: [docs/PLAN.md](docs/PLAN.md) (data model and design), [docs/LOAD_TEST.md](docs/LOAD_TEST.md) (performance), [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) (the brief).

## Quick start

Requires Docker Engine 25.0+ with Compose 2.20.2+ (the API healthcheck uses `start_interval`). I've run it on Docker 29.9.0 with Compose 5.6.0.

```sh
docker compose up --build
```

| Service | URL | Notes |
|---|---|---|
| `api` | `http://localhost:3000` | Runs migrations, seeds the predefined plans, then starts. Healthy once `GET /healthz` returns 200. |
| `client` | `http://localhost:8081` | Example client. Starts after the API is healthy. |
| `db` | `localhost:5433` | PostgreSQL 16, user/password/database `quota` |

No manual steps are needed on a fresh clone. Data lives on the named volume `db-data`, so it survives `docker compose restart` and `docker compose down`. `docker compose down -v` drops it.

`WORKERS` (1–8, default 1) sets the number of API processes, e.g. `WORKERS=4 docker compose up --build`. See [Performance](#performance-summary) for when that helps.

### Demo

Open `http://localhost:8081` and press **Run demo**, or run it without a browser:

```sh
curl -s -X POST http://localhost:8081/demo/run
```

The client's server creates a fresh account with a custom account plan (200/month, 50/request), registers Alice on Basic and Bob on Premium, and then:

1. Alice consumes 10: accepted.
2. Alice consumes 25: rejected, `USER` / `PER_REQUEST_LIMIT_EXCEEDED` (Basic allows 20 per request).
3. Alice is switched to Premium.
4. Alice consumes 25 again with a new `requestId`: accepted. Only her plan changed.
5. Bob consumes 50, 50, 50, 15 (the account reaches exactly 0 remaining), then 50: rejected, `ACCOUNT` / `MONTHLY_LIMIT_EXCEEDED`, limit 200.

Every step is checked against fixed expected values in `client/src/demo.ts`, and the run reports `"ok": true` only if all of them match. The API key stays on the client's server and never reaches the browser.

## Accounts, users and plans

- An **account** is an application calling the service. It has one API key and one `ACCOUNT` plan, whose limits are shared by all its users. New accounts start on Starter.
- A **user** belongs to one account and has one `USER` plan with its individual limits. New users start on Basic. The caller chooses the user's ID (`externalUserId`, 1–128 characters), and the API addresses users only by it. The same ID can exist under different accounts.
- A **plan** sets a monthly allowance and a per-request maximum. Predefined plans are shared and read-only. An account can create, view and edit its own custom plans and assign them to itself or its users. Plans can't be deleted, and a plan's type can't change.

Both plans apply to every consume. A larger user plan doesn't increase the account's shared allowance.

| Predefined plan | Type | ID | Monthly | Per request |
|---|---|---|---:|---:|
| Starter (account default) | `ACCOUNT` | `00000000-0000-4000-8000-000000000001` | 10,000 | 100 |
| Pro | `ACCOUNT` | `00000000-0000-4000-8000-000000000002` | 100,000 | 1,000 |
| Basic (user default) | `USER` | `00000000-0000-4000-8000-000000000003` | 1,000 | 20 |
| Premium | `USER` | `00000000-0000-4000-8000-000000000004` | 5,000 | 100 |

## API keys

- `POST /accounts` creates an account and returns its key **once**. It and `GET /healthz` are the only endpoints that need no key.
- The key is `mk_` followed by 32 random bytes in base64url (43 characters). I store only its SHA-256 hash, so a lost key can't be recovered. The response is sent with `Cache-Control: no-store`.
- Send it as `X-API-Key` on every other request. A missing key, a value without the key format, and an unknown key all get `401`.
- Every query is scoped to the key's account. Another account's user or plan returns `404`, the same as one that doesn't exist.

I use SHA-256 rather than bcrypt because the key has 256 bits of entropy, so there's nothing to brute-force, and a slow hash on every request would dominate its cost.

## API reference

All bodies are JSON. Request bodies are strict (an unknown field is a 400). Lists return `{ "data": [...] }`, and paginated lists add `nextCursor` (`null` on the last page; pass it back as `cursor`; `limit` 1–100, default 20).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | no | Process and database check (`503` if the database is down) |
| POST | `/accounts` | no | Create an account (`name`); returns the API key once |
| GET | `/account` | yes | The account, its plan and its current-month usage |
| GET | `/plans` | yes | Predefined plans and this account's custom plans (`?type=ACCOUNT\|USER`) |
| POST | `/plans` | yes | Create a custom plan (`name`, `type`, `monthlyLimit`, `perRequestLimit`) |
| GET | `/plans/:id` | yes | One plan |
| PATCH | `/plans/:id` | yes | Edit a custom plan's `name` or limits (predefined → `403`) |
| PUT | `/account/plan` | yes | Switch the account plan (`planId`) |
| POST | `/users` | yes | Register a user (`externalUserId`, optional `name`, optional `planId`) |
| GET | `/users` | yes | List users, cursor-paginated |
| GET | `/users/:externalUserId` | yes | One user, its plan and its current-month usage |
| PUT | `/users/:externalUserId/plan` | yes | Switch a user's plan (`planId`) |
| POST | `/consume` | yes | Consume units for a user (`externalUserId`, `units`, `requestId`); returns the decision |
| GET | `/usage` | yes | Account usage for a month (`?month=YYYY-MM`, default current UTC month) |
| GET | `/users/:externalUserId/usage` | yes | User usage for a month |
| GET | `/requests` | yes | Decision history, newest first (`?externalUserId=`, `?month=`, cursor-paginated) |

Usage has the shape `{ "month": "YYYY-MM", "consumed", "remaining" }`. Each history entry includes the decision, the plan IDs it was decided against, and a `snapshot` of both plans' limits and usage at that moment.

### Examples

Set up an account with a custom account plan (600/month, 50/request), and two users: Alice on Basic (20/request) and Bob on Premium (100/request).

```sh
API=http://localhost:3000
KEY=$(curl -s -X POST $API/accounts -H 'Content-Type: application/json' \
  -d '{"name":"Acme Docs"}' | jq -r .apiKey)
TEAM=$(curl -s -X POST $API/plans -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Team","type":"ACCOUNT","monthlyLimit":600,"perRequestLimit":50}' | jq -r .id)
curl -s -X PUT $API/account/plan -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"planId\":\"$TEAM\"}" > /dev/null
curl -s -X POST $API/users -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice"}' > /dev/null
curl -s -X POST $API/users -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"externalUserId":"bob","planId":"00000000-0000-4000-8000-000000000004"}' > /dev/null
```

**Accepted.** `remaining` is what's left after the decision:

```sh
curl -s -X POST $API/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":10,"requestId":"req-001"}'
```

```json
{"requestId":"req-001","status":"ACCEPTED","reasonCode":null,"rejectedBy":null,"limit":null,"remaining":{"account":590,"user":990},"replayed":false}
```

**Rejected by the user's plan.** 25 units is over Basic's 20 per request:

```sh
curl -s -X POST $API/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":25,"requestId":"req-002"}'
```

```json
{"requestId":"req-002","status":"REJECTED","reasonCode":"PER_REQUEST_LIMIT_EXCEEDED","rejectedBy":"USER","limit":20,"remaining":{"account":590,"user":990},"replayed":false}
```

**Rejected by the account's plan.** Premium allows 100 per request, but the account plan allows 50:

```sh
curl -s -X POST $API/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"externalUserId":"bob","units":60,"requestId":"req-003"}'
```

```json
{"requestId":"req-003","status":"REJECTED","reasonCode":"PER_REQUEST_LIMIT_EXCEEDED","rejectedBy":"ACCOUNT","limit":50,"remaining":{"account":590,"user":5000},"replayed":false}
```

A rejection is a business decision, not an error: HTTP 200 with `status: "REJECTED"`, `reasonCode` (`PER_REQUEST_LIMIT_EXCEEDED` or `MONTHLY_LIMIT_EXCEEDED`), `rejectedBy` (`USER` or `ACCOUNT`) and the `limit` that blocked it. Retry examples are under [Retries and idempotency](#retries-and-idempotency).

### Errors

Every error has the shape `{ "error": { "code", "message" } }`. The codes are in `src/errors/codes.ts`.

| Code | HTTP | When |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | Invalid body or query, malformed JSON, a body that isn't UTF-8, an invalid cursor or month, a plan of the wrong type for the target |
| `UNAUTHORIZED` | 401 | Missing or invalid `X-API-Key` |
| `FORBIDDEN` | 403 | Editing a predefined plan |
| `NOT_FOUND` | 404 | Unknown route, or a user or plan that doesn't exist or belongs to another account |
| `IDEMPOTENCY_CONFLICT` | 409 | Same `requestId` with a different `externalUserId` or `units` |
| `ALREADY_EXISTS` | 409 | Duplicate `externalUserId`, or a plan name this account already uses |
| `INTERNAL_ERROR` | 500 | Unexpected failure. Details are logged, never returned. |
| `SERVICE_UNAVAILABLE` | 503 | Overload: no free database connection within 2s, a row lock not granted within 3s, or a statement cancelled. Sent with `Retry-After: 1`. Nothing was written. |

## Rules and plan changes

`evaluate()` in `src/services/rules.ts` is a pure function with no database access. It runs the rules in this order, and the first one that fails decides the rejection:

1. User per-request: `units <= userPlan.perRequestLimit`
2. Account per-request: `units <= accountPlan.perRequestLimit`
3. User monthly: `userUsed + units <= userPlan.monthlyLimit`
4. Account monthly: `accountUsed + units <= accountPlan.monthlyLimit`

- The full amount is accepted or none of it. A request that reaches a limit exactly is accepted.
- A rejection consumes nothing but is recorded in the history.
- `remaining = max(0, monthlyLimit - used)`, after the decision. If an allowance is lowered below what was already used, `remaining` is 0 and the next request is rejected.
- Months are UTC calendar months. A new month starts at 0, and unused allowance doesn't roll over.

**Plan changes.** Switching a plan (`PUT /account/plan`, `PUT /users/:externalUserId/plan`) or editing a custom plan (`PATCH /plans/:id`) applies to the next consume. Usage is kept across a switch. Every assignment goes through one guard (`src/services/plan-guard.ts`): the plan must exist and be predefined or owned by this account (else 404), then match the target's type (else 400).

**Adding a rule.** A new rule, such as a daily cap, would be a new plan column and one more entry in `evaluate()`'s ordered list, with its own `reasonCode`. The transaction would pass it today's usage, read under the same locks, and its steps and lock order wouldn't change.

## Retries and idempotency

`requestId` is chosen by the caller and scoped per account. The first decision for a `requestId` is final.

- **Same input, same answer.** The same `requestId` with the same `externalUserId` and `units` returns the stored decision with `replayed: true` and HTTP 200. Nothing is consumed again, and `remaining` is the value from the original decision, not the current balance.
- **Different input is a conflict:** `409 IDEMPOTENCY_CONFLICT`.
- **A rejected `requestId` is spent.** Retrying it after an upgrade replays the rejection. To try again under the new plan, send a new `requestId`.
- **Retrying after an error is safe.** 4xx and 503 responses write nothing. A 500 almost always means the transaction rolled back, but a `COMMIT` that times out on the client may have committed. Either way, a retry with the same `requestId` returns the stored decision if there is one and decides the request if not. Callers should retry 503s and 500s with the **same** `requestId`.
- **Concurrent copies are decided once.** The others wait on the lock and replay the result (see below).

```sh
curl -s -X POST $API/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":10,"requestId":"req-001"}'
# {"requestId":"req-001","status":"ACCEPTED",...,"remaining":{"account":590,"user":990},"replayed":true}

curl -s -X POST $API/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"externalUserId":"alice","units":11,"requestId":"req-001"}'
# 409 {"error":{"code":"IDEMPOTENCY_CONFLICT","message":"requestId \"req-001\" was already used with a different externalUserId or units"}}
```

## Concurrency design

`src/services/consume.service.ts` runs these steps, numbered the same in the code:

1. Resolve the user by `(account_id, external_user_id)`, else 404.
2. Fast path, outside any transaction: look up the `requestId`. A match replays (or returns 409).
3. `BEGIN`.
4. Insert this month's usage rows if they're missing (`ON CONFLICT DO NOTHING`), account then user, so there's a row to lock.
5. `SELECT … FOR UPDATE` the account usage row, **then** the user usage row.
6. Recheck the `requestId` now that the lock is held.
7. Read both plans in one join query.
8. `evaluate()`.
9. If accepted, increment both usage rows.
10. Insert the request row: the decision, plan IDs, `remaining`, and the snapshot of both plans' limits and usage before the request.
11. `COMMIT`.
12. On a unique violation of `(account_id, request_id)`, the transaction has rolled back: re-read the stored row and replay it.

Why it's built this way:

- **Row lock, not check-then-update.** Reading usage, deciding and then writing would let two concurrent requests see the same remaining allowance and both be accepted. The lock on the account's usage row makes every consume of one account wait its turn, so each one decides against the total the previous one committed. The user row is only changed under its account's lock, so user totals are serialized too.
- **Lock order account → user.** Every path takes the same order, so no two transactions can each hold a lock the other needs. No deadlock can form.
- **Idempotency rechecked after the lock (step 6).** The fast path has no lock, so two copies of a request can both miss it. The second copy waits for the lock, then sees the first one's committed row and replays it. The fast path only keeps plain retries off the lock. The unique constraint `requests_account_id_request_id_unique` is the final backstop (step 12).
- **Plans read after the lock (step 7).** At READ COMMITTED each statement gets a fresh snapshot, so a plan change committed before the lock was granted applies to the decision. A consume that read the old plan and commits after the change is ordered before it, which is a valid serial order because plan updates never read usage.
- **One transaction.** The usage read, both increments and the request row commit or roll back together. So for every account and month: account usage = sum of its users' usage = sum of its accepted request units. The tests assert this, and `load/check-invariants.sql` checks it after every load run.

The cost is that one account's consumes are serialized on its usage row. [Performance](#performance-summary) measures that.

## Product assumptions

The brief leaves these unspecified. Each choice comes with its reason.

- **A quota rejection is HTTP 200** with `status: "REJECTED"`. It's a valid answer, not a failure.
- **Rejected `requestId`s are spent**, and replays return the original snapshot. A retry means "the same request again" and shouldn't depend on current balances.
- **An unknown user beats an idempotency conflict:** the user is resolved first, so a reused `requestId` with an unknown user is 404.
- **A monthly limit of 0 blocks everything.** It doesn't mean unlimited, which would make a typo dangerous. It's useful to suspend an account or user.
- **`perRequestLimit` may exceed `monthlyLimit`.** Each limit is checked on its own, so lowering an allowance doesn't require changing both fields at once.
- **User `remaining` uses the user's plan only;** account `remaining` uses the account plan. Mixing them would hide which limit applies.
- **Usage for any month can be read,** past or future. Reads never create rows; a missing row means 0 consumed. Past months' `remaining` uses the current plan, because only the current assignment is stored. The plan that applied to each decision is in its history entry.
- **History without `month` covers all months,** newest first. Usage endpoints default to the current month.
- **IDs are compared exactly.** `externalUserId` and `requestId` with leading or trailing whitespace are rejected rather than trimmed, and `.`/`..` are rejected as user IDs because HTTP clients rewrite them in URLs. NUL characters and unpaired UTF-16 surrogates are rejected in every string, because PostgreSQL or the driver would otherwise store them in a way that makes different IDs collide. Request bodies must be UTF-8.
- **Malformed IDs in a URL are 404**, since they can't name a resource. The same value in a body or query is 400.
- **Overload is 503, not 500,** with `Retry-After: 1`, because nothing was written and the caller should retry.
- **Custom plans may reuse predefined names.** Plans are always referenced by ID.
- **`WORKERS` defaults to 1** because I assume the common case is one company with many users, which is the single-account case that more processes make slower. I have no traffic data for this.
- **The demo creates a new account on every run** and never deletes anything (the service has no delete).

## Performance summary

k6 on one Linux laptop shared by k6, the API and PostgreSQL 16 with image defaults. 50 VUs for 30s, no think time, only `POST /consume` measured, one API process with a pool of 10.

| Scenario | Shape | RPS | p50 | p95 | Errors |
|---|---|---:|---:|---:|---:|
| hot account | 1 account, 200 users | 85.2 | 593.2 ms | 686.8 ms | 0 |
| many accounts | 100 accounts × 5 users | 167.7 | 284.8 ms | 417.0 ms | 0 |
| retry storm | 1 account; every request sent 3× at once | 154.9 | 1,023.1 ms | 1,170.3 ms | 0 |

All invariants held after every run, and the retry storm got zero 409s.

Bottlenecks:
- **One account: the account usage row lock.** On average 8.25 of the 10 connections wait on the step 5 `FOR UPDATE`. Decisions on one account are 11.7 ms apart (1 / 85.2). Cutting the statements under the lock from 8 to 4 made a prototype 42% faster on this scenario, so the per-statement round trips are a large part of that interval.
- **Many accounts: the single Node process.** Lock waits almost disappear. Connections sit idle in transaction waiting for the API, and API CPU averages 107% of one core.
- **Retry storm: duplicates queue on the hot row.** Two thirds of the transactions on the account row were copies that waited for the lock only to replay at the recheck.

`WORKERS=4` made many accounts 31–35% faster but a hot account 9–10% slower, with much longer tails, in two comparisons of 3 runs each. That's why the default is 1. Full method, raw files and analysis are in [docs/LOAD_TEST.md](docs/LOAD_TEST.md).

## Running tests

Requires Node 22+. The integration tests use a separate `quota_test` database on the Compose PostgreSQL, so only `db` needs to run:

```sh
npm install
docker compose up -d db
npm test
```

- The test setup creates, migrates and seeds `quota_test`, and refuses any database whose name doesn't end in `_test`. Override it with `TEST_DATABASE_URL`.
- If the database is unreachable, the integration suites (`*.db.test.ts`) skip. Set `REQUIRE_DB=1` to make that a failure.
- One file: `npx vitest run tests/consume.db.test.ts`. By name: `npx vitest run -t "returns 503"`.
- `npm run typecheck` and `npm run lint`.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, build and `npm test` with `REQUIRE_DB=1` on every push and pull request, plus a `docker compose up --build` job that runs the demo.

To run the API without Docker, export the variables from `.env.example` (`set -a; . ./.env.example; set +a`), then `npm run db:migrate && npm run db:seed && npm run dev`. Load tests: `load/run.sh hot-account|many-accounts|retry-storm|mixed` (see [docs/LOAD_TEST.md](docs/LOAD_TEST.md) §2).

## Known limitations

- **Single-account throughput is bounded by the statements run under the account row lock.** Every consume of one account waits for the previous one to finish 8 statements, from the `FOR UPDATE` to `COMMIT`. More API processes don't help, because they only add waiters. I prototyped a version that runs 4 statements under the lock with the same order and guarantees, and measured it at +42% on a hot account, but I haven't integrated it ([docs/CONSUME_ROUND_TRIPS.md](docs/CONSUME_ROUND_TRIPS.md)).
- **Concurrent duplicates also queue on the account row.** In a retry storm, most transactions on the hot row are copies that only replay. A per-`requestId` advisory lock taken before the account lock would take them off it. Not implemented.
- **Under overload, requests fail on the pool wait.** A request that waits more than 2s for a free connection gets a 503. The service sheds load instead of queueing it indefinitely.
- **No API key rotation or revocation.** A leaked key can't be replaced, and a lost key can't be recovered.
- **Account creation is public and not rate-limited.** A real deployment would put `POST /accounts` behind an admin credential or a rate limit.
- **Only the current plan assignment is stored.** There's no plan history, so a past month's `remaining` uses the current plan. Each decision's own limits are on its request row, except for decisions recorded before migration `0001`, whose `snapshot` is `null`.
- **History isn't a change feed.** An entry's `createdAt` is read before the transaction, and the request can then wait on the pool and on row locks before it commits. So a decision can appear behind newer entries a reader has already seen. A reader that needs every entry should re-read a short window (for example 15s) behind the newest entry it has seen.
- **History filtered by both user and month has no exact index.** An old month of a busy user scans that user's newer rows first.
- **`GET /users` doesn't include usage,** so per-user usage needs one request per user.
