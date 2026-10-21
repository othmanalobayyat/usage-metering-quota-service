# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Usage Metering and Quota Service: a backend that other applications call to check and consume units against account-level and user-level plan limits. Phases 0–1 are done: config validation, app factory + server, `GET /healthz` with a DB check, Dockerfile and Compose; Drizzle schema + migration (`drizzle/`), idempotent seed of predefined plans, container entrypoint migrate → seed → start, `lib/month.ts`, injectable clock, and a separate `quota_test` database for integration tests. Phase 2 is done: SHA-256 API keys + `X-API-Key` auth middleware, error codes (`src/errors/codes.ts`) with central error/404 middleware, the shared plan-assignment guard (`src/services/plan-guard.ts`), and the accounts, account plan, plans, and users endpoints (`GET /users` cursor-paginated). Phase 3 is done: `rules.ts` `evaluate()`, `consume.service.ts` (the 12 transaction steps) and `POST /consume`. Phase 4 is done: `GET /usage`, `GET /users/:externalUserId/usage` (`?month=YYYY-MM`, default the current UTC month) and `GET /requests` (history, newest first, cursor-paginated, filters `externalUserId` and `month`). Phase 5 is done: the example client in `client/` (its own TypeScript Express server, Dockerfile and `package.json`). `POST /demo/run` runs the Phase 5 demo server-to-server on a fresh account, and the page renders each step. In Compose it's the `client` service on `http://localhost:${CLIENT_PORT:-8081}`, and it waits for the API's `/healthz` healthcheck. The Phase 6 baseline is implemented and awaiting review: k6 scripts in `load/` (Compose service `k6`, profile `load`), and results, bottleneck and proposed improvements in `docs/LOAD_TEST.md`. The improvement measured so far is several API processes (`WORKERS`, `node:cluster` in `src/server.ts`), compared in `docs/LOAD_TEST.md` §8: many accounts +31%, but a hot account regresses, so the default stays `WORKERS=1`. `docs/REQUIREMENTS.md` is the brief and `docs/PLAN.md` is the phased implementation plan, decisions, and API. Read `docs/PLAN.md` before starting any phase. Don't tick checklist items in PLAN.md. The developer ticks them after review and tests pass.

Planned stack: TypeScript, Express, Drizzle ORM, PostgreSQL, Zod, Vitest + Supertest, Docker Compose, k6 (Compose profile `load`).

## Commands

- `npm install`: install dependencies (Node 22+).
- `npm run build`: compile `src/` to `dist/` (`tsconfig.build.json`).
- `npm run dev`: run `src/server.ts` with tsx in watch mode (needs `DATABASE_URL`; see `.env.example`).
- `npm start`: run the compiled server (`node dist/server.js`).
- `npm run typecheck`: `tsc --noEmit` over `src/`, `tests/` and `client/src/`.
- `npm run lint`: ESLint (flat config, typescript-eslint).
- `npm test`: run all Vitest tests once. `npm run test:watch` for watch mode.
- Single test file: `npx vitest run tests/healthz.test.ts`. Single test by name: `npx vitest run -t "returns 503"`.
- `load/run.sh hot-account|many-accounts|retry-storm`: one k6 load run (30s) plus pg_stat_activity samples, CPU, API errors and the SQL invariant check. `WORKERS=n load/run.sh …` runs it against n API processes. `load/compare.sh`: `WORKERS=1` vs `WORKERS=4` back to back, alternating, 3 rounds of many-accounts and hot-account plus one 200-VU hot-account probe each, with medians in `load/results/compare-<session>.txt`. `load/uncontended.sh`: single-request timings (API and DB side). All three save their output to `load/results/`, which docs/LOAD_TEST.md cites.
- `docker compose up --build`: start PostgreSQL 16 + the API on `http://localhost:3000`. `docker compose down -v` also drops the DB volume. The DB is published on host port `${DB_PORT:-5433}`.

## Architecture (as planned)

- `config.ts` validates env with Zod and fails fast (e.g. missing `DATABASE_URL`).
- `app.ts` exports an app factory, so Supertest can use it without a server. `server.ts` creates the pool, the app and the listener, in one of two layouts set by `WORKERS` (1–8, default 1):
  - `WORKERS=1`: one process runs the server, with no cluster.
  - `WORKERS` > 1: the process is a `node:cluster` primary that only manages workers. It forks that many, each running the same server with its own pool of 10, and restarts any that die. After 5 early deaths in a row (before listening, or within 1s of it) it exits 1. It forwards SIGTERM/SIGINT so each worker shuts down gracefully.
  - Raise `WORKERS` only for traffic spread over many accounts (docs/LOAD_TEST.md §8).
