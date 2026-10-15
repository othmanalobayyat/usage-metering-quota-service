# Usage Metering and Quota Service — Project Plan

**Estimated Time:** 42 hours  
**Timeline:** October 12, 2026 – October 20, 2026  
**Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, Vitest, Docker Compose

---

## 3. Data Model

Six tables in PostgreSQL. All IDs are `uuid` (`gen_random_uuid()` default). All timestamps are `timestamptz`, written from the injected clock (`now()`). Unit counts are `integer`: the per-month totals can't grow past a plan's monthly limit, so `bigint` isn't needed. Using `integer` also avoids Drizzle returning `bigint` as a string.

Nothing is ever deleted, so every foreign key uses the default `NO ACTION`.

### Enums

| Enum | Values |
|---|---|
| `plan_type` | `ACCOUNT`, `USER` |
| `request_status` | `ACCEPTED`, `REJECTED` |
| `reason_code` | `PER_REQUEST_LIMIT_EXCEEDED`, `MONTHLY_LIMIT_EXCEEDED` |
| `rule_owner` | `ACCOUNT`, `USER` (used for `rejected_by`) |

### `plans`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | **PK**. Predefined plans use fixed UUIDs. |
| `account_id` | `uuid NULL` | **FK → `accounts.id`**. `NULL` = predefined; otherwise the owning account. |
| `name` | `text NOT NULL` | |
| `type` | `plan_type NOT NULL` | Whether the plan applies to accounts or to users. |
| `monthly_limit` | `integer NOT NULL` | `CHECK (monthly_limit >= 0)` |
| `per_request_limit` | `integer NOT NULL` | `CHECK (per_request_limit > 0)` |
| `created_at`, `updated_at` | `timestamptz NOT NULL` | `updated_at` changes on PATCH. |

- `UNIQUE NULLS NOT DISTINCT (account_id, name)`: plan names are unique per owner, and predefined names are unique among themselves. A violation returns `ALREADY_EXISTS`.
- Predefined = `account_id IS NULL`. No separate flag can drift out of sync with it.
- `type` cannot be changed by PATCH, because that would invalidate existing assignments.

### `accounts`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | **PK** |
| `name` | `text NOT NULL` | |
| `api_key_hash` | `char(64) NOT NULL` | **UNIQUE**. Hex SHA-256 of the `mk_…` key. The auth lookup uses this index. |
| `plan_id` | `uuid NOT NULL` | **FK → `plans.id`**. Defaults to Starter. |
| `created_at` | `timestamptz NOT NULL` | |

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | **PK** |
| `account_id` | `uuid NOT NULL` | **FK → `accounts.id`** |
| `external_user_id` | `text NOT NULL` | The caller's own ID for the user; used in URLs and `/consume`. |
| `name` | `text NULL` | |
| `plan_id` | `uuid NOT NULL` | **FK → `plans.id`**. Defaults to Basic. |
| `created_at` | `timestamptz NOT NULL` | |

- `UNIQUE (account_id, external_user_id)`: the lookup key for every user route. A violation returns `ALREADY_EXISTS`. The same external ID can exist under different accounts.
- `UNIQUE (account_id, id)`: lets `user_usage` and `requests` use composite FKs, so a usage or request row can never point at another account's user.
- Index `(account_id, created_at, id)`: supports `GET /users` cursor pagination.

### `account_usage`

| Column | Type | Notes |
|---|---|---|
| `account_id` | `uuid NOT NULL` | **FK → `accounts.id`** |
| `month` | `date NOT NULL` | First day of the UTC month, from `toUtcMonth()`. `CHECK (EXTRACT(DAY FROM month) = 1)` |
| `units_used` | `integer NOT NULL DEFAULT 0` | `CHECK (units_used >= 0)` |
| `updated_at` | `timestamptz NOT NULL` | |

- **PK `(account_id, month)`**: the conflict target for the consume upsert and the row locked `FOR UPDATE`.

### `user_usage`

| Column | Type | Notes |
|---|---|---|
| `user_id` | `uuid NOT NULL` | |
| `account_id` | `uuid NOT NULL` | Stored on the row so per-account queries and the invariant check don't need a join. |
| `month` | `date NOT NULL` | Same CHECK as `account_usage.month`. |
| `units_used` | `integer NOT NULL DEFAULT 0` | `CHECK (units_used >= 0)` |
| `updated_at` | `timestamptz NOT NULL` | |

