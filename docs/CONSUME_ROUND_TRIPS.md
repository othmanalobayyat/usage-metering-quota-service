# Consume transaction: fewer statements under the account lock

| | |
|---|---|
| Date | 2026-10-22 |
| Status | **Prototype only. Not integrated.** Production `src/services/consume.service.ts` still runs PLAN.md §6 Phase 3 step by step. |
| Prototype | Removed from the working tree. It's in git history: `git show a5cde6c:docs/prototypes/consume-round-trips.patch` |
| Open question | Whether to integrate it (§7) |

## 1. The current transaction, statement by statement

I wrapped `pg.Client.prototype.query` around one fresh `POST /consume` on `quota_test` and counted 14 statements. The account usage row is locked from statement 7 until COMMIT.

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

So an accepted decision holds the account row for **8 round trips** (7–14), and a rejected one for 6, because 11–12 are skipped. Every other consume of that account queues on statement 7 for that whole time. [LOAD_TEST.md](LOAD_TEST.md) §4 measured the interval between decisions on a hot account at about 11.7 ms.

## 2. What the transaction guarantees, and why

- **I1. No overspend at either level.** Every consume of an account takes the account row lock (statement 7) before reading usage, and holds it until COMMIT. Two decisions on one account can't overlap, so each one reads the total the previous one committed. The user row is only changed by consumes of its own account, which hold the account lock, so the user total is serialized too. A transaction alone (READ COMMITTED) wouldn't prevent this: two consumes could read the same total and both be accepted.
- **I2. Account usage = sum of user usage = sum of accepted request units.** Both increments and the request row are written in the same transaction, so they commit together or not at all.
- **I3. One decision per `(account, requestId)`.** The unique constraint is the hard guarantee. The recheck after the lock (statement 9) makes it the normal path: a duplicate that waited on the lock sees the first copy's committed row and replays it. Step 12 covers duplicates that held different locks (for example on either side of a month boundary): it rolls back and replays.
- **I4. Fresh reads after the lock.** READ COMMITTED gives each *statement* a new snapshot. Statements 9 and 10 start after the lock was granted, so they see the request row and any plan change committed by the transaction the consume waited on. This is why plans are read after the lock (PLAN.md §6 Phase 3, step 7).
- **I5. No deadlock between consumes.** Locks are always taken account row first, then user row (statements 7, 8). The upserts (5, 6) are in the same order.
- **I6. Nothing partial on failure.** `inTransaction()` rolls back on any error, and destroys a connection whose ROLLBACK failed or that errored while checked out, so a broken connection never returns to the pool.

## 3. The proposal: 8 → 4 statements under the lock

The prototype runs 10 statements per fresh consume, 4 of them from the lock to COMMIT.

| # | Prototype statement | Replaces | Holds the account lock? |
|---:|---|---|---|
| 1–6 | unchanged | auth, steps 1–4 | |
| 7 | `with a as (select … from account_usage … for update), u as (select … from user_usage … and exists (select 1 from a) for update) select …` | 7 + 8 | **acquired here** |
| 8 | the plan join, plus `left join requests on (account_id, request_id)` | 9 + 10 | yes |
| 9 | `with acc as (update account_usage …), usr as (update user_usage …) insert into requests … returning …` (rejected: the insert alone) | 11 + 12 + 13 | yes |
| 10 | `commit` | 14 | **released** |

**Why 7 + 8 can be one statement and keep I5.** The user row's scan has `exists (select 1 from a)` in its WHERE clause. It can't produce a row until CTE `a` has produced its row, and `a` does that only after the account row is locked. So the order comes from a data dependency, not from the planner's join order. Rows locked `FOR UPDATE` in READ COMMITTED are returned at their newest committed version (Postgres re-checks them after a wait), so the usage values are as fresh as today's statements 7 and 8.

**Why 9 + 10 can be one statement and keep I3 and I4.** It is a new statement, started after the lock was granted, so it has the same fresh snapshot as today's two.

**Why not 3.** The obvious next merge, putting the recheck and the plan read into the locking statement, breaks I3 and I4. That statement's snapshot is taken when it *starts*, before it waits on the lock. Only the locked rows are re-read after the wait, so it would miss the request row and any plan change committed by the transaction it waited on. Duplicates would fall through to the unique-violation path (correct, but a full rollback), and queued consumes would be decided against the old plan. The queued-plan tests in `consume.db.test.ts` ("a plan change that commits while consumes wait on the account row") exist to catch exactly that. Getting to 3 would need the reads in a server-side function or the rules moved into SQL. Both move logic out of `evaluate()`, so I didn't prototype them.

