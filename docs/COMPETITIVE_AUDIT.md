# Competitive Audit

| | |
|---|---|
| Date | 2026-10-22 |
| Our state | `6d8a338` plus this session's uncommitted changes ([ENGINEERING_AUDIT.md](ENGINEERING_AUDIT.md) §5) |
| Method | Shallow clones (`--depth 50`) read in a scratch directory. **No competitor code, test suite or benchmark was executed**, so every competitor row below is code reading or their own documents. Nothing was copied |
| Scope read | Each repository's consume path, auth, schema/migrations, CI workflow, test inventory and performance evidence. Tests were counted and their names read; not every test body was read |

Evidence labels: **V** = implemented and verified by running it (only possible for our project here) · **I** = implemented, seen in code, not run · **D** = documented only (README or results file, not traced to code) · **M** = missing · **–** = not inspected.

## 1. Repositories

| # | Repository | HEAD read | Size and shape |
|---|---|---|---|
| 1 | engbaraakhamaysa/usage-metering-service | `b4c1090` (2026-10-22 13:20 +03:00) | Express + Drizzle, 10 migrations; a large React/shadcn client; 83 Jasmine API specs (`spec/`); k6 scripts and JSON results under `performance/` |
| 2 | naila-saleh/usage-metering-service | `bbed24b` (2026-10-22 13:40 +03:00) | One Express file (`src/index.ts`, 448 lines) plus one service; 6 migrations; 23 Vitest tests in 4 files; `performance-results.md` |
| 3 | raghadjam/UsageMeteringQuotaService | `c213116` (2026-10-19) | Express + raw SQL; two consume strategies; 34 tests; k6 results as CSV; CI |
| 4 | baraafanah21/Usage-Metering-Quota-Service | `5da4324` (2026-10-17) | `api/` + `demo-app/`; repositories/services layers; metrics; ~20 test files incl. `test/concurrency/`; CI; raw load results |
| 5 | basmalasamaneh/usage-metering-service | `13ab995` (2026-10-16) | `service/` + `client/` + `loadtest/`; per-account group commit; 84 tests; CI |

Commit dates after the brief's deadline (20/10/2026) are noted, not judged: our own changes in this session are also after it.

## 2. Findings per competitor

### #1 engbaraakhamaysa
- **Concurrency [I]:** `consumeUsageTransaction()` (`src/modules/usage/repositories/usage-consumption.repository.ts`) locks the `accounts` row `FOR UPDATE`, then checks idempotency inside the lock, then reads both plans and both usage rows. A correct serialization point per account, structurally like ours.
- **Rule order [I]:** account per-request → account monthly → user per-request → user monthly. That's a different but legitimate product choice.
- **History [I]:** `usage_records` store the status and the rejection reason, but neither plan's limits nor the plan IDs.
- **Auth [I]:** SHA-256 of a hex key. The key has no prefix and no format check, and every lookup error is a generic 500 in the middleware.
- **Deliverables [I]:** **no `docker-compose.yml` and no Dockerfile in the repository**, and no root README (only `client/README.md` and `performance/README.md`). The brief requires both.
- **CI [I]:** `client-checks.yml` only restricts which paths a PR from the `client` branch may touch. It doesn't build or test.
- **Performance [D]:** `performance/README.md` lists a machine (i7-1065G7, PostgreSQL 18.6, k6 2.3.0 via Snap), 10 s runs, single- and multi-account at 10/50 VUs, and three repeated runs for the "current" round. For example, `current-single-account-50vus-run1.json`: 139.7 req/s, p95 394.9 ms, 0 failures. The method is explained, with raw JSON. There is no invariant check after the runs.

