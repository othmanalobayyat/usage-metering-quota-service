# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Usage Metering and Quota Service: a backend that other applications call to check and consume units against account-level and user-level plan limits. The repo is pre-scaffold: only `docs/REQUIREMENTS.md` (the brief) and `docs/PLAN.md` (the phased implementation plan, decisions, and API) exist. Read `docs/PLAN.md` before starting any phase. Don't tick checklist items in PLAN.md. The developer ticks them after review and tests pass.

Planned stack: TypeScript, Express, Drizzle ORM, PostgreSQL, Zod, Vitest + Supertest, Docker Compose, k6 (Compose profile `load`). Once `package.json` exists, add the real build/lint/test commands (including running a single Vitest test) to this file.

## Architecture (as planned)

- `config.ts` validates env with Zod and fails fast (e.g. missing `DATABASE_URL`).
- `app.ts` exports an app factory; `server.ts` only calls `listen`, so Supertest can use the factory.
- Container entrypoint: migrate → seed → start. `docker compose up --build` from a fresh clone must work with no manual steps.
- Predefined plans are seeded with **fixed UUIDs** and `ON CONFLICT (id) DO NOTHING` so seeding is idempotent. The limits are Starter 10,000/mo · 100/req, Pro 100,000/mo · 1,000/req (account plans), Basic 1,000/mo · 20/req, Premium 5,000/mo · 100/req (user plans). New accounts default to Starter and new users to Basic.
- Every month calculation goes through `lib/month.ts` `toUtcMonth(date)`. Services take an injected clock (`now()`) so tests can cross month boundaries.
- `rules.ts` `evaluate({accountPlan, userPlan, accountUsed, userUsed, units})` is a **pure function with no DB access**. The check order is user per-request → account per-request → user monthly → account monthly, and the first failure wins. `remaining = max(0, allowance - used)`. New rules (e.g. a daily cap) go here, not in the transaction.

### Consume transaction (`consume.service.ts`): keep this exact order

1. Resolve the user by `(account_id, external_user_id)`, else 404.
2. Fast-path `requestId` lookup outside the transaction. This is an optimization only.
3. BEGIN → upsert this month's usage rows (`ON CONFLICT DO NOTHING`, account then user).
4. `SELECT ... FOR UPDATE` the **account usage row first, then the user row**. This lock order prevents deadlocks.
5. Recheck `requests` for the `requestId` after locking. This recheck is the real idempotency guarantee.
6. Load account and user plans in **one join query after the lock**.
7. `evaluate()`. If accepted, increment both usage rows. Insert the request row with snapshots (plan IDs, limit, remaining). COMMIT.
8. On a unique violation (`23505`), roll back, re-read, and return the stored decision.

## Invariants and conventions

- Auth: `X-API-Key` header on everything except `POST /accounts` and `/healthz`. Keys are `mk_` + 32 random bytes, stored as a **SHA-256** hash (not bcrypt, because bcrypt on every request would hurt load-test performance).
- Every query filters by `account_id`; never fetch by ID alone. Another account's resource returns **404**, not 403, so existence isn't leaked.
- Users are addressed by `externalUserId` in URLs. `requestId` is scoped per account.
- A quota rejection is a business decision: **HTTP 200** with `status: "REJECTED"`, `reasonCode`, `rejectedBy` (`ACCOUNT`/`USER`), `limit`, and `remaining`. It is not an error code.
- Replays return the stored original snapshot with `replayed: true`. The same `requestId` with different input returns 409 `IDEMPOTENCY_CONFLICT`.
- One error shape, `{ error: { code, message } }`, with codes defined in a single const file (table in PLAN.md §4). A 500 never exposes details.
- One shared plan-assignment guard for accounts and users: the plan type must match the target, and the plan must be predefined or owned by this account. No FK can enforce the ownership rule, so the guard is the only enforcement.
- Predefined plans are read-only (PATCH → 403). Custom plans cannot be deleted.
- A DB CHECK on `requests` ties `status` to the nullability of `reason_code`/`rejected_by`/`limit_value`.
- Usage reads never create rows; a missing month row means 0 consumed. History uses cursor pagination on `(created_at, id)`, never offset.
- Invariant (asserted in tests and after load runs): account usage = sum of its users' usage.
- Unspecified product behavior: pick something sensible, apply it consistently, and document the assumption with its reasoning in the README.
- Out of scope: Redis, distributed infrastructure, a complex frontend. The example client is a simple page in its own small Express container.

## Workflow rules

- The Decisions in docs/PLAN.md are locked. Don't change them without asking.
- Only work on the phase or task you're assigned. Don't modify files outside it.
- If you're asked to review, report findings only. Don't fix anything.
- If CLAUDE.md and docs/PLAN.md disagree, PLAN.md wins. Flag the conflict.