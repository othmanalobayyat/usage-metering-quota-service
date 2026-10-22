# Requirements Traceability

| | |
|---|---|
| Date | 2026-10-22 |
| Source of truth | `docs/REQUIREMENTS.md` (the brief). Project decisions from `docs/PLAN.md` are marked **P**, implied requirements **I** |
| Base | `docs/FINAL_AUDIT_REPORT.md` §4 (commit `b454b81`). IDs RQ-01…RQ-57 are kept so the two documents line up; RQ-58 onward are new rows |
| Code state | `6d8a338` plus this session's uncommitted changes (decision snapshot, key format check, `Cache-Control: no-store`, CI workflow, `load/mixed.js`, `load/ab.sh`), listed in [ENGINEERING_AUDIT.md](ENGINEERING_AUDIT.md) §5 |
| Suite run | `REQUIRE_DB=1 npx vitest run` → **36 files, 640 tests passed, 0 failed, 0 skipped** (2026-10-22, against `quota_test` on the Compose PostgreSQL 16) |

**Status:** **PASS** = implemented, and an automated test or a command run in this session shows it. **PARTIAL** = implemented with a stated gap. **FAIL** = not met. **NOT VERIFIED** = implemented, but nothing run in this session demonstrates it.

Every test file below runs with `REQUIRE_DB=1 npx vitest run tests/<file>` (the `.db.` files need `docker compose up -d db`).

## 1. Accounts, users and authentication

| ID | Requirement (meaning) | Src | Code | Tests | Status | Evidence, gaps |
|---|---|---|---|---|---|---|
| RQ-01 | Create accounts and issue one API key each | B | `accounts.service.ts` `createAccount()`; `lib/api-key.ts` `generateApiKey()` | `accounts.db.test.ts` "creates an account on Starter and returns the plaintext key once", "issues a different key to every account" | PASS | Key = `mk_` + 32 bytes from `crypto.randomBytes` (256 bits) |
| RQ-58 | The key isn't stored and isn't cached in transit | I | SHA-256 only (`hashApiKey`); `routes/accounts.ts` sets `Cache-Control: no-store` | `accounts.db.test.ts` "…plaintext key once" (row has no key), "…marked Cache-Control: no-store" | PASS | New this session. Red check: removing the header fails the test |
| RQ-05 | The key goes in a request header and identifies the account | B | `middleware/auth.ts` `requireApiKey()` (`X-API-Key`, unique-index lookup on the hash) | `accounts.db.test.ts` "auth" | PASS | |
| RQ-06 | Reject missing or invalid keys | B | `requireApiKey()` | `errors.test.ts` "missing API key → 401" (every authenticated route), "an empty X-API-Key header counts as missing"; `accounts.db.test.ts` "invalid key → 401" | PASS | Messages: `Missing X-API-Key header` / `Invalid API key` |
| RQ-59 | A malformed key is rejected before any database work, with the same answer as an unknown key | I | `isWellFormedApiKey()` in `lib/api-key.ts`, checked first in `requireApiKey()` | `errors.test.ts` "a malformed key (…) → 401 Invalid API key, without a database lookup" (8 cases; the app has a DB stub that throws on use); `accounts.db.test.ts` "a well-formed key that was never issued → the same 401 as a malformed one"; `lib.test.ts` "every generated key passes the format check" | PASS | New this session. Red check: disabling the check fails 8 tests. The format is public, so the earlier return reveals nothing secret |
| RQ-60 | Revoked keys | — | Not applicable: there is no revocation or rotation | — | n/a | Not required by the brief. README Known limitations: "No API key rotation or revocation". See [ENGINEERING_AUDIT.md](ENGINEERING_AUDIT.md) ENG-07 |
| RQ-02 | Register users under accounts | B | `users.service.ts` `registerUser()` | `users.db.test.ts` "POST /users" | PASS | |
| RQ-03 | Assign or change user plans | B | `setUserPlan()`, `plan-guard.ts` `resolveAssignablePlan()` | `users.db.test.ts` "PUT /users/:externalUserId/plan" | PASS | |
| RQ-04 | Keep each account's users and usage separate | B | `account_id` predicate on every query; composite FKs `user_usage`/`requests` → `users(account_id, id)` (`schema.ts`) | `isolation.db.test.ts`; `usage.db.test.ts` "account isolation"; `requests.db.test.ts` isolation cases; `schema.db.test.ts` "composite FKs to users(account_id, id)" | PASS | The composite FK makes a cross-account usage or request row impossible at the database level |
| RQ-07 | A supplied user must belong to the calling account | B | `consume.service.ts` step 1, `requests.service.ts`, `usage.service.ts`, `users.service.ts`: user resolved by `(account_id, external_user_id)` | `consume.db.test.ts` "another account's user → 404"; `isolation.db.test.ts` | PASS | |
| RQ-08 | Another account's resource is a 404, so existence doesn't leak | P | `plan-guard.ts`, `plans.service.ts` `getPlan()` | `isolation.db.test.ts` "A's users", "A's custom plans" | PASS | |
| RQ-61 | Cross-account disclosure through other channels (error text, pagination cursors) | I | Error messages name no other account's data; cursors are opaque, and every page query is scoped by `account_id` (`requests.service.ts`, `users.service.ts`) | `requests.db.test.ts` and `users.db.test.ts` isolation and cursor cases | PASS | A cursor from account A used by account B returns only B's rows. Cursors aren't signed, and contain a timestamp and an internal ID (README "API shape") |

