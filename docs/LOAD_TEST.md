# Load Test

This document covers how I load-tested the service, what I measured, and where the bottlenecks are.

- §1–§7: the baseline. One API process, nothing tuned.
- §8: several API processes (`WORKERS`), compared with one process.
- §9: a prototype that holds the account lock for fewer statements, compared with the current transaction. The prototype is not in production code ([CONSUME_ROUND_TRIPS.md](CONSUME_ROUND_TRIPS.md)).

Every number below comes from a file in `load/results/`, or is arithmetic on those numbers shown inline.

| Run | Produced by | Files |
|---|---|---|
| hot account, 50 VUs | `load/run.sh hot-account` | `hot-account-e4ff949a-*` |
| many accounts, 50 VUs | `load/run.sh many-accounts` | `many-accounts-6d1621bb-*` |
| retry storm, 50 VUs | `load/run.sh retry-storm` | `retry-storm-6d0745d1-*` |
| §8: WORKERS=1 vs 4, first comparison (14 runs) | `load/compare.sh` | `compare-b94e9fcc.txt` (index and medians), the 14 run IDs it lists, `compare-b94e9fcc-host.txt` |
| §8: WORKERS=1 vs 4, second comparison (14 runs) | `load/compare.sh` | `compare-66ef619b.txt` (index and medians) and the 14 run IDs it lists |
| §9: current transaction vs prototype, all four scenarios including mixed (42 runs) | `load/ab.sh`, `load/ab-paired.py` | `ab-d29bcad1.txt` (index and medians), `ab-d29bcad1-paired.txt`, and the 42 run IDs it lists |

Each `run.sh` run saves:
- `-env.txt`: host, versions and settings;
- `-k6.txt`;
- `-pg.txt`: `pg_stat_activity` samples;
- `-cpu.txt`;
- `-idx.txt` and `-idx-delta.txt`: index scan counters;
- `-sql.txt`: invariants;
- `-api.log`;
- `-run.txt`: the full console output, including the summaries quoted below.

Two things in these files look like failures but aren't:
- The `FATAL: terminating connection due to administrator command` line in `-pg.err` is the sampler being stopped at the end of the run.
- The stack traces in the 200-VU runs' `-api.log` files are the expected pool timeouts (§8).

## 1. Setup

| | |
|---|---|
| Load generator | k6, official image `grafana/k6:1.3.0`, as the Compose service `k6` under profile `load` |
| API | One Node process (`api_node v22.23.3`), Express 5, Drizzle, `pg`, built by the repo's Dockerfile |
| Pool | `createPool()` in `src/db/client.ts`: `connectionTimeoutMillis` 2s (in pg-pool this also limits the wait for a free connection), `query_timeout` 5s, `statement_timeout` 4s, `lock_timeout` 3s, `idle_in_transaction_session_timeout` 10s. `max` isn't set, so it's pg's default of **10 connections**. |
| Database | `postgres:16` (16.15), image defaults: `max_connections` 100, `shared_buffers` 128MB, `synchronous_commit` on, `fsync` on |
| Host | One Linux laptop shared by k6, the API and the database: `host_cpus 12`, `host_mem_total_mib 7625`, Docker 29.9.0, Compose 5.6.0 |
| Run shape | `constant-vus`, **50 VUs, 30s**, no think time |

k6 `setup()` creates every account and user through the public API: `POST /accounts`, `POST /plans`, `PUT /account/plan`, `POST /users`. In hot account, many accounts and retry storm, the custom plans allow **2,000,000,000 units/month and 1,000/request** (`load/lib.js`), so every request takes the accepted path: both increments plus the request insert.

Each run gets a random hex run ID. Its accounts are named `load-<scenario>-<run_id>-<n>`, and the per-run SQL checks select them by that ID.

### Scenarios

