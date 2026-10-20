# Load Test: Phase 6

Sections 1–7 are the baseline, kept as measured: one API process, nothing tuned, exactly as `docker compose up --build` started it before `WORKERS` existed. Section 6 lists the candidate improvements. Section 8 implements one of them, several API processes with `node:cluster` (§6 item 3), and compares it with the baseline in the same session. Section 9 records one later check run on the code after the F10 input fix (`docs/TEST_PLAN.md` TP-LOAD-04). Its numbers come from `load/run.sh hot-account` run `hot-account-84e77ce8-*`, and its comparison table also quotes `hot-account-bc7adbf3-*` and the runs listed below. It changes nothing in §1–§8.

**Where the numbers come from.** Every number below comes from one of these saved files in `load/results/`, or is arithmetic on them shown inline. The files of every run in §1–§8 are committed. The three §9 runs are not: at commit `9880430` their 33 files are untracked, so they exist only in the developer's working copy and a clone of the repository doesn't have them.

| Run | Produced by | Files |
|---|---|---|
| hot account, 50 VUs | `load/run.sh hot-account` | `hot-account-e4ff949a-*` |
| many accounts, 50 VUs | `load/run.sh many-accounts` | `many-accounts-6d1621bb-*` |
| retry storm, 50 VUs | `load/run.sh retry-storm` | `retry-storm-6d0745d1-*` |
| stress probe: hot account, 200 VUs, 20s | `VUS=200 DURATION=20s load/run.sh hot-account` | `hot-account-c2df73fc-*` |
| uncontended timings | `load/uncontended.sh` | `uncontended-a08fa988.txt` |
| §8 comparison: WORKERS=1 vs 4, 14 runs | `load/compare.sh` | `compare-b94e9fcc.txt` (index, medians), the 14 run IDs it lists, `compare-b94e9fcc-host.txt` |
| §8 replication: the same 14 runs, second session | `load/compare.sh` | `compare-66ef619b.txt` (index, medians) and the 14 run IDs it lists |
| §8 extra stress probe, WORKERS=1 | `VUS=200 DURATION=20s load/run.sh hot-account` | `hot-account-fc0db82b-*` |
| §9 post-fix check, hot account, 50 VUs | `load/run.sh hot-account` | `hot-account-84e77ce8-*` (untracked) |
| §9 comparison rows, 2026-10-19 | `load/run.sh hot-account`, `load/run.sh many-accounts` | `hot-account-bc7adbf3-*`, `many-accounts-06e6a282-*` (untracked) |

Each `run.sh` run saves `-env.txt` (host, versions, settings), `-k6.txt`, `-pg.txt` (pg_stat_activity samples), `-cpu.txt`, `-idx.txt`/`-idx-delta.txt` (index scan counters), `-sql.txt` (invariants), `-api.log`, and `-run.txt` (the full console output, including the summaries quoted below).

Two things in these files look like failures but aren't. The `FATAL: terminating connection due to administrator command` line in `-pg.err` is the sampler being stopped at the end of the run (`pg_terminate_backend`). The stack traces in the 200-VU runs' `-api.log` files are the expected pool timeouts (§4 and §8 stress probes).

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

From the repo root. `run.sh` needs bash, Docker with Compose v2, `jq` and `od`, on a Linux host: it records host CPU and memory with `nproc` and `free`, and `uncontended.sh` uses `nproc`.

