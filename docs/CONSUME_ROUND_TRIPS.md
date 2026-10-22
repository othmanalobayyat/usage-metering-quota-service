# Consume transaction: fewer round trips under the account lock (investigation)

| | |
|---|---|
| Date | 2026-10-22 |
| Status | **Investigation only. Not integrated.** Production `src/services/consume.service.ts` still runs PLAN.md §6 Phase 3 step by step. The prototype is in [`docs/prototypes/consume-round-trips.patch`](prototypes/consume-round-trips.patch) and was built and measured from an isolated copy |
| Decision needed | Whether to integrate it (§7) |

## 1. The current transaction, statement by statement

Measured by wrapping `pg.Client.prototype.query` around one fresh `POST /consume` on `quota_test`: 14 statements. The account usage row is locked from statement 7 until COMMIT.

| # | Statement | PLAN step | Holds the account lock? |
|---:|---|---|---|
| 1 | `select id from accounts where api_key_hash = $1` | auth | |
| 2 | `select id from users where account_id = $1 and external_user_id = $2` | 1 | |
| 3 | `select … from requests where account_id = $1 and request_id = $2` | 2 (fast path) | |
| 4 | `begin` | 3 | |
| 5 | `insert into account_usage … on conflict do nothing` | 4 | |
| 6 | `insert into user_usage … on conflict do nothing` | 4 | |
| 7 | `select units_used from account_usage … for update` | 5 | **acquired here** |
| 8 | `select units_used from user_usage … for update` | 5 | yes |
| 9 | `select … from requests where account_id = $1 and request_id = $2` | 6 (recheck) | yes |
| 10 | `select account_plan.*, user_plan.* from accounts join plans … join users … join plans …` | 7 | yes |
| 11 | `update account_usage set units_used = units_used + $1 …` (accepted only) | 9 | yes |
| 12 | `update user_usage set units_used = units_used + $1 …` (accepted only) | 9 | yes |
| 13 | `insert into requests … returning *` | 10 | yes |
| 14 | `commit` | 11 | **released** |

So one accepted decision holds the account row for **8 round trips** (7–14). A rejected one holds it for 6, because steps 11–12 are skipped. Every other consume of that account queues on statement 7 for the whole time. `docs/LOAD_TEST.md` §4 measured the interval between decisions on a hot account at about 11.7 ms, of which an estimated 2.8 ms is database work. Most of the rest is per-statement cost in the API (query building, driver, event loop), paid once per round trip.

## 2. What the transaction guarantees, and why

- **I1. No overspend at either level.** Every consume of an account takes the account row lock (statement 7) before reading usage, and holds it until COMMIT. Two decisions on one account can't overlap, so each one reads the total the previous one committed. The user row is only ever changed by consumes of its own account, which hold the account lock, so the user total is serialized too. A transaction alone (READ COMMITTED) would not prevent this: two consumes could read the same total and both be accepted.
- **I2. Account usage = sum of user usage, and = sum of accepted request units.** Both increments and the request row are written in the same transaction, so they commit together or not at all.
- **I3. One decision per `(account, requestId)`.** The unique constraint is the hard guarantee. The recheck after the lock (statement 9) makes it the normal path: a duplicate that waited on the lock sees the first copy's committed row and replays it. Step 12 covers duplicates that held different locks (e.g. either side of a month boundary). It rolls back and replays.
- **I4. Fresh reads after the lock.** READ COMMITTED gives each *statement* a new snapshot. Statements 9 and 10 start after the lock was granted, so they see the request row and any plan change committed by the transaction the consume waited on. This is why the plans are read after the lock (PLAN.md §6 Phase 3, step 7).
- **I5. No deadlock between consumes.** Locks are always taken account row first, then user row (statements 7, 8). The upserts (5, 6) are in the same order.
- **I6. Nothing partial on failure.** `inTransaction()` rolls back on any error, and destroys a connection whose ROLLBACK failed or that errored while checked out, so a broken session never returns to the pool.

## 3. The proposal: 8 → 4 statements under the lock

An earlier summary said "8 → 3". **That figure was wrong: the safe reduction is 8 → 4.** Measured on the prototype: 10 statements per fresh consume, 4 of them from the lock to COMMIT.

| # | Prototype statement | Replaces | Holds the account lock? |
|---:|---|---|---|
| 1–6 | unchanged | auth, steps 1–4 | |
| 7 | `with a as (select … from account_usage … for update), u as (select … from user_usage … and exists (select 1 from a) for update) select …` | 7 + 8 | **acquired here** |
| 8 | the plan join, plus `left join requests on (account_id, request_id)` | 9 + 10 | yes |
| 9 | `with acc as (update account_usage …), usr as (update user_usage …) insert into requests … returning …` (rejected: the insert alone) | 11 + 12 + 13 | yes |
| 10 | `commit` | 14 | **released** |

