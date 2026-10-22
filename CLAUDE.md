# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Usage Metering and Quota Service: a backend that other applications call to check and consume units against account-level and user-level plan limits. It includes an example client (`client/`) and k6 load tests (`load/`). Where to look:

- `README.md`: setup, API reference, rules, assumptions and known limitations.
- `docs/REQUIREMENTS.md`: the project requirements (the brief).
- `docs/PLAN.md`: data model, API design and design decisions.
- `docs/LOAD_TEST.md`: performance methodology, results and bottlenecks.

## Technology stack

TypeScript, Express 5, Drizzle ORM, PostgreSQL 16, Zod, Vitest + Supertest, Docker Compose, k6 (Compose profile `load`). Node 22+.

## Commands

- `npm install`: install dependencies. The example client has its own `client/package.json` (`npm ci --prefix client`).
- `npm run build`: compile `src/` to `dist/` (`tsconfig.build.json`). `npm start` runs `dist/server.js`.
- `npm run dev`: `src/server.ts` under tsx in watch mode. `npm start` and `npm run dev` both need `DATABASE_URL` (see `.env.example`).
- `npm run typecheck`: `tsc --noEmit` over `src/`, `tests/` and `client/src/`. `npm run typecheck --prefix client` checks the client with its own tsconfig, as its image builds it.
- `npm run lint`: ESLint (flat config, typescript-eslint).
- `npm test`: all Vitest tests once (`npm run test:watch` for watch mode). Integration suites (`*.db.test.ts`) use the `quota_test` database on the Compose PostgreSQL (`docker compose up -d db`; override with `TEST_DATABASE_URL`). They skip if it's unreachable unless `REQUIRE_DB=1`.
- One file: `npx vitest run tests/healthz.test.ts`. By name: `npx vitest run -t "returns 503"`.
- `npm run db:migrate` / `npm run db:seed` / `npm run db:generate`: apply migrations, seed predefined plans, generate a migration from `src/db/schema.ts`.
- `docker compose up --build`: PostgreSQL 16 on `localhost:${DB_PORT:-5433}`, the API on `http://localhost:3000`, and the example client on `http://localhost:${CLIENT_PORT:-8081}`. The client waits for the API's `/healthz` healthcheck. `docker compose down -v` also drops the database volume.
- CI (`.github/workflows/ci.yml`, every push and pull request): typecheck, lint, build, client typecheck and `npm test` with `REQUIRE_DB=1`, plus a `docker compose up --build` smoke job that ends with the client's `POST /demo/run`.
- Load tests (output in `load/results/`, cited by `docs/LOAD_TEST.md`):
  - `load/run.sh hot-account|many-accounts|retry-storm|mixed`: one k6 run (default 50 VUs, 30s), with pg_stat_activity samples, CPU, API errors and `load/check-invariants.sql`. `WORKERS=n` runs it against n API processes.
  - `load/compare.sh`: `WORKERS=1` vs `WORKERS=4`, alternating.
  - `A_IMAGE=… B_IMAGE=… load/ab.sh`: two prebuilt API images, ABBA, on one database; `python3 load/ab-paired.py load/results/ab-<session>.txt` for paired ratios.
  - `load/uncontended.sh`: single-request timings, API and DB side.

## Architecture

- `src/config.ts` validates the environment with Zod and exits on startup if it's invalid (e.g. missing `DATABASE_URL`).
- `src/app.ts` is an app factory, so Supertest uses it without a server. `src/server.ts` creates the pool, the app and the listener. `WORKERS` (1–8, default 1) sets the layout:
  - `WORKERS=1`: one process, no cluster.
  - `WORKERS` > 1: a `node:cluster` primary forks that many workers, each with its own pool, and restarts any that die. It exits 1 after 5 early deaths in a row (before listening, or within 1s of it), and forwards SIGTERM/SIGINT for a graceful shutdown.
  - More processes help traffic spread over many accounts but slow a single hot account (`docs/LOAD_TEST.md` §8), so the default stays 1.
- Container entrypoint (`docker-entrypoint.sh`): migrate → seed → start. `docker compose up --build` from a fresh clone must work with no manual steps.
- Predefined plans are seeded with fixed UUIDs (`src/db/seed.ts` `PREDEFINED_PLAN_IDS`) and `ON CONFLICT (id) DO NOTHING`, so seeding is idempotent. Starter 10,000/mo · 100/req and Pro 100,000/mo · 1,000/req (account plans); Basic 1,000/mo · 20/req and Premium 5,000/mo · 100/req (user plans). New accounts start on Starter, new users on Basic.
- Every month calculation goes through `src/lib/month.ts` `toUtcMonth(date)`. Services take an injected clock (`now()`) so tests can cross month boundaries.
- `src/services/rules.ts` `evaluate({accountPlan, userPlan, accountUsed, userUsed, units})` is a pure function with no DB access. Check order: user per-request → account per-request → user monthly → account monthly; the first failure wins. `remaining = max(0, monthlyLimit - used)`, after the decision. New rules (e.g. a daily cap) go here, not in the transaction.