### #2 naila-saleh
- **Concurrency [I]:** `consumeUsage()` (`src/services/usage-service.ts`) locks the account row (`for('update', { of: accounts })`), then the user row, then recomputes monthly usage as `SUM(amount)` over the history table. That's correct under the account lock, but its cost grows with history.
- **Idempotency defect [I]:** a stored request is compared on `amount` only. The same `requestId` with a different `userId` and the same `amount` returns the other user's stored decision instead of a conflict.
- **Rejections [I]:** they are HTTP errors (403 with `Error` messages), not a decision object naming the rule's owner.
- **Isolation risk [I]:** `users.email` is `UNIQUE` across all accounts. Registering an email that another account already uses fails, which leaks that it exists elsewhere.
- **Pagination [I]:** history uses offset pagination.
- **Docs and Compose [I]:** **no README.** Compose has `db`, `api` and a `demo` container that runs a CLI demo.
- **CI:** none.
- **Performance [D]:** `performance-results.md` reports 5 runs of one 100-request concurrent batch (avg 159 req/s). It says itself that no raw logs were kept and that the numbers are not a capacity benchmark.

### #3 raghadjam
- **Concurrency [I]:** a `locking` strategy, and a `conditional` one: `UPDATE … WHERE used + units <= allowance` inside a SAVEPOINT, falling back to locking when it fails.
- **Performance [D]:** their own CSV (`loadtest/results/perf-locking-vs-conditional.csv`) shows no consistent winner. At 50 VUs / 10 accounts: locking 507–652 req/s vs conditional 556–633 req/s, with HTTP errors in both.
- **Tests and CI:** 34 tests; a CI workflow exists.

### #4 baraafanah21
- **Concurrency [I]:** one CTE statement upserts and locks the account row, then the user row. The order is forced by a data dependency, and `test/concurrency/lockOrder.test.ts` checks it. One retry on deadlock; a `23505` on the ledger replays the winner.
- **Snapshot read:** the CTE uses `ON CONFLICT DO UPDATE` (a no-op update) to take the lock. Every consume therefore writes an extra row version.
- **Round trips [I]:** 3 under the lock. Per-request rejections are decided before taking the lock.
- **History [I]:** the ledger stores the plan *versions* and the full response body (jsonb), so past decisions stay explainable after edits.
- **Auth [I]:** a regex shape check before the lookup, a display prefix, and a separate `api_keys` table (the code comments mention revoked keys). Account creation sits behind an operator `X-Admin-Key` and returns `Cache-Control: no-store`.
- **Ops [I]:** Prometheus-style metrics, a request logger, CI.

### #5 basmalasamaneh
- **Concurrency [I]:** a per-account group commit (`service/src/accounting/coordinator.ts`). At most one transaction per account is in flight per process, and queued requests are decided together in one transaction. When a batch fails, its requests are retried one at a time. The DB row lock remains the correctness guarantee.
- **Context read [I]:** after the lock, a single statement reads everything the decision needs.
- **Performance [D]:** `docs/PERFORMANCE.md`: hot account ~270–360 req/s unbatched, thousands batched. They ran an A/B/A/B check to separate machine drift from a code change.
- **Tests and CI:** 84 tests; CI runs typecheck and tests against Postgres.

## 3. Comparison matrix