**Why 7 + 8 can be one statement while keeping I5.** The user row's scan has `exists (select 1 from a)` in its WHERE clause. It can't produce a row until CTE `a` has produced its row, and `a` produces it only after the account row is locked. So the order is enforced by a data dependency, not by the planner's join order. Rows locked `FOR UPDATE` in READ COMMITTED are returned at their newest committed version (Postgres re-checks them after a wait), so the usage values are as fresh as today's statements 7 and 8.

**Why 9 + 10 can be one statement while keeping I3 and I4.** It is a new statement, started after the lock was granted, so it has the same fresh snapshot as today's two.

**Why 3 is not safe with this design.** The obvious next merge, putting the recheck and the plan read into the locking statement, breaks I3 and I4. That statement's snapshot is taken when it *starts*, before it waits on the lock. Only the locked rows are re-read after the wait, so it would miss the request row and any plan change committed by the transaction it waited on. Duplicates would then fall through to the unique-violation path (correct, but a full rollback), and queued consumes would be decided against the old plan. The existing queued-plan tests (`consume.db.test.ts` "a plan change that commits while consumes wait on the account row") exist to catch exactly that. Getting to 3 would need the reads in a server-side function (each statement inside a PL/pgSQL function gets its own snapshot) or the rules moved into SQL. Both move logic out of `evaluate()` and TypeScript, so they were not prototyped.

**Why 11–13 can be one statement while keeping I2 and I6.** Data-modifying CTEs run in the same statement as the insert, and they all succeed or the statement fails and the transaction rolls back. The statement returns how many rows each UPDATE touched, and the prototype throws unless both are exactly 1. Both rows are locked by this transaction, so anything else is a bug.

The upserts (5, 6) are left as two statements. In one statement, the order between two data-modifying CTEs isn't defined. Two first-of-the-month consumes could then insert the account row and the user row in opposite orders and deadlock on each other's uncommitted inserts. They also run before the lock, so merging them wouldn't shorten the hold.

## 4. The prototype

- **What:** [`docs/prototypes/consume-round-trips.patch`](prototypes/consume-round-trips.patch). `git apply --check` passes against the current working tree. It was not applied here.
- **Diff to `src/services/consume.service.ts`:** steps 5–10 as described above. The step numbers, step 2, step 12, `evaluate()` and the response are unchanged.
- **Diff to `tests/consume.db.test.ts`:** two lock-wait detectors match SQL text. `'insert into "requests"%'` becomes `'%insert into "requests"%'`, and `'%from "account_usage"%for update'` becomes `'%from "account_usage"%for update%'`. That's because the prototype's statements start with `with` and continue after `for update`. No assertion changed. (Matching SQL text is brittle for any refactor of the transaction: [ENGINEERING_AUDIT.md](ENGINEERING_AUDIT.md) ENG-12.)
- **Where it ran:** a copy of the working tree in the session scratch directory. Your working tree, `load/results/` and `admin-client/` were not touched.

## 5. Correctness evidence for the prototype

| Property | Evidence | Result |
|---|---|---|
| Whole existing behavior | `REQUIRE_DB=1 npx vitest run` in the prototype copy: the full suite, including every consume, idempotency, plan-change, concurrency, lock-timeout, pool-timeout, restart and demo test | **34 files, 626 tests passed** (the same count as production) |
| Atomic accounting, no overspend | `consume.db.test.ts` "50 parallel consumes never exceed the allowance…", "…by one user…", "60 parallel consumes race at the user monthly limit: exactly 50 accepted, 10 rejected by USER"; `decision-snapshot.db.test.ts` "the accepted snapshots chain" | passed |
| Simultaneous duplicates | "20 parallel requests with the same requestId…", the step 12 tests, `consume-locking.db.test.ts` "two users of one account racing…"; the `retry-storm` load runs (§6: fresh = request rows) | passed |
| History and decisions consistent | `decision-snapshot.db.test.ts`: `evaluate()` on the stored inputs equals every stored decision; load check 6 on every row of every run (§6) | passed / 0 violations |
| Plans read after the lock | the two queued plan-change tests | passed |
| Failure and rollback | `consume-locking.db.test.ts` "a failure while recording the decision rolls back the increments…" (trigger raises inside statement 9, after the UPDATE CTEs ran) and "the connection dies mid-transaction…" (`pg_terminate_backend` during statement 9); "lock timeout"; "pool timeout" | passed |
| Lock order | `consume-locking.db.test.ts` "takes the account row before the user row…": with the user row held elsewhere, the consume's account lock is visible to a third session (`FOR UPDATE NOWAIT` → 55P03) | passed; **red check**: a variant that locks the user row first fails it (`expected undefined to be '55P03'`) |
| Deadlocks | no `40P01` in any test run or load run; "two users of one account racing in opposite orders" | none observed |