| Script | What it does |
|---|---|
| `load/hot-account.js` | **1 account, 200 users.** Each iteration picks a random user and consumes 1–5 units under a new `requestId`. Every consume locks the same `account_usage` row. |
| `load/many-accounts.js` | **100 accounts × 5 users.** Same request mix, spread over random accounts. |
| `load/retry-storm.js` | **1 account, 50 users, 5,000 `requestId`s.** Each iteration picks a random key and sends the **same request 3 times at once**. A key always maps to the same user and units, so a correct service never answers 409. |
| `load/mixed.js` | **1 account, 200 users**, both plans 10 units/request. 40 users have their allowance used up in setup. The request sequence is seeded by (VU, iteration), so every build gets the same mix: about 1/3 user per-request rejections, 13.3% user monthly rejections, the rest accepted. |

### Metrics

Only `POST /consume` is measured (tag `name:consume`).
- **RPS** = consume requests / run duration.
- **p50/p95/p99** = `http_req_duration{name:consume}`, the full HTTP round trip as k6 sees it.
- **Errors** = non-200 consume responses. A `REJECTED` decision is HTTP 200, so it isn't an error.

## 2. Reproduce

From the repo root. `run.sh` needs bash, Docker with Compose v2, `jq` and `od`, on a Linux host.

```sh
docker compose up -d --build --wait db api       # build and start the API + DB
load/run.sh hot-account
load/run.sh many-accounts
load/run.sh retry-storm
load/run.sh mixed
VUS=200 DURATION=20s load/run.sh hot-account     # stress probe
load/compare.sh                                  # WORKERS=1 vs WORKERS=4, alternating (§8)
A_IMAGE=<image> B_IMAGE=<image> load/ab.sh       # two API builds, ABBA, one database (§9)
python3 load/ab-paired.py load/results/ab-<id>.txt
```

`load/run.sh <scenario>` does this and saves everything to `load/results/<scenario>-<run_id>-*`:

1. Records the environment. Newer runs also record the git commit, the checkout state and the API image ID (`load/provenance.sh`). The runs cited here predate that, except §9's, whose images were built from copies of the tree, so their `git_commit` reads `unknown`.
2. Snapshots index scan counters (`load/index-scans.sql`).
3. Samples `pg_stat_activity` every 0.5s and container CPU (`docker stats`) in the background.
4. Runs k6.
5. Stops the samplers, waits 11s so idle backends flush their statistics, and snapshots the counters again.
6. Runs `load/check-invariants.sql`.
7. Saves the API log for the run window and prints the summaries.

Every scenario reads `VUS`, `DURATION`, `BASE_URL` and `RUN_ID`. `WORKERS=n load/run.sh <scenario>` runs it against n API processes.

## 3. Results

50 VUs, 30s, 2026-10-18, one API process.

| Scenario | Run ID | Consumes | RPS | p50 | p95 | p99 | Errors | Fresh / Replayed |
|---|---|---:|---:|---:|---:|---:|---:|---|
| hot account | e4ff949a | 2,556 | **85.2** | 593.2 ms | 686.8 ms | 731.4 ms | 0 | 2,556 / 0 |
| many accounts | 6d1621bb | 5,032 | **167.7** | 284.8 ms | 417.0 ms | 485.7 ms | 0 | 5,032 / 0 |
| retry storm | 6d0745d1 | 4,647 | **154.9** | 1,023.1 ms | 1,170.3 ms | 1,221.9 ms | 0 | 1,339 / 3,308 |

- No non-200 responses, no 409 in the retry storm, and no API log lines (`log lines: 0` in `-run.txt`).
- Every response was ACCEPTED. In the retry storm, replays count as accepted because they return the stored ACCEPTED decision.
- Latency is mostly queueing: 50 VUs share 10 connections. By Little's law, p50 ≈ VUs / RPS: 50 / 85.2 = 587 ms (measured 593.2), and 50 / 167.7 = 298 ms (measured 284.8).

The mixed scenario was added later and has no run in this baseline set. Its results are in §9.

### Invariants (`load/check-invariants.sql`, after every run)