- **PK `(user_id, month)`**: one row per user per month, even when users share a plan.
- **FK `(account_id, user_id)` → `users(account_id, id)`**

### `requests`

One row per decision, accepted or rejected. A replay is answered entirely from this row.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | **PK**. Tie-breaker for the history cursor. |
| `account_id` | `uuid NOT NULL` | **FK → `accounts.id`** |
| `user_id` | `uuid NOT NULL` | |
| `request_id` | `text NOT NULL` | Supplied by the caller. |
| `units` | `integer NOT NULL` | `CHECK (units > 0)` |
| `month` | `date NOT NULL` | The usage month the decision counted against. `CHECK (EXTRACT(DAY FROM month) = 1)`, the same CHECK as the usage tables. Deliberate addition: the history month filter matches this column against `toUtcMonth()` values, so a mid-month date would silently drop out of results. |
| `status` | `request_status NOT NULL` | |
| `reason_code` | `reason_code NULL` | |
| `rejected_by` | `rule_owner NULL` | |
| `limit_value` | `integer NULL` | The limit of the rule that blocked the request. |
| `account_plan_id` | `uuid NOT NULL` | **FK → `plans.id`**. Snapshot of the plan used for the decision. |
| `user_plan_id` | `uuid NOT NULL` | **FK → `plans.id`**. Snapshot. |
| `remaining_account` | `integer NOT NULL` | Remaining **after** the decision. `CHECK (>= 0)` |
| `remaining_user` | `integer NOT NULL` | Remaining **after** the decision. `CHECK (>= 0)` |
| `created_at` | `timestamptz NOT NULL` | |

- `UNIQUE (account_id, request_id)`: `requestId` is scoped per account. This is the constraint that raises `23505` in consume step 12.
- **FK `(account_id, user_id)` → `users(account_id, id)`**
- "Same input" for idempotency means the same `user_id` and the same `units`. Anything else returns `IDEMPOTENCY_CONFLICT`.
- The status/decision CHECK from Phase 1 ties `status` to `reason_code`, `rejected_by`, and `limit_value`.
- Indexes for history: `(account_id, created_at DESC, id DESC)`, `(account_id, month, created_at DESC, id DESC)`, `(account_id, user_id, created_at DESC, id DESC)`.

### Rules No Foreign Key Can Enforce

These are enforced by the shared plan-assignment guard (Phase 2) on user registration and both plan switches:

1. An account's `plan_id` must reference a plan with `type = 'ACCOUNT'`.
2. A user's `plan_id` must reference a plan with `type = 'USER'`.
3. The assigned plan must be predefined (`account_id IS NULL`) or owned by the same account.

The risk: any code path that writes `plan_id` without going through the guard can break these rules silently.

### Circular Reference

`accounts.plan_id → plans` and `plans.account_id → accounts` point at each other, but inserts never deadlock on the cycle:

- Predefined plans have `account_id = NULL` and are seeded before any account exists.
- An account is always created on a plan that already exists (Starter by default).
- A custom plan is only created by an account that already exists.

The migration creates both tables first and adds the FKs afterwards. In the Drizzle schema, `plans.account_id` references `accounts` lazily (`(): AnyPgColumn => accounts.id`).

### Invariant

For every `(account_id, month)`: `account_usage.units_used = SUM(user_usage.units_used)`. Consume increments both rows in the same transaction. The load tests check this invariant after every run.

---

## 4. API Endpoints

### Authentication

The `X-API-Key` header is required on every endpoint except account creation and health checks.