## 6. Benchmark

Method, environment, raw files and per-run numbers are in [LOAD_TEST.md](LOAD_TEST.md) §11. In short: one host, one database, two images that differ only in this patch, one warm-up each, then 3 ABBA rounds of 4 scenarios at 50 VUs × 30 s. Medians:

| Scenario | Baseline RPS | Prototype RPS | Change | p95 baseline → prototype | Ranges overlap? |
|---|---:|---:|---:|---|---|
| hot account | 159.4 | 230.9 | **+44.9%** | 387.3 → 275.5 ms | no |
| many accounts | 600.8 | 710.8 | **+18.3%** | 106.7 → 93.0 ms | no |
| retry storm | 474.9 | 506.8 | +6.7% | 543.8 → 481.0 ms | **yes**: not a demonstrated gain |
| mixed | 176.9 | 279.0 | not like-for-like | 355.0 → 230.7 ms | n/a: the prototype exhausted the users' allowances sooner, so more of its requests were cheap rejections |

0 HTTP errors and 0 invariant violations (checks 1–4 and 6) in all 26 runs, for both images.

## 7. Trade-offs and recommendation

**Gains (measured):** one account's decision rate +45% (6.27 → 4.33 ms between decisions on the hot row), +18% across many accounts, and p95/p99 down by about 30% on the hot account. No test or load-run regression.

**Costs:**
- **Two statements become hand-written SQL** (``tx.execute(sql`…`)``): the locking CTE and the write CTE. Drizzle no longer type-checks those column names, and the result row types are declared by hand. Mistakes there are caught by the integration tests, not the compiler.
- **The lock order inside one statement rests on a data dependency** (`exists (select 1 from a)`), not on statement order. That's sound (§3) and guarded by a test that was shown to fail when the order is reversed, but it's a subtler idea to explain and review than two separate `SELECT … FOR UPDATE`s.
- **Two test helpers that match SQL text need widening** (ENG-12), as included in the patch.
- **PLAN.md and CLAUDE.md describe steps 5–10 as separate statements.** The order and semantics are unchanged, but the docs would need to say steps 5, 6+7 and 9+10 each run as one statement.
- **Not addressed:** duplicates still queue on the account row (retry storm), and one account is still serialized. This is a constant-factor gain, not a change in the scaling model.

**Recommendation:** integrate it. The gain on the scenario that bounds the design (one busy account) is large and outside run-to-run noise. Every existing correctness test passes unchanged in assertions, and the new lock-order and failure tests cover what the change could break. Integrating means: apply the patch, update the step descriptions in `docs/PLAN.md` §6, `CLAUDE.md` and the README's consume-transaction section, re-run the suite and `load/ab.sh` once on the committed tree. **This is your decision. Nothing has been integrated.**

## 8. Second review (2026-10-22): PostgreSQL and security review, fair re-benchmark

### Statement-level review of the patch

