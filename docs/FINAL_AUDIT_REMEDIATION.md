# Final Audit Remediation

| | |
|---|---|
| Date | 2026-10-21, in two rounds on the same day |
| Base commit | `b454b81` (`main`). Every change below is **uncommitted** in the working tree: nothing staged, committed or pushed |
| Audit | [FINAL_AUDIT_REPORT.md](FINAL_AUDIT_REPORT.md), kept as written at audit time. This document records what changed afterwards |
| Not touched | `load/results/`: all 400 files are sha256-identical to the snapshot taken before remediation, and the 33 untracked ones are still untracked. The running Compose stack wasn't stopped, rebuilt or recreated, so its containers still run the **pre-fix** images (`api_image_created` 2026-10-20 20:29 +03:00) |
| Never run | Load tests, Docker image builds, container lifecycle operations, a browser |

**How to read the evidence.**
- §4.1 is round 1's verification, kept as recorded.
- §4.2 is round 2's, on the final tree. Round 2's counts supersede round 1's.
- Round 1 claims that round 2 found inaccurate are corrected in §1 and listed in §4.3; the record of round 1 is not edited in place.
- Evidence from before this remediation (the audit, `docs/QA_REPORT.md`, `docs/TEST_PLAN.md`, `docs/LOAD_TEST.md`) is not restated as current.

Environment for both rounds: Node v22.15.0, test database `quota_test` on the Compose PostgreSQL 16.

## 1. Final status by finding

### Fixed in code, with regression tests

**AUD-01: migrations and seed ran under the request-path timeouts**
- **Status:** Fixed (round 1). The README caveat was added in round 2.
- **Files:**
  - `src/db/client.ts`: `MAINTENANCE_TIMEOUTS`, `createMaintenancePool()`.
  - `src/scripts/run-with-db.ts`: uses that pool.
  - `tests/global-setup.ts`: migrates `quota_test` the same way.
  - `README.md` "Other decisions".
- **Fix:** migrate and seed get a single-connection pool with 15 min per statement, 60s per lock wait, a 16 min client-side backstop, 60s idle-in-transaction and a 10s connect timeout. Finite on purpose, so a migration stuck behind a lock fails instead of hanging startup. The request pool (4s statement, 3s lock, 5s query) is unchanged. Drizzle's single migration transaction and exit-1-on-failure are preserved.
- **Tests:** `tests/maintenance-pool.db.test.ts`, using a temporary migration folder and its own journal schema, so the real `drizzle.__drizzle_migrations` is never touched.
  - One configuration test: `runWithDb` sessions report 15min / 1min / 1min, and the request pool still reports 4s / 3s.
  - Two behavioral tests: a `SELECT pg_sleep(4.5)` migration is cancelled with 57014 through the request pool, with nothing applied; and it completes through `runWithDb`.
- **Red check (round 1):** with the request pool put back, the configuration test and the completion test failed.
- **Not proven:**
  - the 60s lock-timeout path;
  - the 15 min cap, the 16 min backstop, the 10s connect timeout;
  - the compiled entrypoint inside the container.
- **Caveat:** under Compose, the API healthcheck (`start_period` 20s, then 10 failures 5s apart) would report the container unhealthy about 70s into startup. That would fail the client's `service_healthy` dependency while a longer migration keeps running. This follows from Docker's healthcheck rules; it hasn't been run. The README now says so.

**AUD-03 and AUD-04: the example client ignored SIGTERM and listen errors**
- **Status:** Fixed in code (round 1). The container-level effect is not observed.
- **Files:** `client/src/server.ts`.
- **Fix:**
  - SIGTERM and SIGINT close the server and exit 0, with a forced exit after 5s.
  - Express 5's listen error exits 1 with `could not listen on port …`.
  - The log prints the bound port.
