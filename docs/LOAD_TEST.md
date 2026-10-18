# Load Test: Phase 6 Baseline

Baseline only. Nothing in `src/` was changed and no setting was tuned: the API, its pool and PostgreSQL run exactly as `docker compose up --build` starts them. The "one improvement, re-run, compare" item in docs/PLAN.md Phase 6 is **not done yet**. Section 6 lists the candidates.

**Where the numbers come from.** Every number below comes from one of these saved files in `load/results/`, or is arithmetic on them shown inline:

| Run | Produced by | Files |
|---|---|---|
| hot account, 50 VUs | `load/run.sh hot-account` | `hot-account-e4ff949a-*` |
| many accounts, 50 VUs | `load/run.sh many-accounts` | `many-accounts-6d1621bb-*` |
| retry storm, 50 VUs | `load/run.sh retry-storm` | `retry-storm-6d0745d1-*` |
| stress probe: hot account, 200 VUs, 20s | `VUS=200 DURATION=20s load/run.sh hot-account` | `hot-account-c2df73fc-*` |
| uncontended timings | `load/uncontended.sh` | `uncontended-a08fa988.txt` |

Each `run.sh` run saves `-env.txt` (host, versions, settings), `-k6.txt`, `-pg.txt` (pg_stat_activity samples), `-cpu.txt`, `-idx.txt`/`-idx-delta.txt` (index scan counters), `-sql.txt` (invariants), `-api.log`, and `-run.txt` (the full console output, including the summaries quoted below).

## 1. Setup

| | |
|---|---|
| Load generator | k6 via the official image `grafana/k6:1.3.0` (`-env.txt`: `k6_image`), Compose service `k6` under profile `load` |
| API | One Node process (`api_node v22.23.3`), Express 5, Drizzle, `pg`, as built by the repo's Dockerfile |
| Pool | Set explicitly in `createPool()` in `src/db/client.ts`: `connectionTimeoutMillis` 2s (in pg-pool this also limits the wait for a free connection), `query_timeout` 5s (client side), `statement_timeout` 4s and `lock_timeout` 3s (server side), `idle_in_transaction_session_timeout` 10s. `max` isn't set, so it's pg's default of **10 connections**. |
| Database | `postgres:16` (`pg_server_version 16.15`), image defaults: `max_connections` 100, `shared_buffers` 128MB, `synchronous_commit` on, `fsync` on, `wal_sync_method` fdatasync |
| Host | One Linux machine shared by k6, the API and the DB: `host_cpus 12`, `host_mem_total_mib 7625`, `host_swap_used_mib` ~1700 at run start, Docker 29.9.0, Compose 5.6.0 |
| Run shape | `constant-vus`, **50 VUs, 30s**, no think time: each VU sends its next request as soon as the last one is answered. Wall time per run, including container start, setup and teardown: 34s, 36s and 34s for the three scenarios (`k6 wall time` in `-run.txt`). |

k6 `setup()` creates every account and user through the public API only: `POST /accounts` → `POST /plans` (one ACCOUNT and one USER plan) → `PUT /account/plan` → `POST /users`. Both custom plans allow **2,000,000,000 units/month and 1,000/request** (`load/lib.js`), so every request takes the accepted path: both increments plus the request insert.

Each run gets a random hex run ID, and its accounts are named `load-<scenario>-<run_id>-<n>`. The per-run SQL checks select the run's accounts by an exact match on that run-ID field.

### Scenarios

| Script | What it does |
|---|---|
| `load/hot-account.js` | **1 account, 200 users.** Each iteration picks a random user and consumes 1–5 units under a new `requestId`. Every consume locks the same `account_usage` row. |
| `load/many-accounts.js` | **100 accounts × 5 users.** Same request mix, spread over random accounts. |
| `load/retry-storm.js` | **1 account, 50 users, 5,000 `requestId`s.** Each iteration picks a random key and sends the **same request 3 times at once** (`http.batch`). A key always maps to the same user and units, so a correct service never answers 409. |

### Metrics

Only `POST /consume` is measured (tag `name:consume`); setup requests are excluded.

- **RPS** = consume requests / run duration.
- **p50/p95/p99** = `http_req_duration{name:consume}`, the full HTTP round trip as k6 sees it.
- **Error rate** = non-200 consume responses / all consume responses. A `REJECTED` decision is HTTP 200, so it is not an error. Rejections, replays and fresh decisions are counted separately.