| Check | Scope | Result |
|---|---|---|
| 1. `account_usage.units_used` = sum of that account's `user_usage.units_used` | every account and month | 0 violations |
| 2. No account's usage exceeds its plan's `monthly_limit` | every account, current UTC month | 0 violations |
| 3. No user's usage exceeds the user plan's `monthly_limit` | every user, current UTC month | 0 violations |
| 4. `account_usage.units_used` = sum of the units of its ACCEPTED request rows | every account and month | 0 violations |
| 5. This run's accepted units, account usage and user usage | this run's accounts | equal: 7,682 / 15,079 / 3,952 |
| k6 fresh responses = this run's request rows | this run | equal: 2,556 / 5,032 / 1,339 |

Checks 2 and 3 cover the current month only, because only the current plan assignment is stored. Check 6, added later with the decision snapshot, compares each decision with the limits it recorded; it ran on every §9 run.

## 4. Bottleneck

### pg_stat_activity samples

Averages over the 0.5s samples taken while the API had traffic, from the `-run.txt` summaries:

| Scenario | Busy samples (with a lock waiter) | Conns | Running | **Waiting on a lock** | Idle in transaction | Idle |
|---|---:|---:|---:|---:|---:|---:|
| hot account | 61 (61) | 10.00 | 0.54 | **8.25** (max 9) | 1.08 | 0.13 |
| many accounts | 63 (9) | 9.83 | 1.02 | 0.16 (max 2) | **6.05** | 2.60 |
| retry storm | 61 (61) | 10.00 | 0.59 | **8.00** (max 9) | 0.89 | 0.52 |

In hot account and retry storm, the waiting query in every sample is the step 5 lock, `select "units_used" from "account_usage" where (…) for update`. In a few samples a usage upsert (step 4) also waits.

### Hot account: the account usage row lock serializes the account

On average 8.25 of the 10 connections wait on the account row lock. Only one consume per account runs from step 5 to COMMIT at a time.

The time between two decisions on the account is 1 / 85.2 req/s = **11.7 ms**. That covers more than the holder's own statements:
- Postgres waking the next waiter after COMMIT;
- event-loop delay in the API, since every statement of the holder and every waiter shares one Node event loop;
- the WAL flush at COMMIT.

Among the connections not waiting on the lock, more are `idle in transaction` (1.08, waiting for the API to send the next statement) than running (0.54). That suggests the API's per-statement cost is a large part of the hold time. §9 tests this directly: cutting the statements under the lock from 8 to 4 made the hot account 42% faster.

On 100 accounts, the same 10 connections wait on a lock in only 9 of 63 samples, and throughput is 167.7 vs 85.2 req/s. The limit moves elsewhere.

### Many accounts: the single Node process

Without lock contention, the connections are mostly `idle in transaction` (6.05 of 9.83): Postgres has finished the previous statement and is waiting for the API to send the next one. Container CPU (`-cpu.txt`, 100% = one core):
- API: average 107%, max 168%. One Node process runs JavaScript on one core.
- DB: average 114%, max 153%, out of 12 cores.

The API process is the limit here, not the database or the pool.

### Retry storm: duplicates queue on the hot row too

Every consume does one lookup on the `requests_account_id_request_id_unique` index (the step 2 fast path), and every consume transaction does one more (the step 6 recheck). So transactions = index scans − consumes (`-idx-delta.txt`). The hot-account run checks this model: 5,112 scans = 2 × 2,556 consumes, all fresh.

| | Count | Per second (÷ 30) |
|---|---:|---:|
| consumes | 4,647 | 154.9 |
| request-index scans | 8,663 | |
| consume transactions = 8,663 − 4,647 | 4,016 | 133.9 |
| … fresh decisions | 1,339 | 44.6 |
| … replays answered at the recheck = 4,016 − 1,339 | 2,677 | 89.2 |
| fast-path replays, no transaction = 4,647 − 4,016 | 631 | 21.0 |

Two thirds of the transactions on the account row are copies that wait for the lock only to learn that their request was already decided. The fast-path replays skip the lock but still share the 10 connections and the event loop.