**Why 11–13 can be one statement and keep I2 and I6.** Data-modifying CTEs run in the same statement as the insert: they all succeed, or the statement fails and the transaction rolls back. The statement returns how many rows each UPDATE touched, and the prototype throws unless both are exactly 1.

The upserts (5, 6) stay as two statements. In one statement, the order between two data-modifying CTEs isn't defined, so two first-of-the-month consumes could insert the account row and the user row in opposite orders and deadlock. They also run before the lock, so merging them wouldn't shorten the hold.

## 4. The prototype

- **Diff to `src/services/consume.service.ts`:** steps 5–10 as described above. The step numbers, step 2, step 12, `evaluate()` and the response are unchanged.
- **Diff to `tests/consume.db.test.ts`:** two lock-wait detectors match SQL text. `'insert into "requests"%'` becomes `'%insert into "requests"%'`, and `'%from "account_usage"%for update'` becomes `'%from "account_usage"%for update%'`, because the prototype's statements start with `with` and continue after `for update`. No assertion changed. Matching SQL text is brittle for any rewrite of the transaction.
- **Where it ran:** a separate copy of the working tree.

## 5. Correctness evidence for the prototype

| Property | Evidence | Result |
|---|---|---|
| Whole existing behavior | `REQUIRE_DB=1 npx vitest run` in the prototype copy: the full suite, including every consume, idempotency, plan-change, concurrency, lock-timeout, pool-timeout, restart and demo test | **34 files, 626 tests passed**, the same count as production on that day |
| Atomic accounting, no overspend | `consume.db.test.ts` "50 parallel consumes never exceed the allowance…", "…by one user…", "60 parallel consumes race at the user monthly limit: exactly 50 accepted, 10 rejected by USER"; `decision-snapshot.db.test.ts` "the accepted snapshots chain" | passed |
| Simultaneous duplicates | "20 parallel requests with the same requestId…", the step 12 tests, `consume-locking.db.test.ts` "two users of one account racing…"; the retry-storm load runs | passed |
| History and decisions consistent | `decision-snapshot.db.test.ts`: `evaluate()` on the stored inputs equals every stored decision; load check 6 on every row of every run | passed / 0 violations |
| Plans read after the lock | the two queued plan-change tests | passed |
| Failure and rollback | `consume-locking.db.test.ts` "a failure while recording the decision rolls back the increments…" (a trigger raises inside statement 9, after the UPDATE CTEs ran) and "the connection dies mid-transaction…" (`pg_terminate_backend` during statement 9); lock timeout; pool timeout | passed |
| Lock order | `consume-locking.db.test.ts` "takes the account row before the user row…": with the user row held elsewhere, the consume's account lock is visible to a third connection (`FOR UPDATE NOWAIT` → 55P03) | passed. A variant that locks the user row first fails it (`expected undefined to be '55P03'`) |
| Deadlocks | no `40P01` in any test run or load run; "two users of one account racing in opposite orders" | none seen |

`tests/consume-races.db.test.ts` was written for this change. Each of its tests ends with a ledger check: account total = sum of user totals = sum of accepted request units, every decision equals `evaluate()` on its stored inputs, and accepted decisions form one serial chain. It covers races for the last units at account and user level, simultaneous copies of one `requestId` (with the same and with different payloads), many users at once, injected failures inside a concurrent burst, and two deterministic "decided on what the lock holder committed" tests. Three deliberately broken variants of the prototype fail it: user row not locked (2 failures), totals read before the lock (7), no row locks (7).

## 6. Statement-level review