- Container entrypoint: migrate → seed → start. `docker compose up --build` from a fresh clone must work with no manual steps.
- Predefined plans are seeded with **fixed UUIDs** and `ON CONFLICT (id) DO NOTHING` so seeding is idempotent. The limits are Starter 10,000/mo · 100/req, Pro 100,000/mo · 1,000/req (account plans), Basic 1,000/mo · 20/req, Premium 5,000/mo · 100/req (user plans). New accounts default to Starter and new users to Basic.
- Every month calculation goes through `lib/month.ts` `toUtcMonth(date)`. Services take an injected clock (`now()`) so tests can cross month boundaries.
- `rules.ts` `evaluate({accountPlan, userPlan, accountUsed, userUsed, units})` is a **pure function with no DB access**. The check order is user per-request → account per-request → user monthly → account monthly, and the first failure wins. `remaining = max(0, allowance - used)`. New rules (e.g. a daily cap) go here, not in the transaction.

### Consume transaction (`consume.service.ts`): keep this exact order

Numbered as in docs/PLAN.md §6 Phase 3 (the code comments use the same numbers).

1. Validate input; resolve the user by `(account_id, external_user_id)`, else 404.
2. Fast-path `requestId` lookup outside the transaction (same input → stored decision, different → 409). An optimization only.
3. BEGIN.
4. Upsert this month's usage rows (`ON CONFLICT DO NOTHING`, account then user).
5. `SELECT ... FOR UPDATE` the **account usage row first, then the user row**. This lock order prevents deadlocks.
6. Recheck `requests` for the `requestId` after locking. This recheck is the real idempotency guarantee.
7. Load account and user plans in **one join query after the lock**.
8. `evaluate()`.
9. If accepted, increment both usage rows.
10. Insert the request row with snapshots (plan IDs, limit, remaining).
11. COMMIT.
12. On a unique violation (`23505`), roll back, re-read, and return the stored decision.

## Invariants and conventions

- Auth: `X-API-Key` header on everything except `POST /accounts` and `/healthz`. Keys are `mk_` + 32 random bytes, stored as a **SHA-256** hash (not bcrypt, because bcrypt on every request would hurt load-test performance).
- Every query filters by `account_id`; never fetch by ID alone. Another account's resource returns **404**, not 403, so existence isn't leaked.
- Users are addressed by `externalUserId` everywhere in the API (URLs, `/consume` body, `/requests` query). `requestId` is scoped per account.
- A quota rejection is a business decision: **HTTP 200** with `status: "REJECTED"`, `reasonCode`, `rejectedBy` (`ACCOUNT`/`USER`), `limit`, and `remaining`. It is not an error code.
- Replays return the stored original snapshot with `replayed: true`. The same `requestId` with different input returns 409 `IDEMPOTENCY_CONFLICT`.
- One error shape, `{ error: { code, message } }`, with codes defined in a single const file (table in PLAN.md §4). A 500 never exposes details.
- One shared plan-assignment guard for accounts and users, checked in this order: (1) the plan exists and is predefined or owned by this account, else 404; (2) the plan type matches the target, else 400. No FK can enforce the ownership rule, so the guard is the only enforcement.
- Predefined plans are read-only (PATCH → 403). Custom plans cannot be deleted.
- A DB CHECK on `requests` ties `status` to the nullability of `reason_code`/`rejected_by`/`limit_value`.
- Usage reads never create rows; a missing month row means 0 consumed. History uses cursor pagination on `(created_at, id)`, never offset.
- Invariant (asserted in tests and after load runs): account usage = sum of its users' usage.
- Unspecified product behavior: pick something sensible, apply it consistently, and add the assumption with its reasoning to the Assumptions section of README.md (known limitations go under its Known limitations), as the brief requires.
- Out of scope: Redis, distributed infrastructure, a complex frontend. The example client is a simple page in its own small Express container.

## Workflow rules

- The Decisions in docs/PLAN.md are locked. Don't change them without asking.
- Only work on the phase or task you're assigned. Don't modify files outside it.
- If you're asked to review, report findings only. Don't fix anything.
- If CLAUDE.md and docs/PLAN.md disagree, PLAN.md wins. Flag the conflict.