```sh
docker compose up -d --build --wait db api       # build and start the API + DB
load/run.sh hot-account
load/run.sh many-accounts
load/run.sh retry-storm
VUS=200 DURATION=20s load/run.sh hot-account     # the stress probe
load/uncontended.sh                              # single-request timings (§4)
load/compare.sh                                  # WORKERS=1 vs WORKERS=4, alternating (§8)
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
- **The pool timeout is where this starts to fail.** All 8 errors in `-api.log` are pg-pool's `Error: timeout exceeded when trying to connect`: a request waited more than `connectionTimeoutMillis` (2s) for a free connection. Drizzle wrapped 5 of them as `Failed query`, on the auth lookup (`select "id" from "accounts" where "accounts"."api_key_hash" = $1`, 4 times) and on the user lookup (1 time). The client got a 500. The service now returns 503 `SERVICE_UNAVAILABLE` with `Retry-After: 1` for a pool wait timeout, so a rerun would show 503s here instead.
- **Nothing was decided twice or lost:** fresh responses = request rows (1,894), and all invariants hold.
- **The index-scan split isn't valid for this run.** The failed requests stopped before their fast-path scan, so `run.sh` flags it.

## 5. Summary

- **Hot account (85.2 req/s):** bounded by the `account_usage` row lock. Decisions are 11.7 ms apart (1 / throughput), which includes the holder's 7 round trips, the lock hand-off and event-loop delay.
- **Many accounts (167.7 req/s):** bounded by the single Node process (API CPU average 107% of one core), with DB connections idle in transaction waiting for it.
- **Retry storm (154.9 req/s, 44.6 decisions/s):** two thirds of the account-row transactions (2,677 of 4,016) are duplicates that replay at the recheck. Fast-path replays (21.0/s) skip the lock.
- **At 4× the VUs:** hot-account throughput stays flat, and requests start failing on the 2s pool wait timeout.
- **Correctness:** every invariant and the fresh = rows check held in every run.

## 6. Proposed improvements (as proposed after the baseline; item 3 is measured in §8)

Effects are estimates derived from the measurements above.

1. **Fewer round trips while the account row is locked.** Run the step 6 recheck and the step 7 plan join as one query. Run the two increments and the request insert (steps 9–10) as one CTE statement. The step order and semantics stay the same. This cuts the round trips after the lock from 7 to 4. **Expected effect:** the retry storm suggests lock time scales with round trips (≈ 5.3 ms for 3 vs 11.7 ms for 7). If that holds, hold time drops to about 11.7 × 4/7 ≈ 6.7 ms, so **hot account goes from ~85 to ~150 decisions/s**. Many accounts would gain less: the API does fewer statements per request, but stays CPU-bound. *This changes how the locked transaction steps are executed (PLAN.md §6 Phase 3), so it needs your sign-off.*
2. **Take concurrent duplicates off the hot row.** Before locking the account row, take `pg_advisory_xact_lock(hashtext(account_id || requestId))`. Copies of the same `requestId` then wait on their own lock, and after the first copy commits, the recheck answers them. The unique constraint and the recheck remain the real guarantee. **Expected effect:** in this retry storm, the 2,677 in-transaction replays (≈ 14.3 s of the 30 s of account-lock time) leave the account row. Account-row transactions drop from 4,016 to the 1,339 decisions, and **decisions/s can rise from 44.6 towards the hot-account rate (85.2)**. The cost is one extra round trip per fresh consume, outside the account lock. *This adds a step to the locked transaction order, so it needs your sign-off.*
3. **Run more API processes, not a bigger pool.** Use `node:cluster` or several replicas, keeping the total connections well under `max_connections`. In many accounts the API is the limit (107% of one core; connections idle in transaction for 6.05 of 9.83), so a larger pool alone would only lengthen the queue inside one busy process. In hot account, more connections would only add lock waiters. **Expected effect:** many-accounts throughput rises with the number of processes until the database or the shared host CPU becomes the limit. These runs didn't measure that ceiling, so there's no number. Hot account doesn't gain, because it stays lock-bound. More total pool capacity would push back the pool wait timeout seen in the 200-VU probe.

## 7. Not verified

- **§6 items 1 and 2 were not implemented or measured.** Their effects are the arithmetic shown, under the stated assumptions. Item 3 is measured in §8, and part of its expected effect turned out wrong.
- **The split of the 11.7 ms lock hold is an estimate** (see §4). The API's per-statement cost can't be measured without instrumenting `src/`.
- **The retry-storm path split assumes no other traffic during the run.** The index counter counts every scan. The cross-check against the burst arithmetic agrees to within 1.
- **Monthly-limit enforcement under load is only weakly exercised.** Checks 2 and 3 pass, but with 2,000,000,000-unit allowances no run came near a limit, by design. The Phase 3 test "50 parallel consumes never exceed the allowance" remains the evidence for that.
- **Rejected-path latency wasn't measured:** there were no rejections.
- **The API's pool wait time wasn't measured directly.** It is inferred from Little's law, from all 10 connections being busy, and in the probe from the pool timeout errors.
- **Run-to-run variation wasn't measured.** Each scenario ran once with the final scripts. The host also runs other processes (editors, other containers), its load wasn't recorded, and k6 shares its CPU with the API and the DB. Treat the absolute numbers as specific to this host.
- **CPU figures are coarse.** `docker stats` samples are ~2s apart (13–18 per run) and include a few samples from k6 setup and teardown.
- **The DB-side statement timings are an approximation.** They come from psql with literal values inside a rolled-back transaction, and COMMIT's cost is taken from `pg_test_fsync`.
- **Leftover rows:** `load/uncontended.sh` and every load run leave their accounts in the Compose DB volume, and all of them pass the invariants. `docker compose down -v` removes them.

## 8. Improvement: several API processes (`node:cluster`)

### What changed

- `src/server.ts`: a new `WORKERS` env var (`src/config.ts`, 1–8; default 4 when measured, now 1, see the decision below). With `WORKERS` > 1 the primary forks that many workers, replaces any that die, and on SIGTERM/SIGINT sends SIGTERM to every worker and exits when they have all shut down. Each worker runs the unchanged server: its own `createPool()` (pg's default of 10 connections) and its own `app.listen`. The workers share the port through `node:cluster`'s round-robin. `WORKERS=1` skips the cluster and runs the server in one process, as before.
- `docker-compose.yml` passes `WORKERS: ${WORKERS:-1}` to the API; it was `${WORKERS:-4}` when §8 was measured, and `load/compare.sh` sets `WORKERS` explicitly on every run either way. `load/run.sh` now records `api_workers_env` and `api_node_processes` in `-env.txt`.
- No change to `consume.service.ts`, the pool settings, or any business logic.
- Added after the measurement, so not exercised by the §8 runs, and neither affects a healthy server:
  - **Crash-loop cap:** a worker that dies before it listens, or within 1s of listening, counts as an early death. After 5 in a row the primary logs it and exits 1 instead of restarting forever. A worker that stays up 1s after listening resets the count.
  - **Listen errors:** a listen error such as `EADDRINUSE` now logs and exits 1, with any `WORKERS` value. Before, Express 5 handed the error to the listen callback, which ignored it: the process logged "listening" and stayed up without listening.
  - **Compose:** the API service has `stop_grace_period: 15s`, so the primary's 12s backstop can fire before Docker's SIGKILL. Docker's default is 10s.

The 4 workers really ran with 10 connections each. Every W4 run's `-env.txt` shows `api_workers_env 4` and `api_node_processes 5` (primary + 4), and the pg_stat_activity samples show 38.4–40.0 connections on average (below). Every W1 run shows `api_workers_env 1`, `api_node_processes 1` and 9.8–10.0 connections.

### Method

The host is shared, and the baseline numbers in §3 were taken in another session: many accounts ran at 167.7 req/s then, and at 187.3–209.5 req/s with the same single process in this session. So §3 is not compared with §8. Instead, `load/compare.sh` ran both configurations back to back in one session (`compare-b94e9fcc.txt`, 2026-10-18 16:19–16:32 UTC), alternating W1 and W4 so drift hits both sides alike:

- 3 rounds of: many accounts W1, W4, then hot account W1, W4 (50 VUs, 30s each);
- then the stress probe once with each: hot account at 200 VUs for 20s, W1 then W4.

Every run is an ordinary `load/run.sh` run, so each has the full set of files from §2. `run.sh` recreates the API container when `WORKERS` changes. Medians are taken per metric over the 3 runs, so the median p95 and the median RPS can come from different runs.

| Order | Scenario | WORKERS | Run ID | Consumes | RPS | p50 | p95 | p99 | Errors |
|---:|---|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | many accounts | 1 | 2e26d886 | 6,034 | 201.1 | 241.6 ms | 324.8 ms | 380.5 ms | 0 |
| 2 | many accounts | 4 | 866f87e6 | 7,931 | 264.4 | 178.2 ms | 286.1 ms | 377.5 ms | 0 |
| 3 | hot account | 1 | 8eae1167 | 2,630 | 87.7 | 546.1 ms | 813.3 ms | 1,086.8 ms | 0 |
| 4 | hot account | 4 | 56878af8 | 2,420 | 80.7 | 737.6 ms | 1,312.2 ms | 1,661.8 ms | 0 |
| 5 | many accounts | 1 | 23227c21 | 5,620 | 187.3 | 246.8 ms | 409.1 ms | 609.4 ms | 0 |
| 6 | many accounts | 4 | ba3add95 | 7,922 | 264.1 | 180.5 ms | 293.9 ms | 398.5 ms | 0 |
| 7 | hot account | 1 | 3811ff67 | 2,661 | 88.7 | 543.0 ms | 788.7 ms | 1,033.5 ms | 0 |
| 8 | hot account | 4 | 97c9f0f1 | 2,437 | 81.2 | 698.6 ms | 1,094.2 ms | 1,420.1 ms | 0 |
| 9 | many accounts | 1 | 0c597c7a | 6,284 | 209.5 | 231.5 ms | 306.6 ms | 357.1 ms | 0 |
| 10 | many accounts | 4 | fc5e9fa8 | 7,851 | 261.7 | 180.6 ms | 292.3 ms | 381.3 ms | 0 |
| 11 | hot account | 1 | e9a4f095 | 2,856 | 95.2 | 523.8 ms | 604.3 ms | 741.5 ms | 0 |
| 12 | hot account | 4 | a30ec57d | 1,850 | 61.7 | 764.2 ms | 1,877.4 ms | 2,382.5 ms | 0 |
| 13 | hot account, 200 VUs, 20s | 1 | 76c60ef4 | 2,066 | 103.3 | 2,044.7 ms | 2,267.8 ms | 2,530.5 ms | 0 |
| 14 | hot account, 200 VUs, 20s | 4 | f5e0610e | 1,914 | 95.7 | 2,280.3 ms | 2,819.9 ms | 3,365.7 ms | 206 |

Correctness held in all 14 runs. All four global invariants are 0 in every `-sql.txt`, and k6 fresh responses = request rows in every run (`k6 fresh=… request rows=… OK` in each `-run.txt`), including run 14, which had errors.

### Results (medians of 3, 50 VUs, 30s)

| Scenario | | RPS | p50 | p95 | p99 | Errors |
|---|---|---:|---:|---:|---:|---:|
| many accounts | WORKERS=1 | 201.1 | 241.6 ms | 324.8 ms | 380.5 ms | 0 in all 3 |
| | WORKERS=4 | **264.1** | **180.5 ms** | **292.3 ms** | 381.3 ms | 0 in all 3 |
| | change | **+31.3%** | −25.3% | −10.0% | +0.2% | |
| hot account | WORKERS=1 | 88.7 | 543.0 ms | 788.7 ms | 1,033.5 ms | 0 in all 3 |
| | WORKERS=4 | **80.7** | **737.6 ms** | **1,312.2 ms** | **1,661.8 ms** | 0 in all 3 |
| | change | **−9.0%** | +35.8% | +66.4% | +60.8% | |

The ranges don't overlap: many accounts W1 187.3–209.5 vs W4 261.7–264.4 req/s, hot account W1 87.7–95.2 vs W4 61.7–81.2 req/s.

### Supporting samples (medians of the 3 runs' `-run.txt` summaries)

| Scenario | WORKERS | Conns | Running | Waiting on a lock | Idle in transaction | Samples with a lock waiter | API CPU avg | DB CPU avg |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| many accounts | 1 | 9.81 | 1.00 | 0.12 | 6.05 | 4, 9, 7 of 62–64 | 116% | 116% |
| many accounts | 4 | 38.87 | 2.15 | 2.44 | 24.05 | 58, 57, 56 of 61–63 | 430% | 245% |
| hot account | 1 | 9.85 | 0.51 | 8.23 | 0.92 | 61, 61, 61 of 61–63 | 75% | 59% |
| hot account | 4 | 39.45 | 0.68 | 37.48 | 0.85 | 61, 61, 61 of 61–62 | 120% | 73% |

### Many accounts: +31%, but far from 4×

The improvement is real: 264.1 vs 201.1 req/s, with the same ordering in every round. By Little's law, 50 / 264.1 = 189 ms against a measured p50 of 180.5 ms, so the gain is shorter queueing. The API still looks like the limit: connections spend most of their time idle in transaction (24.05 of 38.87), waiting for a worker to send the next statement, and API CPU is 430% of one core, about 108% per worker. Each worker is as busy as the single process was.

Throughput per worker fell, though: 264.1 / 4 = 66 req/s against 201.1 for the single process. API CPU per request went from 116% / 201.1 ≈ 5.8 ms to 430% / 264.1 ≈ 16.3 ms. This was not investigated, so the cause is not verified. The likely reason is the host: `compare-b94e9fcc-host.txt` shows a laptop CPU (i5-1334U) with 12 threads on 10 cores, so only 2 cores are hyperthreaded. Those are the chip's 2 performance cores; the other 8 are efficiency cores (Intel's spec, not measured here). Four busy workers, the DB at 245% and k6 can't all run on fast cores at full clock. The DB is not the limit: it went from 116% to 245% of one core, out of 12.

A new, smaller effect: with 4× the concurrent transactions on the same 100 accounts, two consumes on one account now collide often. Samples with a lock waiter went from 4–9 of ~63 to 56–58 of ~62, but with only 2.44 waiters on average out of 38.87 connections.

### Hot account: worse, not flat

Expected flat, measured 9% slower, with much worse tails (p95 +66%). The extra 30 connections do nothing but wait: 37.48 of 39.45 wait on the `account_usage` row lock, against 8.23 of 9.85 with one process. The time between two decisions on the account rose from 1 / 88.7 = 11.3 ms to 1 / 80.7 = 12.4 ms.

Why more waiters make the lock slower was not measured. A likely explanation: the waiters queue on the row's tuple lock and on the holder's transaction ID (`transactionid+tuple` in the samples), and when the holder commits, Postgres doesn't hand the row to the waiters in strict arrival order. With 37 waiters instead of 8, a request can lose that race many times in a row. This fits the long p95/p99 tails, and run 12 (61.7 req/s, p99 2,382.5 ms) varied the most. API CPU rose too (75% → 120%) with fewer requests served.

### Replication: a second session (`compare-66ef619b.txt`)

`load/compare.sh` was run again, unchanged, on the same host (session `66ef619b`, 2026-10-18 18:35–18:47 UTC, 14 runs in the same order as above). Medians of 3, 50 VUs, 30s, from the medians block at the end of `compare-66ef619b.txt`:

| Scenario | | RPS | p50 | p95 | p99 | Errors |
|---|---|---:|---:|---:|---:|---:|
| many accounts | WORKERS=1 | 197.5 | 242.4 ms | 335.0 ms | 396.6 ms | 0 in all 3 |
| | WORKERS=4 | **267.6** | **177.7 ms** | **285.2 ms** | 374.7 ms | 0 in all 3 |
| | change | **+35.5%** | −26.7% | −14.9% | −5.5% | |
| hot account | WORKERS=1 | 95.9 | 520.8 ms | 601.9 ms | 685.0 ms | 0 in all 3 |
| | WORKERS=4 | **86.1** | **684.6 ms** | **1,028.5 ms** | **1,223.1 ms** | 0 in all 3 |
| | change | **−10.2%** | +31.5% | +70.9% | +78.6% | |

The ranges don't overlap again: many accounts W1 196.3–209.8 vs W4 266.1–268.4 req/s, hot account W1 95.6–96.2 vs W4 86.0–86.1 req/s. Both directions match the first session (many accounts +31.3%, hot account −9.0%). All four global invariants are 0 in all 14 `-sql.txt` files, and k6 fresh responses = request rows in every `-run.txt`.

### Stress probe (200 VUs): both configurations fail on the pool wait

First session:

| | WORKERS=1 (76c60ef4) | WORKERS=4 (f5e0610e) |
|---|---:|---:|
| RPS | 103.3 | 95.7 |
| p50 / p95 / p99 | 2,044.7 / 2,267.8 / 2,530.5 ms | 2,280.3 / 2,819.9 / 3,365.7 ms |
| Errors (non-200) | **0** | **206 (10.76%)** |
| Conns / waiting on a lock | 9.91 / 8.20 | 40.00 / 36.73 |

All 206 errors in `hot-account-f5e0610e-api.log` are pg-pool's `timeout exceeded when trying to connect`: a request waited more than `connectionTimeoutMillis` (2s) for a free connection in its worker's pool. 174 failed when consume opened its transaction (`inTransaction`), and 32 were wrapped by Drizzle as `Failed query`: 21 on the auth lookup (`accounts`), 7 on the fast-path `requests` lookup and 4 on the user lookup. Fresh responses still equal request rows (1,708), so nothing was half-written.

The expectation was that 4× the pool capacity would remove these timeouts. It doesn't, because on the hot account more connections only move requests from the pool queue into the lock queue, and total throughput stays at ~100 req/s. The number of requests waiting for a connection barely changes: 200 − 10 = 190 waiting with one process, and 200 − 40 = 160 with 4. Each worker's queue now drains only as fast as its own 10 connections win the row lock. Given the unfair hand-off described above, one worker's connections can lose for a while, and the requests queued behind them pass 2s. This explanation is not verified, because per-worker pool wait times weren't measured.

That first-session contrast (0 vs 206) did not hold up. Every 200-VU hot-account probe, same settings (200 VUs, 20s):

| Run | When | WORKERS | Consumes | RPS | p50 | p95 | p99 | Errors (non-200) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `c2df73fc` | baseline session (§4) | 1 | 1,902 | 95.1 | 2,305.5 ms | 2,507.5 ms | 2,546.2 ms | 8 (0.42%) |
| `76c60ef4` | first comparison session | 1 | 2,066 | 103.3 | 2,044.7 ms | 2,267.8 ms | 2,530.5 ms | 0 |
| `f5e0610e` | first comparison session | 4 | 1,914 | 95.7 | 2,280.3 ms | 2,819.9 ms | 3,365.7 ms | 206 (10.76%) |
| `fc0db82b` | standalone, 2026-10-18 18:34 UTC | 1 | 1,799 | 90.0 | 2,335.2 ms | 2,923.2 ms | 3,242.5 ms | 225 (12.51%) |
| `a20894b9` | second comparison session | 1 | 2,052 | 102.6 | 2,080.3 ms | 2,310.6 ms | 2,618.7 ms | 0 |
| `a7959b5d` | second comparison session | 4 | 1,921 | 96.1 | 2,191.8 ms | 3,005.9 ms | 3,462.9 ms | 171 (8.90%) |

`fc0db82b` was a single `VUS=200 DURATION=20s load/run.sh hot-account` run with `WORKERS=1` (`api_workers_env 1`, `api_node_processes 1` in its `-env.txt`), started a minute before the second comparison session. Every error in `fc0db82b` and `a7959b5d` is the same pool wait timeout as above: 192 when consume opened its transaction and 33 wrapped by Drizzle in `fc0db82b`, 153 and 18 in `a7959b5d`. Fresh responses = request rows in every probe (1,574 and 1,750 in those two), and all invariants are 0.

So at 200 VUs **both configurations fail on the 2s pool wait**: WORKERS=1 had 8, 0, 225 and 0 errors in four probes, WORKERS=4 had 206 and 171 in two. W1's error count swings from 0 to 225 between runs with the same settings, so these samples can't rank the two configurations. **The 200-VU comparison is inconclusive.** What all six probes agree on is that throughput stays at 90.0–103.3 req/s and p50 at 2.0–2.3 s, because the row lock is still the limit, and that past the pool's 2s wait, requests fail with either setting.

### Conclusion

- **Many accounts gain:** +31.3% RPS in the first session and +35.5% in the second (medians of 3), with every invariant intact.
- **A hot account regresses:** −9.0% RPS and p95 +66.4% in the first session, −10.2% RPS and p95 +70.9% in the second.
- **At 200 VUs, the hot account fails on the pool wait with either setting.** The probes don't show which setting fails less.
- **A hot account needs a shorter lock hold, not more processes or connections:** §6 items 1 (fewer round trips under the lock) and 2 (duplicates off the hot row). A cap on in-flight transactions per account, so extra connections don't pile up on one row, would protect the tails. None of these is implemented.

### Decision: the default is `WORKERS=1`

The cluster code and the `WORKERS` option stay, but `src/config.ts` and `docker-compose.yml` now default to 1 process. The reason is which case matters more. **Product assumption, not measured:** a hot account, one company with many users, is the common case for this service. No traffic data backs this; it's also recorded in the README's Assumptions section. The decision rests on the 50-VU results, replicated in two sessions: with 4 workers a hot account is 9.0% and 10.2% slower, with p95 66.4% and 70.9% longer, while many accounts gain 31.3% and 35.5%. Under that assumption many accounts is the less common case, and the gain doesn't justify a slower hot account with longer tails. The 200-VU pool timeouts are not part of the reason: both settings have them, and the probes are inconclusive. More processes can't fix a hot account, because its limit is the `account_usage` row lock. The real fix is a shorter lock hold, §6 item 1 (fewer round trips while the row is locked).

`WORKERS` > 1 is worth setting when the traffic is spread over many accounts, so no single account row is contended, and the single API process is the limit (API CPU near 100% of one core, connections mostly idle in transaction). The §8 runs used `WORKERS=4` explicitly (`load/compare.sh` sets it per run), so they are unaffected by this change. The §1–7 baseline is the `WORKERS=1` behavior.

### Not verified (§8)

- **Why per-worker throughput fell to a third:** the hybrid-core explanation is a hypothesis. CPU frequency, core placement and k6's own CPU weren't recorded. The P-core/E-core split comes from Intel's spec, not from a measurement.
- **Why 37 lock waiters are slower than 8:** the unfair hand-off is a likely explanation, not a measured one.
- **Per-worker pool wait times and how cluster round-robin spread requests** weren't measured. The pool-timeout explanation is inferred from the totals.
- **3 runs per configuration per session, 2 sessions:** medians of 3 show the direction clearly where the ranges don't overlap, and the second session agrees on it, but they don't pin the size precisely (+31.3% vs +35.5%, −9.0% vs −10.2%).
- **The 200-VU error rate per configuration isn't established:** 4 probes with W1 (8, 0, 225, 0 errors) and 2 with W4 (206, 171). Why W1 sometimes passes and sometimes fails at the same settings wasn't investigated.
- **Retry storm wasn't re-run with `WORKERS=4`.** It is lock-bound like hot account, so the same regression is likely but unmeasured.
- **Other host load during the session** wasn't recorded. Alternating the configurations limits its effect but doesn't remove it.
- **What `tests/server.db.test.ts` covers** (real processes under tsx, against the test DB):
  - `WORKERS=1`: SIGTERM with no requests in flight exits 0, with the old log lines. A taken port exits 1.
  - `WORKERS=2`: SIGKILL of one worker gets it replaced, and `/healthz` still answers. Then SIGTERM with idle workers stops both and the primary exits 0.
  - `WORKERS=2` with the port taken: every worker dies before listening, and the primary exits 1 after the 5th.
- **What it doesn't cover:** SIGINT (Ctrl+C), in either mode. The restart delay itself: the test checks the `restarting in 1000ms` log line, not the timing. The count reset after a worker stays up. Draining in-flight requests on shutdown, because every SIGTERM test runs with idle workers. The 10s forced exit per worker and the primary's 12s backstop. None of it under load.
- **Manual check in the container, no saved output:** with `WORKERS=4`, before the crash-loop cap existed: `kill -9` on one worker (it was replaced), then `docker compose stop api` (graceful, exit code 0). The result was only read off the terminal and no output was saved, so by this document's rules it isn't evidence. It wasn't repeated with `stop_grace_period: 15s`.

## 9. Post-fix check: TP-LOAD-04 (`hot-account-84e77ce8`)

One run of `load/run.sh hot-account` at the defaults (50 VUs, 30s, `WORKERS=1`), as specified by TP-LOAD-04 in `docs/TEST_PLAN.md` §4.8: a check that the F10 input fix (commit `1468d11`, which adds a UTF-8 check on each request body and a surrogate check on each string) changes neither correctness nor throughput. It is one run, not a new baseline, and §1–§8 are unchanged.

### Code and environment

- **Code:** commit `1468d11` (2026-10-19 22:50:08 UTC). The API image was built at 22:53:56 UTC and the API container created at 22:54:06 UTC, before the run started (`started_utc 2026-10-19T23:02:37Z`), and the same container was still running when this section was written. Its 37 compiled `dist/**/*.js` files are byte-identical (sha256) to the local `dist/`, and they contain the F10 checks. `load/run.sh` doesn't record the commit or the dirty state (QA report F11), so the run files themselves don't show the commit. It comes from the developer's record and the timestamps above.
- **Environment** (`-env.txt`): the same versions and settings as §1. `api_node v22.23.3`, `api_workers_env 1`, `api_node_processes 1`, `pg_server_version 16.15`, `shared_buffers` 128MB, `synchronous_commit` on, `fsync` on, `host_cpus 12`, `host_swap_used_mib 1654`. Other host load wasn't recorded, as in every earlier run.

### Results

| Consumes | RPS | p50 | p95 | p99 | max | Errors (non-200) | Accepted | Rejected | Fresh / Replayed |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2,319 | **77.3** | 607.9 ms | 943.0 ms | 1,013.6 ms | 1,107.2 ms | 0 (0.00%) | 2,319 | 0 | 2,319 / 0 |

**Correctness** (`-sql.txt`, `-run.txt`):
- Invariant checks 1–4: 0 violations each.
- Check 5, this run's account: 2,319 request rows, all accepted; accepted units = account usage = user usage = 6,979.
- `k6 fresh=2319  request rows=2319  OK`.
- Index scans (`-idx-delta.txt`): 4,638 on `requests_account_id_request_id_unique` = 2 × 2,319, so every consume was a fresh decision (fast path + recheck), with no replays.
- API log for the run window: `log lines: 0  unhandled errors: 0  service unavailable (overload): 0`. `-pg.err` has only the sampler's `FATAL: terminating connection due to administrator command`, explained at the top of this document.

**Lock and CPU profile** (`-run.txt`): 61 busy samples, all 61 with a lock waiter. Connections 10.00, running 0.44, **waiting on a lock 8.39** (max 9), idle in transaction 0.93, idle 0.23. The waiting query is the step 5 `select "units_used" from "account_usage" … for update` in every sample (57 alone, 3 with the `user_usage` upsert, 1 with the `account_usage` upsert). API CPU average 81%, max 134%; DB CPU average 61%, max 78% (17 samples each).

### Compared with the earlier single-process hot-account runs

Every 50-VU, 30s, single-process hot-account run in `load/results/`:

| Run | When (UTC) | Where cited | RPS | p50 | p95 | p99 | Waiting on a lock | API CPU avg | DB CPU avg |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `e4ff949a` | 2026-10-18 15:26 | §3 (before `WORKERS` existed) | 85.2 | 593.2 ms | 686.8 ms | 731.4 ms | 8.25 | 70% | 60% |
| `8eae1167` | 2026-10-18 16:21 | §8, first session | 87.7 | 546.1 ms | 813.3 ms | 1,086.8 ms | 8.02 | 74% | 59% |
| `3811ff67` | 2026-10-18 16:25 | §8, first session | 88.7 | 543.0 ms | 788.7 ms | 1,033.5 ms | 8.38 | 75% | 59% |
| `e9a4f095` | 2026-10-18 16:28 | §8, first session | 95.2 | 523.8 ms | 604.3 ms | 741.5 ms | 8.23 | 77% | 59% |
| `2ef4271e` | 2026-10-18 18:37 | §8, second session | 95.9 | 518.8 ms | 601.9 ms | 670.5 ms | 8.10 | 77% | 60% |
| `c23c6f4d` | 2026-10-18 18:40 | §8, second session | 95.6 | 520.8 ms | 602.6 ms | 774.2 ms | 8.18 | 79% | 61% |
| `c7103a7d` | 2026-10-18 18:44 | §8, second session | 96.2 | 523.3 ms | 599.9 ms | 685.0 ms | 8.21 | 76% | 59% |
| `bc7adbf3` | 2026-10-19 19:26 | not cited before (QA report F11); code before the F10 fix | 91.3 | 501.1 ms | 787.2 ms | 1,021.6 ms | 8.21 | 77% | 61% |
| **`84e77ce8`** | 2026-10-19 23:02 | this section; code `1468d11` | **77.3** | **607.9 ms** | **943.0 ms** | 1,013.6 ms | 8.39 | 81% | 61% |

All figures are from each run's `-k6.txt` and `-run.txt`.

- **Throughput is the lowest of the nine runs:** 77.3 req/s against 85.2–96.2 req/s before, 7.9 req/s (9.3%) below the previous lowest. The time between two decisions on the account is 1 / 77.3 = 12.9 ms, against 10.4–11.7 ms before.
- **p50 and p95 are above every earlier run** (p50 501.1–593.2 ms, p95 599.9–813.3 ms before). p99 is inside the earlier range (670.5–1,086.8 ms). Little's law still holds: 50 / 77.3 = 647 ms against a measured p50 of 607.9 ms.
- **The bottleneck profile is the same:** the `account_usage` row lock, with 8.39 of 10 connections waiting (8.02–8.38 before). API CPU average is 81% (70–79% before), DB CPU 61% (59–61%).

### TP-LOAD-04 result

| Expected result (TEST_PLAN §4.8) | Measured | Met |
|---|---|---|
| Invariants 0 | Checks 1–4: 0; fresh = request rows | Yes |
| 0 errors | 0 non-200; 0 API log lines | Yes |
| RPS within the documented spread for one run (85.2–103.3 req/s) | 77.3 req/s | **No** |

**TP-LOAD-04 is not passed.** Correctness and errors met their criteria, the throughput criterion did not. The lower bound of 85.2 req/s is the §3 baseline. The upper bound of 103.3 req/s is the 200-VU probe `76c60ef4` (§8). The 50-VU single-process runs above span 85.2–96.2 req/s. The criterion is kept as written. 77.3 req/s is below both ranges.

The 85.2 req/s lower bound is this project's own regression threshold, set in `docs/TEST_PLAN.md`. It is not a requirement of the brief: `docs/REQUIREMENTS.md` asks for load testing, evidence of the results, and an explanation of the method and lessons, and it sets no minimum throughput. "Not passed" means the run fell outside the project's internal expected range.

### Uncited many-accounts run: `many-accounts-06e6a282`

One more run from 2026-10-19 (19:30 UTC, in the same session as `bc7adbf3` and before the F10 fix) isn't used by any conclusion above. It is recorded here so it isn't hidden. Like the other two §9 runs, its files are untracked.

| Run | WORKERS (`-env.txt`) | `api_node_processes` | RPS | p50 | p95 | p99 | Errors | Invariants |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `06e6a282` | 1 | **2** | **339.6** | 136.9 ms | 211.5 ms | 247.9 ms | 0 | checks 1–4: 0; `k6 fresh=10187 request rows=10187 OK` |

- **It is anomalous.** Every other many-accounts run with one API process is 167.7–209.8 req/s (§3 and both §8 sessions), and every `WORKERS=4` run is 261.7–268.4 req/s (§8). This single `WORKERS=1` run is 62% above the highest of the other single-process runs and beats every `WORKERS=4` run.
- **Its `-env.txt` reports 2 `node` processes** although `WORKERS` is 1. Every other `WORKERS=1` run that records the count reports 1. `run.sh` counts `node` processes with `ps` at one instant, and the API healthcheck also starts a `node` process every 5s (`docker-compose.yml:36`). That is a possible explanation of the count, not a verified one.
- **The cause of the throughput isn't known.** It wasn't investigated or repeated, and `run.sh` doesn't record the git commit (QA report F11). Until a rerun explains it, the §8 conclusion (`WORKERS=4` about 31–35% faster for many accounts) rests on the 12 many-accounts runs of the two §8 sessions, and this run neither confirms nor refutes it.

### Not verified (§9)

- **Why throughput is lower.** The cause wasn't investigated. One run can't tell a cost of the F10 fix apart from run-to-run or host variation, and no code before the fix was run in the same session to compare.
- **Run-to-run variation on `1468d11`:** one run only.
- **The git state at image build time** isn't recorded by `load/run.sh` (F11). It is inferred from the timestamps and the `dist/` comparison above.
- **These files are untracked** in git when this section was written (`git status`), like `hot-account-bc7adbf3-*` and `many-accounts-06e6a282-*` (QA report F11), and they are still untracked at `9880430`. Every number in §9 comes from files a clone of the repository doesn't contain. Committing them is the developer's decision.
- **Why `many-accounts-06e6a282` is faster**, and why it reports 2 API processes (see above).