### Consume transaction (`src/services/consume.service.ts`)

These guarantees protect correctness. Any change to the transaction must keep all of them:

- **Atomic decision.** The usage read used for the decision, both usage increments and the stored request row commit or roll back together, in one transaction, while holding the usage row locks.
- **Consistent lock order.** Every path locks the account's usage row before the user's. This prevents deadlocks, and the account lock serializes all consumes of one account in one month.
- **Idempotency rechecked under the lock.** A lookup before the transaction is only an optimization. The `requestId` must be looked up again after the account lock is held. The unique constraint `requests_account_id_request_id_unique` is the final backstop.
- **Plans read before deciding.** Both plans are read inside the transaction, after the locks and before `evaluate()`, so a plan change committed before the lock applies to the decision.
- **No double charge on retry.** A repeated `requestId` is answered from the stored row (`replayed: true`), or rejected with 409 if its input differs. It never increments usage again.

How the code implements them today. The numbers match the code comments and `docs/PLAN.md` §6 Phase 3:

1. Resolve the user by `(account_id, external_user_id)`, else 404. The route has already validated the input.
2. Fast path, outside the transaction: look up the `requestId` (same input → stored decision, different → 409).
3. BEGIN.
4. Insert this month's usage rows if missing (`ON CONFLICT DO NOTHING`, account then user), so there is a row to lock.
5. `SELECT … FOR UPDATE` the account usage row, then the user usage row.
6. Recheck `requests` for the `requestId`.
7. Load both plans in one join query.
8. `evaluate()`.
9. If accepted, increment both usage rows.
10. Insert the request row: the decision, plan IDs, `remaining`, and the snapshot of both plans' limits and usage before the request (migration `0001`).
11. COMMIT.
12. On a unique violation of `requests_account_id_request_id_unique` (not any `23505`), the transaction has rolled back: re-read the stored row and replay it. Any other error propagates.

Steps 2, 4 and 7 are implementation details. The number of statements and round trips may change as long as every guarantee above still holds. `docs/CONSUME_ROUND_TRIPS.md` has a measured prototype; it isn't integrated. Two tests in `tests/consume.db.test.ts` detect lock waits by matching SQL text in `pg_stat_activity`, so rewriting those statements may need them updated. Discuss changes to the transaction before making them.

## Invariants and conventions

- Auth: `X-API-Key` header on everything except `POST /accounts` and `GET /healthz`. Keys are `mk_` + 32 random bytes (base64url, 43 characters), stored only as a SHA-256 hash. SHA-256 rather than bcrypt, because a slow hash on every request would cost throughput. A value without the key format is rejected with the same 401 as an unknown key, without a DB lookup.
- Every query accessing account-owned data must be scoped to the authenticated account. Shared predefined plans and account lookup during authentication are intentional exceptions. Another account's resource returns 404, not 403, so existence isn't leaked.
- Users are addressed by `externalUserId` everywhere in the API (URLs, `/consume` body, `/requests` query). `requestId` is scoped per account.
- A quota rejection is a business decision: HTTP 200 with `status: "REJECTED"`, `reasonCode`, `rejectedBy` (`ACCOUNT`/`USER`), `limit` and `remaining`, not an error.
- Replays return the stored decision with `replayed: true`. The same `requestId` with different `externalUserId` or `units` returns 409 `IDEMPOTENCY_CONFLICT`.
- One error shape, `{ error: { code, message } }`, with codes in `src/errors/codes.ts`. A 500 never exposes details.
- One shared plan-assignment guard (`src/services/plan-guard.ts`) for accounts and users, checked in this order: (1) the plan exists and is predefined or owned by this account, else 404; (2) its type matches the target, else 400. No FK can enforce the ownership rule, so the guard is the only enforcement.
- Predefined plans are read-only (PATCH → 403). Plans can't be deleted.
- DB CHECKs on `requests`: `status` ties to the nullability of `reason_code`/`rejected_by`/`limit_value`, and the six snapshot columns are all set or all NULL. NULL is allowed only on rows written before `0001`.
- Usage reads never create rows; a missing month row means 0 consumed. History uses cursor pagination on `(created_at, id)`, never offset.
- Invariant, asserted in tests and after load runs: account usage = sum of its users' usage = sum of its accepted request units.
- Unspecified product behavior: pick something sensible, apply it consistently, and record the assumption with its reasoning under Assumptions in README.md. Known limitations go under its Known limitations.
- Out of scope: Redis, distributed infrastructure, a complex frontend. The example client is a simple page in its own small Express container.

## Workflow rules

- Precedence: `docs/REQUIREMENTS.md` first. `docs/PLAN.md` documents design choices within those requirements. This file gives development instructions. When documents conflict, the higher one wins; flag the conflict.
- Preserve documented design decisions. Flag conflicts with the project requirements and discuss significant design changes before implementation.
- Only work on the task you're assigned. Don't modify files outside it.
- If you're asked to review, report findings only. Don't fix anything.
- Don't tick checklist items in `docs/PLAN.md`; the developer ticks them after review.