## 2. Plans and limits

| ID | Requirement | Src | Code | Tests | Status | Evidence, gaps |
|---|---|---|---|---|---|---|
| RQ-09 | Predefined account and user plans at startup, documented limits | B | `db/seed.ts` (fixed UUIDs, `ON CONFLICT (id) DO NOTHING`); `docker-entrypoint.sh` migrate → seed → start | `schema.db.test.ts` "seed" | PASS | Starter 10,000·100, Pro 100,000·1,000, Basic 1,000·20, Premium 5,000·100 (README "Predefined plans") |
| RQ-10 | Accounts create, view and update custom plans, and assign them | B | `routes/plans.ts`, `plans.service.ts` | `plans.db.test.ts` | PASS | No DELETE (locked decision) |
| RQ-11 | Users sharing a plan keep separate totals | B | PK `user_usage(user_id, month)` | `consume.db.test.ts` "updating a custom user plan affects every user assigned to it"; `usage.db.test.ts` | PASS | |
| RQ-12 | Predefined plans read-only (allowed by the brief) | B | `getEditablePlan()` → 403 | `plans.db.test.ts` "PATCH /plans/:id" | PASS | |
| RQ-13 | Inspect the plans and limits currently applied to the account and to each user | B | `GET /account`, `GET /users/:externalUserId` | `accounts.db.test.ts` "GET /account"; `users.db.test.ts` "GET /users/:externalUserId" | PASS | |
| RQ-14 | Plan ownership and type checked on every assignment | P | `resolveAssignablePlan()`, the only writer of a caller-chosen `plan_id` | `isolation.db.test.ts`; `accounts.db.test.ts` "wrong plan type → 400" | PASS | Rule 3 (ownership) can't be expressed as an FK; the guard is its only enforcement (PLAN.md §3) |
| RQ-25 | Plan changes apply to new requests after the update, with no redeploy | B | Plans read in step 7, after the lock | `consume.db.test.ts` "plan changes", including the two queued tests "a plan change that commits while consumes wait on the account row" | PASS | |
| RQ-26 | Editing a custom plan affects its assignees | B | Assignments reference plan rows by ID | `consume.db.test.ts` "lowering a custom plan below current usage…", "updating a custom user plan affects every user…" | PASS | |
| RQ-17 | Monthly allowance per UTC calendar month | B | `lib/month.ts` `toUtcMonth()`; injected clock | `month.test.ts` (including a non-UTC process time zone); `consume.db.test.ts` "months" | PASS | |
| RQ-18 | Maximum units per request, at both levels | B | `rules.ts` `evaluate()` | `rules.test.ts`; `consume.db.test.ts` "25 units on Basic → REJECTED by USER…" | PASS | |
| RQ-20 | Both plans apply together; a larger user plan doesn't raise the account's allowance | B | `evaluate()` checks all four rules | `consume.db.test.ts` "a larger user allowance doesn't raise the account's"; the brief's three examples in "decisions" | PASS | |
| RQ-28 | Allowance lowered below usage → 0 remaining, further use rejected | B | `remaining = max(0, limit − used)` | `consume.db.test.ts` "plan switch keeps usage; allowance lowered below usage → remaining 0 and rejected"; `decision-snapshot.db.test.ts` (account lowered from 100 to 30 with 35 used) | PASS | |
| RQ-27 | Switching plans keeps consumed units | B | Usage keyed by account/user and month, not by plan | `consume.db.test.ts` "plan switch keeps usage…"; `accounts.db.test.ts` "switches to a predefined account plan and keeps usage" | PASS | |
| RQ-62 | Correct remaining allowance after a plan change | B | `remaining` computed under the lock against the plan read after the lock | `consume.db.test.ts` "plan changes"; `decision-snapshot.db.test.ts` re-derives every `remaining` from the stored inputs | PASS | |
| RQ-29 | Changes preserve past request history, and past decisions stay explainable | B | Request rows are never updated. **New:** each row stores both plans' limits and usage before the request (migration `0001`) | `consume.db.test.ts` "plan changes preserve past request history"; `decision-snapshot.db.test.ts` "every decision stays explainable after its plans are edited and switched" (`evaluate()` on the stored inputs equals the stored decision for 6 accepted and rejected decisions across a PATCH, an allowance cut and a switch) | PASS (new rows) / PARTIAL (rows from before `0001`) | Rows written before `0001` have `snapshot: null`: their limits at the time can't be recovered, so none were backfilled. Closes QA F4 for new data |
| RQ-32 | Consumed and remaining, account and users | B | `usage.service.ts` | `usage.db.test.ts` | PASS | |
| RQ-33 | Previous months' usage and request outcomes | B | `?month=YYYY-MM` on usage and history | `usage.db.test.ts`; `requests.db.test.ts` "month filter"; `consume.db.test.ts` "new month starts at zero; old month is untouched and still queryable" | PASS | A past month's `remaining` uses the current plan (README assumption); its decisions carry their own snapshot |
| RQ-30 | Correct under concurrent plan updates | B | READ COMMITTED, plans read after the lock; serial-order argument in README "Plan changes under concurrency" | `consume.db.test.ts` "a plan update racing parallel consumes…", "a user plan switch racing parallel consumes…", the two queued tests | PASS | |
| RQ-31 | Explain any additional rules | B | None implemented. A daily cap is described in the README | — | PASS (nothing to demonstrate) | |