- **Tests:** `tests/client-server.db.test.ts` runs the real client process: exit 0 on SIGTERM; exit 1 on a taken port.
- **Red checks (round 1):** without the handlers, the SIGTERM test failed with `{ code: null, signal: 'SIGTERM' }`. With the error branch disabled, the listen test failed.
- **Not covered:** the SIGINT path and the 5s forced exit are untested.
- **Assumption, not verified:** that the in-process handler alone fixes `docker compose stop client` inside the container. A PID-1 process with a registered handler does receive SIGTERM, which is why no Compose `init: true` was added. **NOT RUN**: it needs a rebuild and a container stop.

**AUD-05: the root typecheck didn't cover `client/src/server.ts`**
- **Status:** Fixed (round 1). Fresh-install verification was done in round 2.
- **Files:**
  - `tsconfig.json`: `client/src` in `include`.
  - `README.md`, `CLAUDE.md`: the command description.
- **Fix:** `npm run typecheck` covers all three client files. The build config still compiles `src/` only.
- **Fresh-install verification (round 2, replaces round 1's symlinked check):**
  1. `git archive HEAD`, with the changed files overlaid, into the scratchpad.
  2. `npm ci --prefer-offline` at the root only: 260 packages, and `client/node_modules` absent.
  3. `npm run typecheck` (exit 0) and `npm run lint` (exit 0).
  4. Red check in that export only: an appended `const x: number = "…"` in `client/src/server.ts` made `npm run typecheck` fail with TS2322 (exit 2).
- **Test:** `tests/typecheck-scope.test.ts` (2 tests). It checks **scope** (every `.ts` file under `src/`, `tests/`, `client/src/` is in the typecheck; the build lists only `src/`). Red check: the old `tsconfig.json` failed it.
- **Limit:** a type *error* fails `npm run typecheck`, not `npm test`, and there is no CI.
- **Note:** the root check uses the root compiler options. The client image still builds with `client/tsconfig.json`, which also passes.

**AUD-23: `load/run.sh` didn't record the commit, the dirty state or the image (QA F11)**
- **Status:** Implemented (round 2, at your request). Not exercised by a real load run.
- **Files:**
  - `load/provenance.sh` (new, sourced by `run.sh`).
  - `load/run.sh`: lines 2–5 header, 21–22 `source`, the env block.
  - `docs/LOAD_TEST.md` §2 and three tense corrections in §9.
  - `README.md` "Reproduce".
- **New `env.txt` fields:**
  - `git_commit`
  - `git_tracked_changes`: tracked files modified or staged; untracked files never count.
  - `git_untracked_files`: excluding `load/results/`, so the run's own output, written before `env.txt`, isn't counted.
  - `api_image`
  - `api_image_created`
- **Failure handling:**
  - Without git, or outside a checkout, all git fields read `unknown`, not 0.
  - These metadata commands, new or existing, go through `meta`: `nproc`, `free` (via `host_memory`), `docker version`, `docker compose version`, the k6/db image lookups, the three `docker compose exec` calls, `git` and `docker inspect`. `meta` prints `unknown` on failure or empty output and lets the command's stderr reach `-run.txt`.
  - Two are not wrapped: `date -u` (`load/run.sh:67`) and the PostgreSQL settings query (`load/run.sh:82-84`). If that query fails, `set -e` aborts the run: a visible failure, not an `unknown` field.
  - `git status` runs with `GIT_OPTIONAL_LOCKS=0`, so recording writes nothing to the repository.
- **Format:** when the commands succeed, existing fields should be unchanged. That is a code-reading conclusion, not run through `run.sh`.
  - **Exercised read-only:** `host_cpus`, `host_mem_total_mib`, `host_swap_used_mib`, `k6_image` and `db_image`. Their output has the same form as in the existing `hot-account-84e77ce8-env.txt`.
  - **Not exercised:** `docker`, `compose`, `api_node`, `api_workers_env` and `api_node_processes`.
  - **Known difference:** `api_node_processes` now reads `unknown` instead of `0` if no `node` process is found, because `grep -c` exits 1 on zero matches.
  - **`compare.sh`:** it parses only `run_id`, `SUMMARY_JSON` and `k6 fresh=`, so by code reading it is unaffected. Not run.
- **Not added:** a Docker source-revision label. The build has no revision input today, and adding one is a Dockerfile/Compose change outside this item. Without it, the image ID doesn't prove the source commit, as `docs/LOAD_TEST.md` §2 and `run.sh` say.
- **Older results:** not backfilled.
- **Tests:** `tests/load-provenance.test.ts`, 16 tests. Every function runs under `set -euo pipefail` with stubbed `docker`, throwaway git repositories in temp directories, and controlled PATHs.
  - Covered: modified/staged/deleted/ignored files, new result files, a modified tracked result file, git missing, not a checkout, no index write, `docker inspect` failing / empty / partly failing, the compose image lookup, `meta`, `free` missing.
  - Red checks: removing the `load/results/` exclusion failed 2 tests; reporting git-missing as 0 failed 2; removing `GIT_OPTIONAL_LOCKS=0` failed 1.
  - That last one was first **vacuous** (a content change doesn't make `git status` write the index). It was fixed to a stat-only change, and then failed as intended.
- **Read-only exercise on this machine:** the functions run against the real checkout and the running API container printed:
  - `git_commit b454b819…`, `git_tracked_changes 11`, `git_untracked_files 10`
  - `api_image sha256:b1038f…`, `api_image_created 2026-10-20T20:29:48+03:00`
  - `.git/index` unchanged, `load/results/` unchanged.
- **Not run:** `run.sh` itself.

**AUD-02: a decision that commits late is listed behind newer entries**
- **Status:** Confirmed and documented; no code change.
- **Files:**
  - `tests/requests.db.test.ts`: test "a decision that commits late", extended in round 2.
  - `README.md` "History isn't a change feed": rewritten in round 2. Also the "Cursor pagination" decision.
- **Reproduction:** deterministic, with no sleeps. An uncommitted insert of alice's usage row holds request A after its clock read, while B commits.
  - The history goes from `[b, c, d]` to `[b, late, c, d]`.
  - A poller that stops at a seen entry misses `late`.
  - **Round 2:** a cursor traversal whose first page `[b, c]` was read before the commit gets only `[d]` next, so it misses `late` too.
  - It passed 3 out of 3 targeted runs after the extension, and both round-2 full suites.
- **README correction (round 2):**
  - Round 1's text said "Paging with `cursor` is unaffected" and that `createdAt` "is read when the request arrives". **Both were inaccurate.**
  - The clock is read after the key, user and `requestId` lookups (`consume.service.ts:76`).
  - The commit can follow it by up to about 11s: a 2s pool wait plus 3s at each of three lock waits.
  - A traversal whose cursor has passed the entry misses it.
- **Why no code change:** moving the clock read or adding a commit-order column changes the documented "one clock read per request" decision (which picks the usage month) or the schema. That needs your approval.

### Closed with tests only (no production change)

**AUD-15: no concurrent test where the user's monthly limit decides**
- **Status:** Fixed (round 1).
- **Test:** `tests/consume.db.test.ts`, "60 parallel consumes race at the user monthly limit".
- **What it asserts:**
  - exactly 50 accepted and 10 rejected;
  - the accepted `remaining.user` values are exactly 0, 20, …, 980;
  - every rejection is exactly `MONTHLY_LIMIT_EXCEEDED` / `USER` / limit 1,000 / `{account: 9000, user: 0}`;
  - user and account usage are both 1,000;
  - 60 request rows, each matching its response; accepted units sum to 1,000; the invariant holds.
- **Why it can't flake:** the account row lock serializes every decision.

**AUD-16: the client's HTTP route and page were untested**
- **Status:** Fixed (round 1). Browser rendering is unverified.
- **Files:** `tests/client-server.db.test.ts`, `tests/helpers/process.ts`.
- **Tests:** the real client process on `PORT=0`, with real `fetch`:
  - `GET /` returns the page with the Run demo button;
  - `POST /demo/run` returns 502 when the API is unreachable;
  - `POST /demo/run` returns 200 with all 14 steps `ok` against an in-process API on `quota_test`.
- **Cleanup:** every child is SIGKILLed in `afterEach`, even when an assertion fails. The API server and pool are closed in `afterAll`.
- **Limits:**
  - The client runs under tsx from source, not the image's compiled `dist/`.
  - **Browser verification: NOT RUN.**

**AUD-17: restart persistence wasn't automated**
- **Status:** Partly fixed (round 1). Covers a restart of the API source process under tsx.
- **Test:** `tests/restart.db.test.ts`, which implements TEST_PLAN TP-PERS-01.
  - Two real API processes on `quota_test`. The first must exit 0 on SIGTERM; then 8 reads are deep-equal after the restart, `p-1`/`p-2` replay with their original bodies, and the invariant holds.
  - It calls `resetDatabase()` on `quota_test` only. The suite refuses any database not ending in `_test`.
- **Limits:**
  - It doesn't cover a PostgreSQL or Compose restart (TP-PERS-02/03, **NOT RUN**).
  - Both processes run the TypeScript source (`src/server.ts`) under tsx. The compiled `dist/server.js` and the container entrypoint weren't restarted, so persistence of the built image is not verified.
  - It uses the real clock, so a run that crosses a UTC month boundary mid-test would fail (assumed rare; not observed).

**AUD-20: rules changing under concurrency** (correctness coverage only)
- **Status:** Partly fixed. Integration coverage is extended (rounds 1 and 2) and the invariant-SQL caveat is documented. The load scenario is deferred.
- **Files:** `tests/consume.db.test.ts`; `load/check-invariants.sql` (comment only).
- **Tests:**
  - **Round 1:** a user plan switch racing 30 consumes. Every decision must match the plan it recorded, and every decision on the new plan must count all units accepted on the old one, so lock order holds whichever way the race goes.
    - A scratch probe (5 runs) measured 14, 20, 21, 15 and 16 of 30 accepted, so this race really interleaves.
  - **Round 2:** an account plan switch and a custom user plan PATCH, each committed while 8 consumes queue on the account row behind a held lock. Every queued consume must be decided by the **new** plan.
    - First drafts of these two as plain races were measured and found one-sided: 0 of 30 accepted in 5 out of 5 runs. They were replaced by the queued form before being recorded.
    - **Red check (targeted run, not the full suite):** with the plan read (step 7) temporarily moved before the lock, `npx vitest run` on `tests/consume.db.test.ts`, `tests/requests.db.test.ts`, `tests/usage.db.test.ts` and `tests/demo.db.test.ts` reported `2 failed | 113 passed (115)`. The 2 failures were the queued tests.
    - So within those four files, **no earlier test guarded PLAN.md's "plans read after the lock" decision**; now two do. The other 28 test files weren't run with this change, so whether any of them would have caught it is not verified.
  - The pre-existing account PATCH race test wasn't measured for interleaving.
- **Invariant SQL:** checks 2 and 3 compare usage against the *current* plan. A probe on `quota_test` showed a false positive after a legitimate limit reduction (`user_over_limit = 1`). No recorded run changes a plan. The precondition is documented in the SQL header; the query is unchanged (load-evidence format, TEST_PLAN D6).
- **Deferred:** a k6 scenario with rule changes. It needs load runs and checks that know which limit was in force.

### Deferred, pending your decision

| Finding | Why it isn't changed | Proposed change |
|---|---|---|
| AUD-06: ports on all interfaces, default DB credentials | Deployment intent isn't clear. The brief asks only for a working local Compose setup, and the README shows `localhost` URLs, but nothing says other machines must not reach the stack (e.g. a reviewer's VM). Left unchanged | `127.0.0.1:` prefixes on the three `ports` entries. Then rerun the suite (`localhost` may resolve to `::1` first) and add a `compose.test.ts` `host_ip` assertion |
| AUD-20 (load part) | Needs new load runs | One VU PATCHes small custom plans while others consume. Record each PATCH time and limit, and check each accepted row against the limit in force at its `created_at`, instead of checks 2 and 3 |
| AUD-21: LOAD_TEST §9 cites 33 untracked files | Your data: left untouched and untracked. The docs are accurate: README:1348 and LOAD_TEST §9 say the files are untracked and missing from a clone. The new LOAD_TEST §2 text says no existing run has provenance fields | Commit them with explicit paths, or leave them local |
| AUD-22: TP-LOAD-04 below its internal criterion | Needs a load run | Rerun after approval |
| TEST_PLAN D6, `record()` part | Only the `run.sh` provenance half of D6 is implemented. The k6 status counters and `Retry-After` checks in `load/lib.js` are not | As in TEST_PLAN §5 D6 |
| AUD-10, -11, -13, -14 (digest pins, restart policy, API host port, `.dockerignore`) | Docker setup changes. `.dockerignore` can only be verified by an image build | Audit report §13 item 10 |
| AUD-08: `nosniff`, server timeouts | Optional hardening of public behavior; no concrete defect | Owner's call |
| AUD-09: dev-only `esbuild` advisory via `drizzle-kit` | Dependency upgrade; production dependencies have 0 findings | Upgrade when convenient |

### Not actionable

| Finding | Reason |
|---|---|
| AUD-07: public, un-rate-limited `POST /accounts` | Locked decision, PLAN.md §6; documented at README:1344 |
| AUD-12: `/healthz` shares the request pool | By design; nothing acts on health after startup |
| AUD-18: no CI; `compose.test.ts` skips silently without Docker | New infrastructure, outside this remediation |
| AUD-19: timing thresholds in the lock-timeout test | Passed in all 5 full suites run (the audit's, 2 in round 1, 2 in round 2) |
| M-01, M-02 | No defect |

### Documentation discrepancies (audit §11)

| ID | Outcome |
|---|---|
| DOC-01: QA_REPORT §7 "images weren't rebuilt" | Not edited: true when written; historical |
| DOC-02: CLAUDE.md "Phase 6 … awaiting review" | Not edited: the developer's status line. Flagged |
| DOC-03, DOC-04 | Not edited: accurate as dated |
| DOC-05: README "A cursor keeps its position" | Made precise in round 2 (never repeats, never skips an entry committed before the traversal reached it; late commits are the exception) |
| DOC-06, DOC-07 | No change needed / the developer ticks PLAN.md |
| `npm run typecheck` description | Updated in README and CLAUDE.md (round 1) |
| LOAD_TEST §9 "`run.sh` doesn't record the commit" (3 places) | Put in the past tense in round 2, now that `run.sh` records it for new runs. The meaning for those runs is unchanged |

## 2. Requirement status changes since the audit

| ID | Audit status | Now | Basis |
|---|---|---|---|
| RQ-35: data survives a restart | Unable to Verify | Verified for a restart of the **API source process** (`src/server.ts` under tsx). Unable to Verify for the compiled image or container entrypoint, a PostgreSQL restart, or a Compose restart | `tests/restart.db.test.ts` |
| RQ-40: page displays decisions | Unable to Verify (visual) | Unchanged: tested over HTTP, not rendered | `tests/client-server.db.test.ts` |
| RQ-43: fresh-clone `docker compose up --build` | Unable to Verify | Unchanged. Only a fresh **npm** install with typecheck and lint was verified | §1 AUD-05 |
| RQ-44: init at startup | Fully Implemented | Unchanged; the AUD-01 risk is fixed, with the Compose healthcheck caveat | §1 AUD-01 |
| RQ-47: correct as rules change, concurrently | Partially Implemented | Partially Implemented: integration-level coverage of switches and PATCHes at both levels; no load-level evidence | §1 AUD-20 |
| RQ-48: reproducible performance results | Partially Implemented | Partially Implemented: future runs record provenance (AUD-23), but §9's evidence is still untracked (AUD-21) and no run with the new fields exists | §1 AUD-23 |

## 3. Remaining release risks and owner decisions

1. **The running containers predate every fix.** Rebuilding (`docker compose up -d --build`) recreates the stack. Not done; needs your go-ahead.
2. **Not verified at all:**
   - fresh-clone `docker compose up --build`;
   - persistence across a PostgreSQL or Compose restart;
   - the demo page rendered in a browser;
   - the client's stop time inside its container;
   - the maintenance pool inside the entrypoint;
   - any `run.sh` run with the new provenance fields.
3. **A migration longer than about 70s** passes the new timeouts but would trip the Compose healthcheck (inference; README documents it).
4. **Type errors only fail `npm run typecheck`,** which isn't part of `npm test`, and there is no CI.
5. **Decisions needed:** AUD-06 (port binding), AUD-21 (commit the 33 files or not), AUD-02 code change (or keep it documented), AUD-20 and TP-LOAD-04 load runs, the D6 `record()` counters, and the Docker hardening items.
6. **Everything is uncommitted.** Commit with explicit paths (never `git add .`, which would also pick up the 33 untracked result files).

## 4. Verification evidence

### 4.1 Round 1, as recorded then (superseded counts)

| # | Command | Exit | Outcome |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 | includes `client/src` |
| 2 | `npm run lint` | 0 | clean |
| 3 | `cd client && npx tsc --noEmit -p tsconfig.json` | 0 | clean |
| 4 | `npx tsc -p tsconfig.build.json --outDir <scratchpad>` | 0 | 37 files |
| 5 | `cd client && npx tsc -p tsconfig.json --outDir <scratchpad>` | 0 | compiles |
| 6 | Fresh export with the root `node_modules` symlinked in, no `client/node_modules`: `tsc --noEmit` | 0 | superseded by round 2's real `npm ci` |
| 7 | `env -u WORKERS -u TEST_DATABASE_URL REQUIRE_DB=1 npx vitest run`, twice | 0, 0 | 31 files, 576 passed, both times |
| 8 | Targeted reruns of the new tests | 0 | passed |
| 9 | Red checks AUD-01, -03, -04, -05 | — | each failed without its fix |
| 10 | `docker compose config -q` | 0 | valid |
| 11 | `git diff --check` | 0 | clean |
| 12 | `load/results/` sha256, before and after | — | identical |

### 4.2 Round 2, on the final tree

| # | Command | Exit | Outcome |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 | clean |
| 2 | `cd client && npx tsc --noEmit -p tsconfig.json` | 0 | clean |
| 3 | `npm run lint` | 0 | clean (covers `tests/` and `load/*.js`; `load/provenance.sh` is shell) |
| 4 | `npx tsc -p tsconfig.build.json --outDir <scratchpad>` | 0 | 37 files. `dist/` not touched; it now differs from `src/`, as expected |
| 5 | `cd client && npx tsc -p tsconfig.json --outDir <scratchpad>` | 0 | compiles |
| 6 | Scratch export of the final tree: `npm ci --prefer-offline` (root only), then `npm run typecheck`, `npm run lint` | 0, 0, 0 | 260 packages; no `client/node_modules` |
| 7 | Same export, with a type error appended to `client/src/server.ts`: `npm run typecheck` | 2 | TS2322 reported |
| 8 | `bash -n load/run.sh`, `bash -n load/provenance.sh` | 0 | syntax ok. `shellcheck` isn't installed: **NOT RUN** |
| 9 | `npx vitest run tests/load-provenance.test.ts tests/load-duration.test.ts` | 0 | 55 passed (`run.sh` still reaches its argument checks after sourcing) |
| 10 | Red checks on `load/provenance.sh` (no `load/results/` exclusion; git-missing as 0; no `GIT_OPTIONAL_LOCKS`) | — | 2, 2 and 1 failures; restored and compared with `cmp` |
| 11 | Late-commit test ×3; plan-change tests (`-t plan`) ×5 | 0 | all passed |
| 12 | Red check: plan read moved before the lock, on `consume`, `requests`, `usage`, `demo` tests | — | exactly the 2 queued tests failed, 113 passed; `consume.service.ts` restored, `git diff` empty for it |
| 13 | Scratch probes on `quota_test` (race interleaving; invariant check 3) | 0 | §1 AUD-20 |
| 14 | Provenance functions, read-only, against the real checkout and API container | 0 | §1 AUD-23; `.git/index` and `load/results/` unchanged |
| 15 | `docker compose config -q`; `docker compose --profile load config -q` | 0, 0 | valid (the Compose file is unchanged) |
| 16 | `git diff --check` | 0 | clean |
| 17 | `env -u WORKERS -u TEST_DATABASE_URL REQUIRE_DB=1 npx vitest run`, twice | 0, 0 | **Test Files 32 passed (32), Tests 594 passed (594)**, 102.0s and 101.1s. 0 skipped. That's 576 plus load-provenance 16 and the 2 queued plan-change tests |
| 18 | sha256 of all 400 `load/results/` files against the pre-remediation snapshot | — | identical; 33 still untracked |

**NOT RUN, in either round:**
- load tests, k6 and `run.sh`;
- Docker image builds;
- container stop, restart or recreate;
- fresh-clone `docker compose up --build`;
- browser rendering;
- `shellcheck`.

### 4.3 Round 1 claims corrected in round 2

| Round 1 claim | Correction |
|---|---|
| README: `createdAt` "is read when the request arrives"; "Paging with `cursor` is unaffected" | Inaccurate. The clock is read after three lookups, and a cursor that has passed a late entry misses it. Rewritten; the test now proves the cursor case |
| AUD-05: "a fresh clone needs only the documented root `npm install`" | Was based on symlinked `node_modules`. Now verified with a real `npm ci` |
| AUD-03: "`init: true` isn't needed" | Restated as an assumption; not verified in a container |
| AUD-01 omitted the Compose healthcheck window | Added to README and §1 |
| AUD-23 proposal (`git status --porcelain \| wc -l`, plain `docker inspect`) | Flawed: it counted the run's own new files and read 0 without git. Replaced by the implementation in §1 |

## 5. Files changed (all uncommitted)

| File | Round | Change |
|---|---|---|
| `src/db/client.ts` | 1 | `MAINTENANCE_TIMEOUTS`, `createMaintenancePool()` |
| `src/scripts/run-with-db.ts` | 1 | migrate and seed use the maintenance pool |
| `client/src/server.ts` | 1 | SIGTERM/SIGINT shutdown, listen-error exit, bound port in the log |
| `tsconfig.json` | 1 | `client/src` in the typecheck |
| `load/run.sh` | 2 | sources `load/provenance.sh`; provenance fields; `meta` on every metadata command |
| `load/provenance.sh` (new) | 2 | `meta`, `git_provenance`, `image_provenance`, `compose_image`, `host_memory` |
| `load/check-invariants.sql` | 1 | comment only: the precondition of checks 2 and 3 |
| `tests/global-setup.ts` | 1 | migrates `quota_test` with the maintenance pool |
| `tests/consume.db.test.ts` | 1, 2 | user-limit race (AUD-15); user plan switch race (1); queued account switch and user PATCH (2) |
| `tests/requests.db.test.ts` | 1, 2 | late-commit characterization; cursor case added in 2 |
| `tests/maintenance-pool.db.test.ts` (new) | 1 | AUD-01 |
| `tests/client-server.db.test.ts` (new) | 1 | AUD-16, AUD-03, AUD-04 |
| `tests/restart.db.test.ts` (new) | 1 | AUD-17 (TP-PERS-01) |
| `tests/typecheck-scope.test.ts` (new) | 1 | AUD-05 |
| `tests/load-provenance.test.ts` (new) | 2 | AUD-23 |
| `tests/helpers/process.ts` (new) | 1 | spawn helper for the process tests |
| `README.md` | 1, 2 | typecheck scope; maintenance pool + Compose caveat; cursor guarantee; "History isn't a change feed" (rewritten in 2); provenance fields |
| `CLAUDE.md` | 1 | typecheck scope (one line) |
| `docs/LOAD_TEST.md` | 2 | §2 provenance fields; tense of three §9 F11 lines |
| `docs/FINAL_AUDIT_REMEDIATION.md` (new) | 1, 2 | this record |
| `docs/FINAL_AUDIT_REPORT.md`, `docs/FINAL_AUDIT_CHECKLIST.md` | 1, 2 | dated pointers to this record; audit-time content unchanged |