| Dimension | Ours | #1 | #2 | #3 | #4 | #5 |
|---|---|---|---|---|---|---|
| Requirement coverage | V ([REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md)) | I, **no Compose/Dockerfile, no README** | I, **no README** | I | I | I |
| Account/user isolation | V (`isolation.db.test.ts`, composite FKs) | I | I, **global unique email** | I | I | I |
| Account and user plans together | V | I | I | I | I | I |
| Custom plans, live changes | V (incl. queued-behind-lock tests) | I | I | – | I | I |
| Atomic accounting | V | I | I | I | I | I |
| Concurrent correctness | V (50/60-way races, chained snapshots) | I (specs in `consumption-concurrency/`) | I (one 10-request test) | I | I (`test/concurrency/`) | I |
| Idempotency, safe retries | V (concurrent duplicates, step 12, month boundary) | I | I, **userId not compared** | I | I | I |
| History explainable after plan edits | V (snapshot, re-derived by `evaluate()`; pre-0001 rows null) | M (no limits, no plan IDs) | M | – | I (plan version + body) | I (snapshot column) |
| History pagination | V (keyset) | I | I (offset) | – | I (keyset) | – |
| API-key handling | V (SHA-256, format check, `no-store`) | I (SHA-256, no format check) | I (SHA-256) | – | I (+ revocation table, admin key) | I (SHA-256, prefix) |
| Key revocation/rotation | M | M | M | – | I | – |
| Lock order tested | V (observed from a third session, red-checked) | – | M | – | I | – |
| DB failure mid-transaction tested | V (trigger fault, terminated backend) | – | M | – | I (`dbDown.test.ts`, name only) | – |
| CI | I (added, not yet run on GitHub) | M (path filter only) | M | I | I | I |
| Performance evidence | V (raw files, invariants after every run, A/B alternating) | D (raw JSON, repeats) | D (no raw data) | D (CSV) | D (raw) | D (A/B/A/B) |
| Compose + example client | V (§6 of ENGINEERING_AUDIT) | **M** | I | I | I | I |
| README for evaluation | V | M | M | I | I | I |

**Performance numbers are not compared across repositories.** The competitors used other machines, other load tools and other workloads; #2 even measured a single 100-request batch. Only our own A/B runs on one machine ([LOAD_TEST.md](LOAD_TEST.md) §11) support a before/after claim.

## 4. Ideas adopted, deferred or rejected

| Idea | Seen in | Decision | Where |
|---|---|---|---|
| Snapshot the applied limits on each decision | #4 (plan version), #5 | **Adopted, our own form:** the exact `evaluate()` inputs, so a decision can be re-derived, not just labeled | ENG-01 |
| `Cache-Control: no-store` on the key response | #4 | **Adopted** | ENG-02 |
| Key shape check before the lookup | #4 | **Adopted**, keeping our 401 contract | ENG-03 |
| CI with a real Postgres service | #3, #4, #5 | **Adopted**, plus a Compose smoke job none of them has | ENG-04 |
| Fewer round trips under the lock; data-dependent lock order in one statement | #4, #5 | **Prototyped and measured, not integrated** (owner's decision). Lock taken with `FOR UPDATE`, not a no-op `ON CONFLICT DO UPDATE`, so there is no extra row version per consume | [CONSUME_ROUND_TRIPS.md](CONSUME_ROUND_TRIPS.md) |
| A/B alternation to control machine drift | #5 | **Adopted** in `load/ab.sh` (ABBA) | LOAD_TEST §11 |
| Per-request rejection before the lock | #4 | **Deferred:** it only helps oversized requests, and it reads plans before the lock, which our queued-plan tests forbid by design | — |
| Group commit | #5 | **Rejected for now:** large complexity and new failure modes (batch fan-out). Reconsider only if the measured round-trip change isn't enough | — |
| Operator key for account creation | #4 | **Rejected:** unauthenticated creation is a locked PLAN.md decision | ENG-08 |
| Key revocation table | #4 | **Deferred:** not required by the brief; a proposal is in ENG-07 | ENG-07 |
| Conditional `UPDATE … WHERE used + n <= limit` | #3 | **Rejected:** their own data shows no consistent gain, and it moves rules out of `evaluate()` | — |

## 5. Where this project is weaker, honestly

- **Hot-account throughput.** Our single-account decision rate (~85–108 req/s on this host, LOAD_TEST §3, §10) reflects an 8-statement lock hold. #4 and #5 hold their lock for fewer statements. The prototype addresses this, pending a decision.
- **No key revocation** (#4 has it).
- **No metrics endpoint** (#4 has one). It isn't required by the brief.

## 6. Limits of this audit

- No competitor was run, so "I" means "the code says so", not "it works".
- Test bodies were not read in full. Test counts come from `it(`/`test(` occurrences.
- Repositories may have changed after the HEADs listed in §1.