## 3. Consumption and reliability

| ID | Requirement | Src | Code | Tests | Status | Evidence, gaps |
|---|---|---|---|---|---|---|
| RQ-15 | Positive whole-number units, a user ID and a request ID | B | `routes/consume.ts` (`z.int().min(1).max(2³¹−1)`, strict body) | `consume.db.test.ts` "validation and access" (0, −1, 1.5, "5", 2³¹, missing fields, extra fields, boundaries) | PASS | |
| RQ-16 | All or nothing; a rejection consumes nothing | B | `evaluate()`; increments only if ACCEPTED | `consume.db.test.ts` "a rejection changes no usage but is recorded"; `consume-locking.db.test.ts` | PASS | |
| RQ-19 | The brief's three worked examples | B | as above | `consume.db.test.ts` "decisions" | PASS | |
| RQ-21 | Account usage = sum of accepted user usage | B | Both increments in one transaction | `expectInvariant()` in `consume.db.test.ts`; `restart.db.test.ts`; `load/check-invariants.sql` checks 1 and 4 after every load run | PASS | 0 violations in every load run this session ([LOAD_TEST.md](LOAD_TEST.md) §11) |
| RQ-22 | A rejection names the rule and whether it is the account's or the user's | B | `reasonCode`, `rejectedBy`, `limit` | `consume.db.test.ts` "decisions" | PASS | |
| RQ-23 | Rule check order | P | `evaluate()` | `rules.test.ts` | PASS | |
| RQ-24 | Usage counts in the processing month; each month starts at 0 | B | One clock read per request → `toUtcMonth()` | `consume.db.test.ts` "months", "a retry in the next month replays the original decision…" | PASS | |
| RQ-34 | Accepted and rejected decisions recorded in history | B | Step 10 inserts every decision | `requests.db.test.ts`; `consume.db.test.ts` "a rejection changes no usage but is recorded" | PASS | |
| RQ-50a | Idempotency: same `requestId` + same input → stored decision, `replayed: true` | B | Steps 2, 6, 12 | `consume.db.test.ts` "idempotency" | PASS | |
| RQ-50b | Same `requestId`, different input → 409 | B | `replay()` | `consume.db.test.ts` "same requestId with different units or a different user → 409…" | PASS | |
| RQ-50c | Simultaneous duplicates consume once | B | Account lock + recheck (step 6) + unique constraint (step 12) | `consume.db.test.ts` "20 parallel requests with the same requestId…", "unique-violation safety net (step 12)"; `consume-locking.db.test.ts` "two users of one account racing…" (20 duplicated IDs); `retry-storm` load runs (fresh = request rows) | PASS | |
| RQ-50d | The client loses the response; the retry gets the original outcome | B | The decision is a committed row; a retry replays it | `consume.db.test.ts` "retry returns the identical response…", "a rejected decision replays as a rejection"; `restart.db.test.ts` (replay after an API restart) | PASS | |
| RQ-50e | A failure inside the transaction leaves nothing behind, and the retry is decided fresh | B | `inTransaction()` rolls back, and destroys a broken connection | `consume-locking.db.test.ts` "a failure while recording the decision rolls back the increments…", "the connection dies mid-transaction…"; `consume.db.test.ts` "lock timeout", "pool timeout" | PASS | New tests this session (trigger-injected failure, `pg_terminate_backend` mid-transaction) |
| RQ-63 | Atomic accounting under concurrency, with no overspend at either level | B | `FOR UPDATE` account row, then user row | `consume.db.test.ts` "50 parallel consumes never exceed the allowance…", "…by one user…", "60 parallel consumes race at the user monthly limit…"; `decision-snapshot.db.test.ts` "under concurrency, the accepted snapshots chain" | PASS | |
| RQ-64 | Lock order and deadlocks | I | Account row before user row | `consume-locking.db.test.ts` "takes the account row before the user row…" (observed with `FOR UPDATE NOWAIT` from a third session), "two users of one account racing…" | PASS | New. Red check: a variant that locks the user row first fails it |
| RQ-35 | Data survives a restart | B | PostgreSQL, named volume `db-data` | `restart.db.test.ts` (API process restart under tsx). Compose restart: [ENGINEERING_AUDIT.md](ENGINEERING_AUDIT.md) §6 | NOT VERIFIED → updated in §5 below | |
| RQ-65 | Correct behavior when database operations fail (useful errors) | B | `middleware/errors.ts`: overload → 503 + `Retry-After`; other → 500 with no details; `/healthz` → 503 when the DB is down | `errors.test.ts` "overload → 503…", "…stays 500 with no Retry-After"; `healthz.db.test.ts` "with a real driver and no database"; `consume-locking.db.test.ts` | PASS | |
| RQ-66 | Pagination and boundary conditions | B | Keyset cursor on `(created_at, id)`, `limit` 1–100 | `users.db.test.ts` "GET /users pagination"; `requests.db.test.ts` (page order with no duplicates or gaps including same-millisecond ties, last page `nextCursor: null`, a decision committed after page 1, a cursor among another account's rows, `?limit=0/101/abc/1.5`, `cursor=garbage` and bad `month` → 400) | PASS | Late-committing decisions can sort behind a cursor (AUD-02, documented in README "History isn't a change feed") |
| RQ-53 | No integer overflow | I | Inputs ≤ 2³¹−1; an increment only when `used + units ≤ limit` | `consume.db.test.ts` "boundary values are accepted by validation"; `plans.db.test.ts` | PASS | |
| RQ-54 | Malformed input is never a 500 | I | `app.ts` UTF-8 check, `lib/schemas.ts`, `middleware/errors.ts` | `input-encoding.db`, `unicode-*`, `dot-segment-*`, `errors.test.ts` | PASS | |
| RQ-55 | A 500 exposes no internals | I | `errorHandler` | `errors.test.ts` "an unexpected failure → 500 INTERNAL_ERROR without details" | PASS | |
| RQ-56 | A quota rejection is HTTP 200 | P | `routes/consume.ts` | `consume.db.test.ts` | PASS | |

## 4. Deliverables and usability

| ID | Requirement | Src | Code | Tests / command | Status | Evidence, gaps |
|---|---|---|---|---|---|---|
| RQ-37 | A working example client using an account's key on behalf of its users | B | `client/src/` | `demo.db.test.ts`; `client-server.db.test.ts` (real client process, `POST /demo/run`, all steps `ok`) | PASS | |
| RQ-38 | Users with different plans; accepted; user-limit rejection; shared account-limit rejection | B | `client/src/demo.ts` | `demo.db.test.ts` (fixed expected values for every step) | PASS | |
| RQ-39 | A plan change alters behavior with no client code change | B | `demo.ts` step 3–4 | `demo.db.test.ts` | PASS | |
| RQ-40 | The page displays decisions and remaining allowances | B | `client/public/index.html` | `client-server.db.test.ts` "GET / returns the page" (HTML only) | NOT VERIFIED (visual) | No browser was used in this session |
| RQ-41 | Instructions for running the example | B | README "Demo client" | — | PASS | |
| RQ-42 | Compose file with API, PostgreSQL and client | B | `docker-compose.yml` | `compose.test.ts` (resolved config) | PASS | |
| RQ-43 | `docker compose up --build` works from a fresh clone, with no manual steps | B | entrypoint migrate → seed → start | Fresh-clone run: [ENGINEERING_AUDIT.md](ENGINEERING_AUDIT.md) §6; CI job `compose` | NOT VERIFIED → updated in §5 below | |
| RQ-44 | DB initialization and seeding at startup | B | `docker-entrypoint.sh`, `src/scripts/` | `maintenance-pool.db.test.ts`; `schema.db.test.ts` "seed"; `decision-snapshot.db.test.ts` "migration 0001 on a populated database" | PASS | |
| RQ-45 | Required configuration and how to reach the client documented | B | README "Quick start", "Configuration" | — | PASS | |
| RQ-51 | README: API, model, keys, rules, plan changes, retries, assumptions, design, limitations | B | README | — | PASS | Updated this session for snapshots, the key format check, `no-store` and CI |
| RQ-52 | Automated tests incl. API key validation and account isolation | B | `tests/` | 36 files, 640 tests passed | PASS | |
| RQ-46 | Load testing with evidence, method and lessons | B | `load/`, `docs/LOAD_TEST.md` | §1–§10 and this session's §11 | PASS | |
| RQ-47 | Correct "as rules change and requests arrive concurrently", under load | B | — | Integration: the race and queued tests above. Load: check 6 (snapshot) holds for every row in §11's runs, including `mixed` (≈⅓ rejections) | PARTIAL | No load scenario changes a plan *during* a run. Check 6 now makes such a scenario checkable |
| RQ-48 | Scripts, tools and config to reproduce performance results committed | B | `load/*.sh`, `load/*.js`, `load/ab.compose.yml` | `load/ab.sh` session in §11 | PASS | §9–§12 raw results under `load/results/` were committed on 2026-10-22 (they were untracked when this row was first written) |
| RQ-49 | Bottlenecks understood; improvements that preserve correctness | B | `docs/LOAD_TEST.md` §4, §6, §8, §11 | measured | PASS | The round-trip prototype (§11) is measured but not integrated: owner's decision |
| RQ-57 | Out-of-scope features absent | B (negative) | — | — | PASS | |

## 5. Rows updated after the end-to-end checks

The end-to-end results (fresh clone, Compose restart) are in [ENGINEERING_AUDIT.md](ENGINEERING_AUDIT.md) §6. This table is their final status.

| ID | Status | Evidence |
|---|---|---|
| RQ-35 | **PASS** | `restart.db.test.ts` (API process restart), plus [Executed] on a fresh Compose stack: `docker compose restart`, and `down` (no `-v`) + `build --no-cache` + `up`, both kept usage, history and replay unchanged |
| RQ-43 | **PASS** | [Executed] `docker compose up --build` on an export of the working tree as it would be committed: healthy, migrated (0000, 0001), seeded, demo `ok: true`. The CI `compose` job repeats it on every push (not yet run on GitHub) |

## 6. Totals

Over the 69 rows in §1–§4, excluding RQ-60 (no revocation exists to verify, n/a), with RQ-35 and RQ-43 counted at their §5 status: **68 rows: PASS 65 · PARTIAL 2 · FAIL 0 · NOT VERIFIED 1**.
- **PARTIAL:** RQ-29 (rows recorded before `0001` have no snapshot), RQ-47 (no load scenario changes a plan mid-run).
- **NOT VERIFIED:** RQ-40 (page rendering in a browser).

Rows RQ-35 and RQ-43 in §3 and §4 still read NOT VERIFIED, as written before the checks; §5 holds their final status.