An in-transaction replay stops at the recheck, so it holds the lock for fewer statements than a fresh decision. That is why the row handles more transactions per second here (133.9) than in hot account (85.2).

Idempotency held under this race: zero 409s, and fresh decisions = request rows (1,339).

## 5. Summary

- **Hot account (85.2 req/s):** bounded by the `account_usage` row lock. Decisions on the account are 11.7 ms apart.
- **Many accounts (167.7 req/s):** bounded by the single Node process (API CPU 107% of one core).
- **Retry storm (154.9 req/s, 44.6 fresh decisions/s):** 2,677 of the 4,016 account-row transactions are duplicates that replay at the recheck.
- **Correctness:** every invariant and the fresh = rows check held in every run.

## 6. What would improve it

1. **Fewer statements while the account row is locked.** Merge the step 6 recheck with the step 7 plan read, and the two increments with the request insert (steps 9–10). The step order and semantics stay the same, and the statements under the lock go from 8 to 4. I prototyped and measured this in §9 (+42% on a hot account). It is not integrated.
2. **Take concurrent duplicates off the hot row.** Take a `pg_advisory_xact_lock` on `(account_id, requestId)` before the account lock, so copies of one request wait on their own lock and replay at the recheck. The unique constraint and the recheck stay the real guarantee. Not implemented or measured.
3. **Run more API processes.** This helps many accounts but not a hot account, which stays lock-bound. Measured in §8.

## 7. Limits of these measurements

- One run per scenario in §3. The host is a laptop that also runs other software, and k6 shares its CPU with the API and the database. Treat absolute numbers as specific to this host and day.
- With 2,000,000,000-unit allowances, §3 never comes near a limit and has no rejections. The rejected path under load is covered by the mixed scenario in §9. Monthly-limit enforcement under concurrency is covered by the integration tests (`tests/consume-races.db.test.ts`, `tests/consume.db.test.ts`).
- The pool wait time wasn't measured directly. I infer it from Little's law and from all 10 connections being busy.
- `docker stats` CPU samples are about 2s apart (13–18 per run).
- Every load run leaves its accounts in the Compose database volume. `docker compose down -v` removes them.

## 8. Several API processes (`node:cluster`)

### What changed

- `src/server.ts` reads `WORKERS` (1–8, `src/config.ts`). With `WORKERS` > 1, a primary forks that many workers, replaces any that die, and forwards SIGTERM/SIGINT for a graceful shutdown. Each worker runs the unchanged server with its own pool of 10 connections. `WORKERS=1` runs the server in one process without the cluster.
- No change to `consume.service.ts`, the pool settings or any business logic.

Every W4 run's `-env.txt` shows `api_workers_env 4` and `api_node_processes 5` (primary + 4), and the samples show 38.4–40.0 connections on average. Every W1 run shows `api_workers_env 1`, `api_node_processes 1` and 9.8–10.0 connections.

### Method

The baseline in §3 ran on another day, and the same single process ran many accounts at 187.3–209.5 req/s on this day, against 167.7 then. So I didn't compare §3 with these runs. Instead, `load/compare.sh` ran both configurations back to back, alternating W1 and W4 so host drift affects both alike:

- 3 rounds of: many accounts W1, W4, then hot account W1, W4 (50 VUs, 30s each);
- then a stress probe with each: hot account at 200 VUs for 20s, W1 then W4.

I ran the whole comparison twice on 2026-10-18: 16:19–16:32 UTC (`compare-b94e9fcc.txt`) and 18:35–18:47 UTC (`compare-66ef619b.txt`). Medians are per metric over the 3 runs, so the median p95 and the median RPS can come from different runs.

First comparison, every run:

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

The second comparison's 14 runs are listed in `compare-66ef619b.txt`. In both, all four global invariants are 0 in every `-sql.txt`, and k6 fresh responses = request rows in every `-run.txt`, including the runs with errors.

### Results (medians of 3, 50 VUs, 30s)