Users are addressed by `externalUserId` everywhere in the API: URLs, the `/consume` body, and the `/requests` query. Internal user UUIDs never appear in the API.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness + DB check |
| POST | `/accounts` | Create account, returns plaintext API key **once** (defaults to Starter) |
| GET | `/account` | Account info, current plan (incl. `monthlyLimit`, `perRequestLimit`), current month usage |
| PUT | `/account/plan` | Switch account plan `{ planId }` |
| GET | `/plans` | Predefined + this account's custom plans (`?type=ACCOUNT\|USER`) |
| GET | `/plans/:id` | One plan (404 if another account's custom plan) |
| POST | `/plans` | Create custom plan |
| PATCH | `/plans/:id` | Update own custom plan (403 for predefined) |
| POST | `/users` | Register user `{ externalUserId, name?, planId? }` (defaults to Basic) |
| GET | `/users?limit=&cursor=` | List users, cursor pagination on `(created_at, id)` like history |
| GET | `/users/:externalUserId` | User + plan (incl. `monthlyLimit`, `perRequestLimit`) + current usage |
| PUT | `/users/:externalUserId/plan` | Switch user plan |
| POST | `/consume` | `{ externalUserId, units, requestId }` → decision |
| GET | `/usage?month=YYYY-MM` | Account consumed/remaining for a month |
| GET | `/users/:externalUserId/usage?month=YYYY-MM` | User consumed/remaining |
| GET | `/requests?externalUserId=&month=&limit=&cursor=` | Request history, newest first (unknown `externalUserId` → 404) |

### Consume Response

A rejection is a successful business decision, so it returns **200 OK**, not an HTTP error.

Example response:

```json
{
  "requestId": "req-123",
  "status": "REJECTED",
  "reasonCode": "MONTHLY_LIMIT_EXCEEDED",
  "rejectedBy": "ACCOUNT",
  "limit": 10000,
  "remaining": {
    "account": 5,
    "user": 980
  },
  "replayed": false
}
```

Rules:

- Accepted responses always include `reasonCode`, `rejectedBy`, and `limit`, set to `null`.
- `remaining` represents allowances **after the original decision**.
- A retried `requestId` returns the stored response with `replayed: true`.
- Replayed values represent the original snapshot, not current balances.

### Error Codes

Use one response shape everywhere:

```json
{
  "error": {
    "code": "...",
    "message": "..."
  }
}
```

| Code | HTTP Status | When |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | Invalid body/query, wrong plan type for target |
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Modifying a predefined plan |
| `NOT_FOUND` | 404 | Not found **or belongs to another account** (don't leak existence) |
| `IDEMPOTENCY_CONFLICT` | 409 | Same `requestId` with different input |
| `ALREADY_EXISTS` | 409 | Duplicate `externalUserId` or plan name |
| `INTERNAL_ERROR` | 500 | Unexpected failure (details logged, never returned) |

---

## 6. Implementation Tasks

### Decisions (Locked Before Phase 3)

- Rule check order: user per-request → account per-request → user monthly → account monthly. First failure wins.
- Rejections return 200 with `status: "REJECTED"`.
- `requestId` is scoped per account.
- Custom plans cannot be deleted (avoids orphaned assignments).
- Account creation is unauthenticated.
- New accounts default to Starter, new users to Basic.
- Cross-account access returns 404.

### Phase 0 — Scaffold (October 15)

- [x] `config.ts` validates environment variables with Zod and fails fast if `DATABASE_URL` is missing.
- [x] `app.ts` exports an app factory; `server.ts` calls `listen` (Supertest needs the factory).
- [x] `GET /healthz` checks the DB connection, not just the process.
- [x] Dockerfile + Compose with PostgreSQL (`postgres:16`) health check; service uses `depends_on: condition: service_healthy`.

**Defend it:** Why split `app.ts` from `server.ts`?

### Phase 1 — Data Layer + Seed (October 15)

- [x] Drizzle schema matching Section 3; generate migrations.
- [x] Container entrypoint runs migrate → seed → start.
- [x] Seed predefined plans with **fixed UUIDs** and `ON CONFLICT (id) DO NOTHING`.
- [x] Predefined limits:
  - Starter: 10,000/month · 100/request.
  - Pro: 100,000/month · 1,000/request.
  - Basic: 1,000/month · 20/request.
  - Premium: 5,000/month · 100/request.
- [x] `lib/month.ts`: implement `toUtcMonth(date)`. Every month calculation goes through it.
- [x] Injectable clock (`now()` passed into services) so tests can cross a month boundary.
- [x] Add a real CHECK constraint on Requests tying `status` to `reason_code`, `rejected_by`, and `limit_value`:

```sql
CHECK (
  (
    status = 'ACCEPTED'
    AND reason_code IS NULL
    AND rejected_by IS NULL
    AND limit_value IS NULL
  )
  OR
  (
    status = 'REJECTED'
    AND reason_code IS NOT NULL
    AND rejected_by IS NOT NULL
    AND limit_value IS NOT NULL
  )
)
```

- Note: no extra UNIQUE constraints on usage tables. The PRIMARY KEYs already guarantee uniqueness.

**Defend it:**
- Why fixed UUIDs for seeds?
- What happens if the seed runs twice?
- `Accounts.plan_id` and `Plans.account_id` point at each other. Why doesn't that break inserts?

### Phase 2 — Auth, Accounts, Plans, Users (October 16)

- [ ] API keys: 32 random bytes, `mk_` prefix, store **SHA-256** hash (not bcrypt: keys are high-entropy, and bcrypt per request would wreck the load test).
- [ ] Auth middleware: hash header → look up → attach `req.account`, else 401.
- [ ] Zod validation on every body and query.
  - `units`, `monthlyLimit`, `perRequestLimit`: max `2147483647`.
  - `requestId`: 1–128 characters.
- [ ] Central error middleware with one error shape.
- [ ] Error codes in one const file (table in Section 4). No quota code: a rejection is a decision, not an error.
- [ ] Endpoints: accounts, account plan, plans: create, list, get, update (no delete), users: `POST /users`, `GET /users`, `GET /users/:externalUserId`, `PUT /users/:externalUserId/plan`.
- [ ] `GET /users`: cursor pagination on `(created_at, id)`, same as history.
- [ ] `POST /users`: missing `planId` means use the default plan (Basic). `PUT /account/plan` and `PUT /users/:externalUserId/plan` require `planId` (missing → 400).
- [ ] One shared plan-assignment guard for accounts and users, checked in this order:
  1. Plan exists and is predefined OR owned by this account (rule 3), else 404.
  2. Plan type matches target (rules 1, 2), else 400.
  - Add a comment above it: rule 3 is enforced here, not by a foreign key.
- [ ] Every query filters by `account_id`. Nothing is fetched by ID alone.
- [ ] Tests: missing key → 401; invalid key → 401.
- [ ] Tests: account B gets 404 on account A's users and plans.
- [ ] Tests: PATCH predefined plan → 403; wrong plan type → 400.
- [ ] Tests: `PUT /users/:externalUserId/plan` and `PUT /account/plan` with another account's custom plan → 404.
- [ ] Tests: `GET /users` cursor pagination returns pages in order with no duplicates or gaps.

**Defend it:**
- Rule 3 can't be enforced with an FK. Where is it enforced, and what's the risk?
- Why 404 instead of 403 for another account's resources?

### Phase 3 — Consume (October 17)

The core. Write its tests the same day.

#### `rules.ts` — Pure Function, No Database

Implement:

```ts
evaluate({
  accountPlan,
  userPlan,
  accountUsed,
  userUsed,
  units
}) -> Decision
```

- `remaining = max(0, allowance - used)`, which covers "allowance reduced below usage" automatically.

#### `consume.service.ts`

1. Validate input; resolve user by `(account_id, external_user_id)` → 404.
2. **Fast path (outside transaction):** look up `requestId`.
   - Same input → return stored decision.
   - Different input → 409.
   - This is an optimization only: it keeps retries off the account row lock.
3. `BEGIN`.
4. Upsert this month's usage rows: `INSERT ... ON CONFLICT DO NOTHING` (account, then user).
5. `SELECT ... FOR UPDATE` on account usage row, **then** user usage row. Always this order to avoid deadlocks.
6. **Recheck** `requests` after locking.
   - Same input → return stored.
   - Different input → 409.
   - This is the real guarantee.
7. Load account plan and user plan in **one join query** after the lock. One statement gives one snapshot, with no extra locking on plan rows.
8. `evaluate(...)`.
9. If accepted: increment both usage rows.
10. Insert request row with snapshots (plan IDs, limit, remaining).
11. `COMMIT`.
12. Safety net: on `23505`, roll back, re-read, return stored decision.

#### Plan Changes Under Concurrency

A request that starts after a plan update commits reads the new plan (`READ COMMITTED` + reading after the lock).

A consume that read the old plan and commits after the update is logically ordered before it. That is a valid serial order because plan updates don't read usage. No extra locking is needed. Document this behavior.

#### Phase 3 Checklist

- [ ] `rules.ts` + unit tests for `evaluate()` alone.
- [ ] Implement the transaction steps above.
- [ ] Response: remaining after decision, `replayed: true` on stored replies.
- [ ] Test: accepted request adds N to both totals.
- [ ] Test: 25 units on Basic → `REJECTED`, `USER`, `PER_REQUEST_LIMIT_EXCEEDED`.
- [ ] Test: 10 units with 5 left on the account → `REJECTED`, `ACCOUNT`, `MONTHLY_LIMIT_EXCEEDED`.
- [ ] Test: a rejection changes no usage.
- [ ] Test: retry returns identical response; same `requestId` with different units → 409.
- [ ] Test: plan switch keeps usage; allowance lowered below usage → remaining 0 and rejected.
- [ ] Test: new month starts at zero; old month still queryable.
- [ ] Test: 50 parallel consumes never exceed the allowance; account usage = sum of user usage.

**Defend it:**
- Why `FOR UPDATE` instead of check-then-update?
- What deadlock appears with inconsistent lock order?
- Why read plans after the lock?
- Why isn't the pre-check enough on its own?
- A plan update commits while a consume is in flight. Which plan does the consume use, and why is that still correct?

### Phase 4 — Usage + History (October 18)

- [ ] Usage endpoints: missing month row = 0 consumed; never create rows on read.
- [ ] History: cursor pagination on `(created_at, id)`.
- [ ] Month filter uses the Section 3 index `(account_id, month, created_at DESC, id DESC)`.
- [ ] Tests: page order, month filter, account isolation.

**Defend it:** Why a cursor instead of offset when rows are inserted concurrently?

### Phase 5 — Example Client (October 18)

- [ ] Simple web page served by its own small Express container.
- [ ] Demo: create account, then a custom account plan with 200 units/month · 50/request assigned to it.
- [ ] Demo: register Alice (Basic) and Bob (Premium).
- [ ] Demo, in this order:
  1. Alice 10 → accepted.
  2. Alice 25 → rejected by user per-request.
  3. Switch Alice to Premium.
  4. Alice 25 → accepted, client code unchanged.
  5. Bob consumes in chunks of 50 or fewer until the account cap → rejected by account monthly.
- [ ] Display decision, reason, `rejectedBy`, both remaining values.
- [ ] Client in Compose, waits for service healthy.

**Defend it:** What exactly changed between Alice's rejected and accepted 25-unit requests?

### Phase 6 — Load Testing (October 19)

Start only after correctness tests pass. If time is short, the minimum is: hot-account scenario, invariant check, one before/after number.

- [ ] k6 via its Docker image under Compose profile `load`.
- [ ] Scenario: many users, one account (hot row).
- [ ] Scenario: many accounts.
- [ ] Scenario: retry storm with repeated `requestId`s.
- [ ] SQL invariant check after each run: account usage = sum of user usage.
- [ ] Record RPS, p50/p95/p99, error rate.
- [ ] One improvement, re-run, compare (pool size, fewer round trips).
- [ ] Write up the bottleneck: the account usage row lock serializes one account's users.

**Defend it:**
- Why does one account behave differently from many accounts?
- What would you change at 10× the load?

### Phase 7 — README (October 19)

- [ ] API reference with curl examples and error code table.
- [ ] Account/user model, getting and using API keys.
- [ ] Rules, check order, plan changes, retry behavior, predefined limits.
- [ ] Replay returns the original snapshot; plan-change guarantee under concurrency.
- [ ] Assumptions with reasoning, design decisions, known limitations. Assumptions include:
  - Only the current plan assignment is stored.
  - Past months: remaining is calculated against the current plan.
- [ ] Load test results and exact reproduction commands.

### Phase 8 — Buffer (October 20)

- [ ] Fresh clone → `docker compose up --build` works with no manual steps.
- [ ] Run demo, tests, and load test from README instructions.
- [ ] Practice tracing one consume request through the code out loud.

---

## Scope

Skip optional rules, Redis, distributed infrastructure, and frontend complexity.

If there's time left, a simple extra rule (e.g. daily cap) fits into `evaluate()` without touching the transaction. Worth mentioning in the discussion even if not built.