| # | Item | Finding |
|---|---|---|
| 1 | Lock order inside the locking CTE | **Holds.** `EXPLAIN (VERBOSE)` with seq scans and with `enable_seqscan = off` gives the same shape. `InitPlan 2 (CTE Scan on a)` feeds a `One-Time Filter` on a `Result` node above the `user_usage` scan, under `LockRows`. The uncorrelated `EXISTS` stays an InitPlan; it isn't turned into a join. So the user row isn't read or locked until `a` has locked the account row |
| 2 | Freshness after a lock wait | **Holds, and depends on `FOR UPDATE` on `u`.** The statement's snapshot predates the wait. Only rows locked `FOR UPDATE` are re-read at their newest committed version (READ COMMITTED's re-check). Red check: with `FOR UPDATE` removed from `u`, the deterministic test "the user's own total, updated while it waited" and the user-limit race fail. **Removing that clause in a later edit would cause overspending.** It needs a comment that says so, at integration |
| 3 | Recheck + plan read (one statement) | Same semantics: a new statement after the lock, so a new snapshot. The `LEFT JOIN requests` on `(account_id, request_id)` matches at most one row (unique) and uses the unique index (2 index scans per fresh consume in every load run, as before). It reads the plans even when it then replays; no effect on results |
| 4 | Write CTE (increments + insert) | All-or-nothing: data-modifying CTEs and the INSERT are one statement. A failure in any part (trigger, CHECK, unique violation) undoes all of it. Tested: a failure raised in the INSERT, a failure raised in the `user_usage` UPDATE (the account increment is rolled back too), a backend killed mid-statement. The row-count check (`acc`/`usr` must be 1) is **stricter** than the baseline, which would silently increment nothing on 0 rows |
| 5 | Parameters, SQL injection | Every value is a bound parameter (`$n`; checked in the logged statements). Identifiers are constants, and there is no `sql.raw`. No injection surface |
| 6 | Types | The enum columns, `date` and `integer` take their parameter types from the target columns. `created_at` is sent as an ISO string and `updated_at` as a `Date`: the same instant, but an inconsistency to clean up |
| 7 | Constraint names and error mapping | Unchanged. `isUniqueViolation(…, 'requests_account_id_request_id_unique')` and `isOverloadError` find the pg error through Drizzle's wrapper the same way (step 12 tests pass) |
| 8 | Response and idempotency contract | Unchanged. The response is built from the values inserted instead of `RETURNING *`. Same fields, and replays are byte-identical (tests compare them) |
| 9 | Invalid users | Unchanged: step 1 (404) runs before the transaction |
| 10 | Timeouts (behavior difference) | Both row-lock waits now share one statement's `statement_timeout` (4 s), instead of one statement each. Worst-case wait drops from 3 s + 3 s to 4 s total, and both outcomes map to 503. The user-row wait is never contended by consumes (the account lock serializes them) |
| 11 | Type safety (loss) | Two statements are hand-written SQL: table and column names aren't checked by TypeScript, and result rows are typed by assertion (`tx.execute<…>`). Mitigated by the integration tests. **Recommended at integration:** build them from the schema objects (`${accountUsage}`, `sql.identifier(accountUsage.unitsUsed.name)`), so a rename fails to compile |
| 12 | Tooling coupling | Two test helpers match SQL text (in the patch). `load/uncontended.sh` times the old statements one by one; `load/index-scans.sql` describes "the recheck after the lock (step 6)". Both stay correct as measurements but would describe the old layout |

No race condition, deadlock path or contract change was found.

### Correctness tests for the review

`tests/consume-races.db.test.ts` has 11 tests. Each ends with a ledger check: account total = sum of user totals = sum of accepted request units, every decision equals `evaluate()` on its stored inputs, and accepted decisions form one serial chain. The tests:
- 30 requests for the last 5 account units;
- 30 requests for one user's last 5 units, while another user consumes;
- both limits nearly reached at once;
- 25 simultaneous copies of one `requestId`;
- copies of one `requestId` racing other requests for the last 4 units;
- one `requestId` sent concurrently with three different payloads (one decision; matching copies replay, the rest get 409);
- 8 users × 12 requests at once;
- injected failures inside a concurrent burst, then retried;
- a failure in the user increment rolls back the account increment;
- two deterministic "decided on what the lock holder committed" tests (user total and account total changed while the consume waited in its locking statement).

Red checks on the prototype:
- V1: user row not locked → 2 failures.
- V2: totals read before the lock → 7 failures.
- V3: no row locks → 7 failures.

### Benchmark

The second session ([LOAD_TEST.md](LOAD_TEST.md) §12) used an equal-work mixed scenario, `ANALYZE` before every run, 5 ABBA rounds and paired analysis. Two runs are excluded because the laptop suspended during them, and the rest ran under memory pressure, so only paired ratios are used:
- hot account: **+42.3%** (geometric mean, 5/5 pairs, 1.305–1.559);
- mixed: +56.2% (4/4), at an equal rejected share of 46%;
- many accounts: +19.7% (4/4);
- retry storm: +19.8% (5/5, wider spread).

Hot account over both sessions: 8/8 pairs faster, p = 0.0078. 0 invariant violations in all 42 runs.

### Documentation that becomes inaccurate on integration

| Where | What |
|---|---|
| `CLAUDE.md` "Consume transaction" steps 5–10 | Steps 5, 6+7 and 9+10 each become one statement. The order and semantics hold, but the text reads as separate statements. Step 5's lock order would be "enforced by a data dependency inside one statement" |
| `docs/PLAN.md` §6 Phase 3, steps 5–10 | The same. The locked "Decisions" list is unaffected |
| `README.md` "The consume transaction" (steps 5–10, "Fixed lock order (step 5)") | The same; plus the bottleneck text quoting step 5's `SELECT … FOR UPDATE` (historical measurement, still true for those runs) |
| `src/services/consume.service.ts` comments | The `PROTOTYPE:` prefixes; add the warning from item 2 |
| `tests/consume.db.test.ts` | The two SQL-text patterns (in the patch) |
| `load/uncontended.sh`, `load/index-scans.sql` comments | Describe the old statement layout |
| This document, `ENGINEERING_AUDIT.md` ENG-10, `LOAD_TEST.md` §11–§12 | "Not integrated" status |