| # | Item | Result |
|---|---|---|
| 1 | Lock order inside the locking CTE | **Holds.** `EXPLAIN (VERBOSE)` with seq scans and with `enable_seqscan = off` gives the same shape: `InitPlan 2 (CTE Scan on a)` feeds a `One-Time Filter` on a `Result` node above the `user_usage` scan, under `LockRows`. The uncorrelated `EXISTS` stays an InitPlan and isn't turned into a join, so the user row isn't read or locked until `a` has locked the account row |
| 2 | Freshness after a lock wait | **Holds, and depends on `FOR UPDATE` on `u`.** Only rows locked `FOR UPDATE` are re-read at their newest committed version. With `FOR UPDATE` removed from `u`, the test "the user's own total, updated while it waited" and the user-limit race fail. **Removing that clause later would cause overspending**, so it needs a comment saying so |
| 3 | Recheck + plan read in one statement | Same semantics: a new statement after the lock, so a new snapshot. The `LEFT JOIN requests` matches at most one row and uses the unique index (2 index scans per fresh consume in every load run, as before) |
| 4 | Write CTE (increments + insert) | All or nothing. Tested: a failure in the INSERT, a failure in the `user_usage` UPDATE (the account increment is rolled back too), a backend killed mid-statement. The row-count check is stricter than the current code, which would silently increment nothing on 0 rows |
| 5 | SQL injection | Every value is a bound parameter, identifiers are constants, and there is no `sql.raw` |
| 6 | Types | `created_at` is sent as an ISO string and `updated_at` as a `Date`: the same instant, but an inconsistency to clean up |
| 7 | Error mapping | Unchanged. `isUniqueViolation(…, 'requests_account_id_request_id_unique')` and `isOverloadError` find the pg error through Drizzle's wrapper as before (step 12 tests pass) |
| 8 | Response and idempotency contract | Unchanged. The response is built from the inserted values instead of `RETURNING *`. Same fields, and replays are byte-identical |
| 9 | Timeouts | Both row-lock waits now share one statement's `statement_timeout` (4s) instead of one statement each. Worst-case wait drops from 3s + 3s to 4s, and both outcomes map to 503 |
| 10 | Type safety | Two statements are hand-written SQL, so TypeScript doesn't check their table and column names. At integration they should be built from the schema objects (`${accountUsage}`, `sql.identifier(accountUsage.unitsUsed.name)`), so a rename fails to compile |

## 7. Benchmark and trade-offs

Method, environment, raw files and per-run numbers are in [LOAD_TEST.md](LOAD_TEST.md) §9. Two images that differ only in this change, one database, 5 ABBA rounds of 4 scenarios at 50 VUs × 30s, analyzed pair by pair. The host suspended twice during the runs and was short of memory, so I rely on the paired ratios, not absolute numbers:

| Scenario | Valid pairs | Prototype faster | Geometric mean RPS ratio | Median p95 ratio |
|---|---:|---:|---:|---:|
| hot account | 5 | 5/5 | **1.423 (+42.3%)** | 0.704 |
| mixed (equal rejected share, 46%) | 4 | 4/4 | 1.562 (+56.2%) | 0.706 |
| many accounts | 4 | 4/4 | 1.197 (+19.7%) | 0.907 |
| retry storm | 5 | 5/5 | 1.198 (+19.8%) | 0.884 |

0 invariant violations (checks 1–4 and 6) in all 42 runs.

**Costs:**
- **Two statements become hand-written SQL** (``tx.execute(sql`…`)``): the locking CTE and the write CTE. Drizzle no longer type-checks those column names, and the result row types are declared by hand. The integration tests catch mistakes there, not the compiler.
- **The lock order inside one statement rests on a data dependency** (`exists (select 1 from a)`), not on statement order. It's sound (§3) and a test fails when the order is reversed, but it's harder to explain and review than two separate `SELECT … FOR UPDATE`s.
- **Two test helpers that match SQL text need widening**, as in the patch.
- **The docs describe steps 5–10 as separate statements.** The order and semantics don't change, but PLAN.md §6 Phase 3 and the README would need to say that steps 5, 6+7 and 9+10 each run as one statement.
- **Not addressed:** duplicates still queue on the account row (retry storm), and one account is still serialized. This is a constant-factor gain, not a change in how the design scales.

**My recommendation is to integrate it.** The gain on the case that bounds the design (one busy account) is large and consistent in every pair, every existing correctness test passes with unchanged assertions, and the new lock-order and failure tests cover what the change could break. Integrating means: apply the patch, update the step descriptions in PLAN.md §6 and the README, add the `FOR UPDATE` warning from §6 item 2, then rerun the suite and `load/ab.sh` once on the committed tree. Nothing is integrated yet.