## 2. Reproduce

From the repo root. `run.sh` needs bash, Docker with Compose v2, `jq` and `od`.

```sh
docker compose up -d --build --wait db api       # build and start the API + DB
load/run.sh hot-account
load/run.sh many-accounts
load/run.sh retry-storm
VUS=200 DURATION=20s load/run.sh hot-account     # the stress probe
load/uncontended.sh                              # single-request timings (§4)
```

`load/run.sh <scenario>` does the following, and prints and saves everything to `load/results/<scenario>-<run_id>-*`:

1. Records the environment.
2. Snapshots index scan counters (`load/index-scans.sql`).
3. Samples `pg_stat_activity` every 0.5s (`load/sample-activity.sql` under `\watch`) and container CPU (`docker stats`) in the background.
4. Runs `docker compose --profile load run --rm k6 run -q -e RUN_ID=<run_id> /scripts/<scenario>.js`.
5. Stops the samplers. An EXIT trap stops them even when k6 fails.
6. Waits 11s, so idle backends flush their statistics, then snapshots the counters again.
7. Runs `load/check-invariants.sql`.
8. Saves the API log for the run window and prints the summaries.

It finds the containers through `docker compose ps`, and fails if no samples were captured or if `docker compose logs` fails.

To run k6 alone: `docker compose --profile load run --rm k6 run /scripts/hot-account.js`. Every scenario reads `VUS`, `DURATION`, `BASE_URL` and `RUN_ID` (`-e NAME=value`). Scenario knobs: `USERS`, `ACCOUNTS` (many-accounts), `KEYS` and `BURST` (retry-storm).

## 3. Results

50 VUs, 30s, 2026-10-18 (`started_utc` in `-env.txt`). One run per scenario with the final scripts.

| Scenario | Run ID | Consumes | RPS | p50 | p95 | p99 | Error rate (non-200) | Accepted | Rejected | Fresh / Replayed |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| hot account | e4ff949a | 2,556 | **85.2** | 593.2 ms | 686.8 ms | 731.4 ms | 0.00% (0) | 2,556 | 0 | 2,556 / 0 |
| many accounts | 6d1621bb | 5,032 | **167.7** | 284.8 ms | 417.0 ms | 485.7 ms | 0.00% (0) | 5,032 | 0 | 5,032 / 0 |
| retry storm | 6d0745d1 | 4,647 | **154.9** | 1,023.1 ms | 1,170.3 ms | 1,221.9 ms | 0.00% (0) | 4,647 | 0 | 1,339 / 3,308 |

- **No errors:** no non-200 response, no 409 in the retry storm, and no API log lines during these runs (`log lines: 0` in `-run.txt`).
- **No rejections:** the allowances are large by design. In the retry storm, "accepted" includes the replays, because a replay returns the stored ACCEPTED decision.
- **Latency is mostly queueing:** 50 VUs share 10 connections. By Little's law, p50 ≈ VUs / RPS: 50 / 85.2 = 587 ms (measured 593.2), and 50 / 167.7 = 298 ms (measured 284.8).

### Invariants (`load/check-invariants.sql`, after every run; all 0 in all four `-sql.txt` files)

| Check | Scope | Result |
|---|---|---|
| 1. `account_usage.units_used` = sum of that account's `user_usage.units_used` (full outer join, so a row missing on either side counts) | every account and month | 0 violations |
| 2. No account's usage exceeds its plan's `monthly_limit` | every account, **current UTC month** | 0 violations |
| 3. No user's usage exceeds the user plan's `monthly_limit` | every user, **current UTC month** | 0 violations |
| 4. `account_usage.units_used` = sum of `units` of the account's ACCEPTED request rows (a replay counted twice would break this) | every account and month | 0 violations |
| 5. This run's request rows, accepted units, account usage and user usage | this run's accounts (run ID match) | accepted units = account usage = user usage: 7,682 / 15,079 / 3,952 |
| k6 fresh (`replayed: false`) responses = this run's request rows | this run (run ID match) | equal: 2,556 / 5,032 / 1,339 |

Checks 2 and 3 cover the current month only, because a limit applies to the month being consumed. Only the current plan assignment is stored, so a past month can't be checked against the plan that applied then.

## 4. Bottleneck

### pg_stat_activity samples

Averages over the 0.5s samples taken while the API had traffic ("busy samples"), from the `-run.txt` summaries:

| Scenario | Busy samples (with a lock waiter) | Conns | Running | **Waiting on a lock** | Idle in transaction | Idle |
|---|---:|---:|---:|---:|---:|---:|
| hot account | 61 (61) | 10.00 | 0.54 | **8.25** (max 9) | 1.08 | 0.13 |
| many accounts | 63 (9) | 9.83 | 1.02 | 0.16 (max 2) | **6.05** | 2.60 |
| retry storm | 61 (61) | 10.00 | 0.59 | **8.00** (max 9) | 0.89 | 0.52 |

Here are the lock waits, quoted exactly from the samples: number of samples · wait events · the waiting queries.

**Hot account** (61 samples with a waiter):
- 58 · `transactionid+tuple` · `select "units_used" from "account_usage" where ("account_usage"."account_id" = $1 and "account_usage"."month" = $2) for update`
- 2 · `transactionid+tuple` · that same `for update`, plus `insert into "user_usage" (…) values ($1, $2, $3, $4, $5) on conflict do nothing`
- 1 · `tuple` · that same `for update`

**Many accounts** (9 samples with a waiter):
- 8 · `transactionid` · the `for update` on `account_usage`
- 1 · `transactionid` · the `for update`, plus `insert into "account_usage" (…) on conflict do nothing`

**Retry storm** (61 samples with a waiter):
- 56 · `transactionid+tuple` · the `for update` on `account_usage`
- 2 · `tuple` · the `for update`
- 2 · `transactionid+tuple` · the `for update`, plus the `user_usage` upsert
- 1 · `transactionid+tuple` · the `for update`, plus the `account_usage` upsert

### Hot account: the account usage row lock serializes the account

In every busy sample, connections wait on a lock. On average 8.25 of the 10 wait, and every waiting query in every sample includes the `SELECT … FROM account_usage … FOR UPDATE` of consume step 5. In a few samples, an `INSERT … ON CONFLICT DO NOTHING` into a usage table (step 4) also waits on a row another transaction is inserting. So only one consume per account runs from step 5 to COMMIT at a time.

**Lock hold time, measured as 1 / throughput:** 1 / 85.2 req/s = **11.7 ms** between two decisions on the account. This interval is more than the holder's own statements. It also includes:
- the lock hand-off: Postgres waking the next waiter after COMMIT;
- event-loop delay in the API: the holder's next statement waits its turn in the single Node event loop, and so does a waiter whose `FOR UPDATE` has returned;
- the WAL flush at COMMIT.

The samples fit this picture. Among the connections not waiting on the lock, more are `idle in transaction` (1.08, waiting for the API to send the next statement) than running (0.54).

**Where the 11.7 ms goes: an estimate, not a measurement.** From `uncontended-a08fa988.txt`:

| | Mean |
|---|---:|
| `POST /consume` fresh, from inside the API container | 19.21 ms |
| `POST /consume` replay (auth, user lookup, fast path; no transaction) | 5.57 ms |
| → transaction as the API sees it (fresh − replay) | ≈ 13.6 ms |
| DB side of the statements after the lock, timed in psql (lock user row 0.174, recheck 0.187, plan join 0.663, two increments 0.282 + 0.221, request insert 0.533) | ≈ 2.1 ms |
| WAL flush per COMMIT (`pg_test_fsync`, fdatasync, one 8kB write) | 0.76 ms |

On that basis, roughly 2.8 ms of the 11.7 ms is database work. The remaining ~9 ms is the API's per-statement cost (query building, driver, event loop) and the hand-off. This split is an estimate for three reasons:
- psql runs literal SQL over its own connection, not the API's parameterized statements;
- the API's per-statement cost can't be measured without instrumenting `src/`;
- under load, the event-loop delay is larger than in the sequential measurement.

The uncontended baselines: a raw `select 1` round trip on `pg` takes 0.18 ms, `GET /healthz` 2.76 ms, and `GET /usage` 5.75 ms.

**Why one account behaves differently from many accounts:** on 100 accounts, the same 10 connections wait on a lock in only 9 of 63 samples (0.16 on average), and throughput is 167.7 vs 85.2 req/s. The limit moves elsewhere.

### Many accounts: the single Node process