| Scenario | WORKERS | First: RPS | p50 | p95 | p99 | Second: RPS | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| many accounts | 1 | 201.1 | 241.6 ms | 324.8 ms | 380.5 ms | 197.5 | 242.4 ms | 335.0 ms | 396.6 ms |
| many accounts | 4 | **264.1 (+31.3%)** | 180.5 ms | 292.3 ms | 381.3 ms | **267.6 (+35.5%)** | 177.7 ms | 285.2 ms | 374.7 ms |
| hot account | 1 | 88.7 | 543.0 ms | 788.7 ms | 1,033.5 ms | 95.9 | 520.8 ms | 601.9 ms | 685.0 ms |
| hot account | 4 | **80.7 (−9.0%)** | 737.6 ms | 1,312.2 ms | 1,661.8 ms | **86.1 (−10.2%)** | 684.6 ms | 1,028.5 ms | 1,223.1 ms |

The W1 and W4 ranges don't overlap in either comparison. First: many accounts W1 187.3–209.5 vs W4 261.7–264.4 req/s, hot account W1 87.7–95.2 vs W4 61.7–81.2 req/s. Second: many accounts W1 196.3–209.8 vs W4 266.1–268.4, hot account W1 95.6–96.2 vs W4 86.0–86.1.

### Supporting samples (first comparison, medians of the 3 runs' `-run.txt` summaries)

| Scenario | WORKERS | Conns | Running | Waiting on a lock | Idle in transaction | API CPU avg | DB CPU avg |
|---|---:|---:|---:|---:|---:|---:|---:|
| many accounts | 1 | 9.81 | 1.00 | 0.12 | 6.05 | 116% | 116% |
| many accounts | 4 | 38.87 | 2.15 | 2.44 | 24.05 | 430% | 245% |
| hot account | 1 | 9.85 | 0.51 | 8.23 | 0.92 | 75% | 59% |
| hot account | 4 | 39.45 | 0.68 | 37.48 | 0.85 | 120% | 73% |

### Many accounts: +31% to +35%, far from 4×

The connections still spend most of their time idle in transaction (24.05 of 38.87), waiting for a worker to send the next statement, and API CPU is 430% of one core, about 108% per worker. Each worker is as busy as the single process was.

Throughput per worker fell: 264.1 / 4 = 66 req/s against 201.1 for one process. I didn't investigate why. A likely reason is the host: `compare-b94e9fcc-host.txt` shows a laptop CPU (i5-1334U) with 12 threads on 10 cores, of which, per Intel's spec, 2 are performance cores and 8 are efficiency cores. Four busy workers, the database at 245% and k6 can't all run on fast cores. The database isn't the limit: it uses 245% of one core out of 12.

### Hot account: slower, with worse tails

The extra 30 connections only wait: 37.48 of 39.45 wait on the `account_usage` row lock, against 8.23 of 9.85 with one process. The time between two decisions on the account rose from 1 / 88.7 = 11.3 ms to 1 / 80.7 = 12.4 ms.

I didn't measure why more waiters make the lock slower. A likely explanation is that Postgres doesn't hand the row to waiters in strict arrival order. With 37 waiters instead of 8, a request can lose that race many times in a row, which fits the long p95 and p99 tails.

### Stress probe (200 VUs, 20s)

| | First comparison | | Second comparison | |
|---|---:|---:|---:|---:|
| | W1 (`76c60ef4`) | W4 (`f5e0610e`) | W1 (`a20894b9`) | W4 (`a7959b5d`) |
| RPS | 103.3 | 95.7 | 102.6 | 96.1 |
| p50 / p95 / p99 | 2,044.7 / 2,267.8 / 2,530.5 ms | 2,280.3 / 2,819.9 / 3,365.7 ms | 2,080.3 / 2,310.6 / 2,618.7 ms | 2,191.8 / 3,005.9 / 3,462.9 ms |
| Errors (non-200) | 0 | 206 | 0 | 171 |

Every W4 error is pg-pool's `timeout exceeded when trying to connect`: a request waited more than 2s for a free connection in its worker's pool. These runs predate the 503 mapping, so the client got a 500. The service now returns 503 `SERVICE_UNAVAILABLE` with `Retry-After: 1` for this.