Without lock contention, the connections are mostly **`idle in transaction`**: 6.05 of 9.83 on average. Postgres has finished the previous statement and is waiting for the API to send the next one. Another 2.60 are `idle`. A connection the pool has handed to a waiting request still shows as idle until the event loop runs the callback that sends the query. Container CPU (`-cpu.txt`, 18 samples, 100% = one core):
- API: average 107%, max 168%. One Node process runs JavaScript on one core; the rest is GC and libuv threads.
- DB: average 114%, max 153%, out of 12 cores.

The API is the limit here, not the database or the pool.

### Retry storm: duplicates queue on the hot row too, and the fast path carries the rest

The split between the paths is measured from the `requests_account_id_request_id_unique` index scan counter (`-idx-delta.txt`):
- every consume does one fast-path lookup on that index (step 2);
- every consume transaction does one more, the recheck (step 6).

So transactions = scans − consumes. The hot-account run calibrates this model: 5,112 scans = 2 × 2,556 consumes, all of them fresh. For the retry storm:

| | Count | Per second (÷ 30) |
|---|---:|---:|
| consumes | 4,647 | 154.9 |
| request-index scans | 8,663 | |
| consume transactions = 8,663 − 4,647 | 4,016 | 133.9 |
| … fresh decisions (k6 `fresh`) | 1,339 | 44.6 |
| … replays answered inside a transaction, at the recheck = 4,016 − 1,339 | 2,677 | 89.2 |
| fast-path replays, no transaction = 4,647 − 4,016 | 631 | 21.0 |

Cross-check: 4,647 / 3 = 1,549 bursts, of which 1,339 used a new key. In a burst with a new key, the 3 copies arrive together and all miss the fast path, so up to 2 × 1,339 = 2,678 copies replay inside a transaction (2,677 measured). The other 210 bursts repeated a decided key: 630 fast-path replays, against 631 measured. One copy of a new-key burst arrived after its decision had committed.

**Throughput.** All three paths add up to the 154.9 req/s: 44.6 fresh, 89.2 in-transaction replays and 21.0 fast-path replays. The account row is the bottleneck for the 133.9 transactions/s. Every in-transaction replay queues behind the account lock (8.00 of 10 connections wait, the same profile as hot account) to learn that its request was already decided. The 21.0 fast-path replays/s don't touch the lock. They are cheap, but they still pass through the same 10 connections and the same event loop, so they also wait behind the transactions for a connection.

Why does the account row handle more transactions/s here than in hot account (133.9 vs 85.2)? An in-transaction replay stops at the recheck, so after locking the account row it makes 3 round trips instead of 7: lock user row, recheck, commit. Estimate: if each fresh decision takes 11.7 ms, the 1,339 fresh decisions use 15.7 s of the 30 s. That leaves 14.3 s / 2,677 ≈ 5.3 ms per in-transaction replay, close to 11.7 × 3/7 = 5.0 ms. Fresh decisions/s fall to 44.6, about half of hot account, because the duplicates take the other half of the lock's time.

Idempotency held under this race: zero 409s, and fresh decisions = request rows (1,339).

### Stress probe: hot account at 200 VUs (`hot-account-c2df73fc`)

| Consumes | RPS | p50 | p95 | p99 | max | Errors |
|---:|---:|---:|---:|---:|---:|---:|
| 1,902 | 95.1 | 2,305.5 ms | 2,507.5 ms | 2,546.2 ms | 2,604 ms | **8 (0.42%)** |

- **Throughput barely moves** (95.1 vs 85.2 at 50 VUs). The lock profile is the same: 8.18 of 9.93 connections waiting on average, and the waiting query is again the `for update` on `account_usage`.
- **Latency grows with the queue:** by Little's law, 200 / 95.1 = 2.10 s.
- **The pool timeout is where this starts to fail.** All 8 errors in `-api.log` are pg-pool's `Error: timeout exceeded when trying to connect`: a request waited more than `connectionTimeoutMillis` (2s) for a free connection. Drizzle wrapped 5 of them as `Failed query`, on the auth lookup (`select "id" from "accounts" where "accounts"."api_key_hash" = $1`, 4 times) and on the user lookup (1 time). The client got a 500.
- **Nothing was decided twice or lost:** fresh responses = request rows (1,894), and all invariants hold.
- **The index-scan split isn't valid for this run.** The failed requests stopped before their fast-path scan, so `run.sh` flags it.

## 5. Summary