More connections don't remove the pool wait on a hot account. They move requests from the pool queue into the lock queue, and throughput stays at about 100 req/s either way. Two probes per setting are too few to say how often each one fails at this load. Fresh responses = request rows in every probe, so nothing was half-written.

### Decision: the default is `WORKERS=1`

The cluster code and the `WORKERS` option stay, but `src/config.ts` and `docker-compose.yml` default to 1 process. The 50-VU results point in the same direction in both comparisons: with 4 workers a hot account is 9.0% and 10.2% slower, with p95 66.4% and 70.9% longer, while many accounts gain 31.3% and 35.5%.

This rests on a **product assumption, not traffic data:** a hot account, one company with many users, is the common case. More processes can't fix a hot account, because its limit is the row lock. The fix for that is a shorter lock hold (§6 item 1, §9).

`WORKERS` > 1 is worth setting when traffic is spread over many accounts and the single API process is the limit: API CPU near 100% of one core, connections mostly idle in transaction.

### Limits (§8)

- 3 runs per configuration in each comparison. The direction is clear because the ranges don't overlap, but the size isn't pinned down precisely (+31.3% vs +35.5%, −9.0% vs −10.2%).
- The hybrid-core explanation for lower per-worker throughput, and the unfair lock hand-off, are likely explanations, not measurements.
- Retry storm wasn't run with `WORKERS=4`. It is lock-bound like hot account, so I expect the same regression, but I didn't measure it.
- `tests/server.db.test.ts` covers worker replacement, graceful shutdown with idle workers, and the crash-loop cap, with real processes. It doesn't cover SIGINT, draining in-flight requests, or behavior under load.

## 9. Fewer statements under the account lock: prototype vs current transaction

**What is compared.** Two API images built from the same tree. The only difference is `src/services/consume.service.ts`. The baseline is the current production transaction. The prototype runs 4 statements under the account lock instead of 8 ([CONSUME_ROUND_TRIPS.md](CONSUME_ROUND_TRIPS.md)). The prototype is **not** in production code.

| | |
|---|---|
| Files | `load/results/ab-d29bcad1.txt` (index, per-run numbers, medians), `ab-d29bcad1-paired.txt` (paired analysis), and the 42 run IDs it lists |
| Images | baseline `sha256:fe5e56f5aa90…`, prototype `sha256:651c1f2a0456…`, built from exports of the working tree, without and with the patch. `diff -r` of `src/` showed only `consume.service.ts` differing |
| Database | `postgres:16`, image defaults, **one database for both images**: a separate Compose project `quotaab2` with its own volume, removed afterwards |
| API | one process (`WORKERS=1`), pool of 10 |
| Workload | 50 VUs × 30s, 1 warm-up run per image (excluded), then 5 rounds of hot-account, mixed, many-accounts and retry-storm in ABBA order. `load/ab.sh` runs `ANALYZE` before every run |
| Command | `A_IMAGE=quota-ab2:baseline B_IMAGE=quota-ab2:prototype A_LABEL=baseline B_LABEL=prototype ROUNDS=5 SCENARIOS="hot-account mixed many-accounts retry-storm" COMPOSE_PROJECT_NAME=quotaab2 DB_PORT=5434 AB_API_PORT=3100 load/ab.sh` |

### The host was not stable during these runs

- **The laptop suspended twice** (kernel log `PM: suspend entry/exit`): 14:46:58–14:51:23 UTC and 15:06:14–17:25:00 UTC on 2026-10-22.
- **Run 14** (baseline, mixed) contains the first suspend: a 266s stall, p99 265,872.4 ms, and 10 errors. **Run 31** (prototype, many accounts) contains the second, with 4 errors after resume. **I excluded both runs and their pairs.** No other run had an error.
- The host was short of memory throughout: `host_swap_used_mib` was 1,962–2,047 at the start of the runs. Both images slowed down from round 2 or 3 on, so the **absolute numbers aren't comparable across rounds, or with §3 and §8**. The paired ratios are what this comparison relies on: each round's two runs of a scenario are back to back, so their ratio cancels drift between rounds.