- **Hot account (85.2 req/s):** bounded by the `account_usage` row lock. Decisions are 11.7 ms apart (1 / throughput), which includes the holder's 7 round trips, the lock hand-off and event-loop delay.
- **Many accounts (167.7 req/s):** bounded by the single Node process (API CPU average 107% of one core), with DB connections idle in transaction waiting for it.
- **Retry storm (154.9 req/s, 44.6 decisions/s):** two thirds of the account-row transactions (2,677 of 4,016) are duplicates that replay at the recheck. Fast-path replays (21.0/s) skip the lock.
- **At 4× the VUs:** hot-account throughput stays flat, and requests start failing on the 2s pool wait timeout.
- **Correctness:** every invariant and the fresh = rows check held in every run.

## 6. Proposed improvements (not implemented)

Effects are estimates derived from the measurements above.

1. **Fewer round trips while the account row is locked.** Run the step 6 recheck and the step 7 plan join as one query. Run the two increments and the request insert (steps 9–10) as one CTE statement. The step order and semantics stay the same. This cuts the round trips after the lock from 7 to 4. **Expected effect:** the retry storm suggests lock time scales with round trips (≈ 5.3 ms for 3 vs 11.7 ms for 7). If that holds, hold time drops to about 11.7 × 4/7 ≈ 6.7 ms, so **hot account goes from ~85 to ~150 decisions/s**. Many accounts would gain less: the API does fewer statements per request, but stays CPU-bound. *This changes how the locked transaction steps are executed (PLAN.md §6 Phase 3), so it needs your sign-off.*
2. **Take concurrent duplicates off the hot row.** Before locking the account row, take `pg_advisory_xact_lock(hashtext(account_id || requestId))`. Copies of the same `requestId` then wait on their own lock, and after the first copy commits, the recheck answers them. The unique constraint and the recheck remain the real guarantee. **Expected effect:** in this retry storm, the 2,677 in-transaction replays (≈ 14.3 s of the 30 s of account-lock time) leave the account row. Account-row transactions drop from 4,016 to the 1,339 decisions, and **decisions/s can rise from 44.6 towards the hot-account rate (85.2)**. The cost is one extra round trip per fresh consume, outside the account lock. *This adds a step to the locked transaction order, so it needs your sign-off.*
3. **Run more API processes, not a bigger pool.** Use `node:cluster` or several replicas, keeping the total connections well under `max_connections`. In many accounts the API is the limit (107% of one core; connections idle in transaction for 6.05 of 9.83), so a larger pool alone would only lengthen the queue inside one busy process. In hot account, more connections would only add lock waiters. **Expected effect:** many-accounts throughput rises with the number of processes until the database or the shared host CPU becomes the limit. These runs didn't measure that ceiling, so there's no number. Hot account doesn't gain, because it stays lock-bound. More total pool capacity would push back the pool wait timeout seen in the 200-VU probe.

## 7. Not verified

- **None of the §6 effects was implemented or measured.** They are the arithmetic shown, under the stated assumptions.
- **The split of the 11.7 ms lock hold is an estimate** (see §4). The API's per-statement cost can't be measured without instrumenting `src/`.
- **The retry-storm path split assumes no other traffic during the run.** The index counter counts every scan. The cross-check against the burst arithmetic agrees to within 1.
- **Monthly-limit enforcement under load is only weakly exercised.** Checks 2 and 3 pass, but with 2,000,000,000-unit allowances no run came near a limit, by design. The Phase 3 test "50 parallel consumes never exceed the allowance" remains the evidence for that.
- **Rejected-path latency wasn't measured:** there were no rejections.
- **The API's pool wait time wasn't measured directly.** It is inferred from Little's law, from all 10 connections being busy, and in the probe from the pool timeout errors.
- **Run-to-run variation wasn't measured.** Each scenario ran once with the final scripts. The host also runs other processes (editors, other containers), its load wasn't recorded, and k6 shares its CPU with the API and the DB. Treat the absolute numbers as specific to this host.
- **CPU figures are coarse.** `docker stats` samples are ~2s apart (13–18 per run) and include a few samples from k6 setup and teardown.
- **The DB-side statement timings are an approximation.** They come from psql with literal values inside a rolled-back transaction, and COMMIT's cost is taken from `pg_test_fsync`.
- **Leftover rows:** `load/uncontended.sh` and every load run leave their accounts in the Compose DB volume, and all of them pass the invariants. `docker compose down -v` removes them.