### Per-scenario numbers (all 5 measured runs per cell, from `ab-d29bcad1.txt`)

| Scenario | Image | RPS min / median / max | p50 | p95 | p99 | Errors | Rejected share |
|---|---|---|---:|---:|---:|---:|---:|
| hot account | baseline | 97.2 / 106.9 / 153.0 | 471.2 ms | 537.7 ms | 562.6 ms | 0 | 0.0% |
| hot account | prototype | 128.5 / 155.4 / 238.5 | 325.1 ms | 376.0 ms | 401.5 ms | 0 | 0.0% |
| many accounts | baseline | 264.5 / 295.5 / 571.6 | 156.8 ms | 234.8 ms | 282.9 ms | 0 | 0.0% |
| many accounts | prototype | 249.0 / 355.3 / 692.7 | 126.5 ms | 216.0 ms | 258.3 ms | 4 (run 31) | 0.0% |
| retry storm | baseline | 150.2 / 193.2 / 462.0 | 800.2 ms | 1,018.0 ms | 1,127.8 ms | 0 | 0.0% |
| retry storm | prototype | 214.4 / 219.1 / 566.6 | 681.2 ms | 908.5 ms | 965.1 ms | 0 | 0.0% |
| mixed | baseline | 89.1 / 111.6 / 138.1 | 443.9 ms | 549.2 ms | 606.8 ms | 10 (run 14) | 46.1% |
| mixed | prototype | 155.5 / 158.3 / 273.2 | 316.7 ms | 373.7 ms | 406.1 ms | 0 | 46.0% |

The latency columns are medians over the 5 runs. These rows include runs 14 and 31; the paired results below exclude them.

### Paired results (prototype / baseline, valid pairs only, from `ab-d29bcad1-paired.txt`)

| Scenario | Valid pairs | RPS ratio per pair | Geometric mean | Prototype faster | p95 ratio (median) | p99 ratio (median) |
|---|---:|---|---:|---:|---:|---:|
| hot account | 5 | 1.305, 1.559, 1.399, 1.551, 1.322 | **1.423 (+42.3%)** | 5/5 | 0.704 | 0.691 |
| mixed | 4 | 1.695, 1.418, 1.407, 1.758 | 1.562 (+56.2%) | 4/4 | 0.706 | 0.674 |
| many accounts | 4 | 1.212, 1.263, 1.141, 1.176 | 1.197 (+19.7%) | 4/4 | 0.907 | 0.864 |
| retry storm | 5 | 1.226, 1.088, 1.134, 1.144, 1.427 | 1.198 (+19.8%) | 5/5 | 0.884 | 0.843 |

- **Hot account:** the prototype was faster in every round, by 1.305× to 1.559×, whether the host was fine, short of memory, or just resumed.
- **Mixed:** the rejected share is the same for both builds (45.8–46.4% per run), so the comparison is like-for-like. The prototype's rejected path also skips statements under the lock.
- **Many accounts:** no lock contention here; the gain comes from fewer statements per request for the single API process.
- **Retry storm:** faster in 5/5 pairs, but the ratios are spread (1.088–1.427). Duplicates still queue on the account row; §6 item 2 targets that and wasn't prototyped.
- **Correctness:** 0 invariant violations (checks 1–4 and 6) in all 42 runs, including the two excluded ones, and k6 fresh decisions = request rows in every run.
- **Significance:** with 5 pairs, an exact two-sided sign-flip test can't go below p = 2/32 = 0.0625, which is what 5/5 gives.

### Limits (§9)

- One set of runs, on an unstable host. The direction and the paired ratios are consistent, but absolute throughput isn't established.
- 200 VUs, and `WORKERS` > 1, weren't run with the prototype.
- `-env.txt` can't prove the images' source commit, because they were built from copies of the tree. The image IDs are recorded.
