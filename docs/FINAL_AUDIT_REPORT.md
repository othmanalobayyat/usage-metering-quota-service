# Final Audit Report: Usage Metering and Quota Service

| | |
|---|---|
| Audit date | 2026-10-21 |
| Commit audited | `b454b81` (`main`, equal to `origin/main` per `git ls-remote`) |
| Working tree | No tracked changes, nothing staged. 33 untracked files in `load/results/`, treated as user data and left alone |
| Method | Code reading, plus the non-destructive checks in §6. No load test, migration against the dev database, Compose restart, volume operation or fresh-clone build was run |
| Fixes applied | None. This is the audit-first pass (§13 lists proposed fixes) |
| Remediation (later, same day) | See [FINAL_AUDIT_REMEDIATION.md](FINAL_AUDIT_REMEDIATION.md). This report is kept as written at audit time; statuses and evidence here describe `b454b81` before any fix |

Labels used throughout: **[Executed]** means I ran it and saw the result. **[Code]** means a conclusion from reading code. **[Doc]** means the claim comes from the repository's own documents and I didn't re-verify it. **[Inferred]** means a reasoned conclusion that wasn't reproduced.

---

## 1. Executive summary and release recommendation

**Recommendation: GO, with three decisions for you first (§14).** I found no Critical, High or Medium defect. Every explicit requirement in `docs/REQUIREMENTS.md` is implemented. The ones I couldn't re-verify at this commit (fresh-clone start, restart persistence, the page rendered in a browser) are marked Unable to Verify, not passed.

What the evidence shows:

- **The core is correct and well tested.** [Executed] The full suite passed: 27 files, 562 tests, 0 skipped, run with `REQUIRE_DB=1` against `quota_test`. Typecheck, lint, the client typecheck and a build all exit 0. [Code] The consume transaction matches `docs/PLAN.md` §6 step for step: lock order, recheck after the lock, plans read after the lock, the step 12 safety net. I found no code path that can over-consume a quota or break the rule that account usage equals the sum of user usage.
- **Tenant isolation holds.** [Code] Every query filters by `account_id`. The composite foreign keys stop a usage or request row from pointing at another account's user. [Executed] The isolation tests pass.
- **The running Compose stack is built from this commit.** [Executed] The compiled code inside the running `api` and `client` containers is byte-identical (sha256) to a fresh build of HEAD. Both containers run as the non-root `node` user. `/healthz` returns 200 and the client page returns 200.
- **The load-test evidence holds up.** [Executed] Every number I spot-checked in `docs/LOAD_TEST.md` and the README matches the raw `load/results/` files. The write-up states its own anomalies and gaps openly.

What is left (all Low or Informational, none blocking):

- 5 Low code or config defects (AUD-01…AUD-06). The most useful fixes are AUD-01 (migrations run under the 4s request timeouts) and AUD-06 (Postgres published on all interfaces with default credentials).
- Gaps in the evidence: `docs/LOAD_TEST.md` §9 cites 33 untracked files (AUD-21), no load run checks correctness while rules change (AUD-20), and `load/run.sh` doesn't record the commit (AUD-23).
- 7 documentation discrepancies, all minor and mostly stale cross-references (§11).

**Context you should weigh:** the brief's deadline is "End of 20/10/2026". The last commit (`b454b81`) is dated 2026-10-20 22:57 +03:00, and today is 2026-10-21, so any fix applied now would land after that date. Whether that matters depends on your submission rules, which I can't see.

---

## 2. Repository, commit and working-tree state at audit time

[Executed] Commands and observations:

| Check | Result |
|---|---|
| `git status --short` | Only `?? load/results/…`: 33 files. These are the runs `hot-account-84e77ce8`, `hot-account-bc7adbf3` and `many-accounts-06e6a282`, 11 files each |
| `git diff`, `git diff --cached` | Empty |
| `git log --oneline --decorate -10` | HEAD `b454b81 (HEAD -> main, origin/main) docs: clarify QA and load test evidence`. Before it: `9880430`, `6496b8f`, `b5a3486`, `3c39c71`, `1468d11`, `b56dbc0`, `47fa0e7`, `e1ab78e`, `195e113` |
| `git ls-remote origin refs/heads/main` | `b454b819d3f9…`, equal to local HEAD |
| Ignored files | `.claude/`, `client/node_modules/`, `dist/`, `node_modules/`. There is no `.env` file |
| Tracked files | 98 outside `load/results/`, plus 367 tracked result files |
| Large or accidental files | None over 500 KB. `.git` is 4.4 MB. No database dumps or build output is tracked |
| CI | None (no `.github/`) |
| Last change to `src/` | `3c39c71` (2026-10-20 19:17 +03:00). The running API image was built at 20:29 +03:00 the same day |

Integrity check on this audit: I took sha256 checksums of every file in `load/results/` and `dist/`, and saved the `git status --porcelain --ignored` output, before running anything. After every check I compared both again: unchanged. I compiled to the scratchpad directory, not into `dist/`, because `docs/LOAD_TEST.md` §9 cites a sha256 match against the local `dist/`.

---

## 3. Scope

### Read in full, line by line
- **Application:** every file in `src/` (37 files): app, server, config, db (client, schema, migrate, seed), errors, lib, middleware, routes, scripts, services.
- **Schema:** `drizzle/0000_init.sql` and `drizzle/meta/_journal.json`. The Drizzle migrator in `node_modules/drizzle-orm/pg-core/dialect.js` (`migrate()`) was read to check transactionality.
- **Client:** `client/src/{server,quota-api,demo}.ts`, `client/public/index.html`, `client/Dockerfile`, `client/package.json`, `client/tsconfig.json`, `client/.dockerignore`.
- **Ops:** `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml`, `.dockerignore`, `.gitignore`, `.gitattributes`, `.env.example`, `package.json`, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`, `drizzle.config.ts`.
- **Load:** every file in `load/`: k6 scenarios, `lib.js`, `duration.js`, `run.sh`, `compare.sh`, `uncontended.sh`, `uncontended-api.mjs`, the three SQL files.
- **Tests, read in full:** `consume.db`, `rules`, `isolation.db`, `accounts.db`, `users.db`, `plans.db`, `usage.db`, `requests.db`, `schema.db`, `server.db`, `demo.db`, `compose`, `quota-api`, `healthz`, `healthz.db`, `app`, `config`, `load-duration`, `test-db-helper`, `global-setup`, `helpers/db`, `helpers/api`.
- **Docs, read in full:** `docs/REQUIREMENTS.md`, `docs/PLAN.md`, `README.md` (all 1,418 lines), `docs/LOAD_TEST.md`, `CLAUDE.md`.

### Read partially (stated, not hidden)
- **Tests, structure and test names only, not every line:** `unicode-input.db`, `input-encoding.db`, `dot-segment-ids.test`, `dot-segment-ids.db`, `errors`, `lib`, `month`, `unicode-schemas`. All of them ran and passed.
- **`docs/QA_REPORT.md`:** header and commit-state addenda, §2 summary and findings table, §3.1 matrix rows, §6, §7. Not every individual finding body.
- **`docs/TEST_PLAN.md`:** §5 decisions, §6–§7, and the execution-record lines found by search.
- **`load/results/`:** the `SUMMARY_JSON`, invariant output and `-env.txt` of the 7 runs cited as headline numbers (`e4ff949a`, `6d1621bb`, `6d0745d1`, `c2df73fc`, `84e77ce8`, `bc7adbf3`, `06e6a282`), and the medians blocks of `compare-b94e9fcc.txt` and `compare-66ef619b.txt`. Not every one of the ~400 files.

### Not inspected
- `drizzle/meta/0000_snapshot.json` (generated by `drizzle-kit`).
- `package-lock.json` and `client/package-lock.json` line by line. Their consistency was checked with `npm ls --all` instead.
- `node_modules/` beyond the Drizzle migrator.

---

## 4. Requirements traceability matrix

Source: **B** = original brief (`docs/REQUIREMENTS.md`), **I** = implicit (needed for a brief requirement to hold), **P** = project decision or assumption (`docs/PLAN.md`, README Assumptions). "Ran" means the cited tests ran in my full-suite run [Executed].

### 4.1 Accounts, users, keys, isolation

| ID | Requirement | Src | Implementation | Tests (ran) | Status | Sev. if not full |
|---|---|---|---|---|---|---|
| RQ-01 | Create accounts and issue an API key for each | B | `src/services/accounts.service.ts:20-39`, `src/lib/api-key.ts:6-17` | `accounts.db.test.ts:31-93` ✔ | Fully Implemented | |
| RQ-02 | Register users under accounts | B | `src/services/users.service.ts:30-51` | `users.db.test.ts:38-87` ✔ | Fully Implemented | |
| RQ-03 | Assign or change user plans | B | `src/services/users.service.ts:98-105`, `src/services/plan-guard.ts:30-47` | `users.db.test.ts:124-158` ✔ | Fully Implemented | |
| RQ-04 | Keep each account's users and usage separate | B | `account_id` predicate on every query [Code]; composite FKs `src/db/schema.ts:115-119`, `:153-157` | `isolation.db.test.ts` ✔, `usage.db.test.ts:179-257` ✔, `requests.db.test.ts:283-314` ✔, `schema.db.test.ts:174-200` ✔ | Fully Implemented | |
| RQ-05 | API key in a request header identifies the account | B | `src/middleware/auth.ts:24-40` (`X-API-Key`, SHA-256 lookup) | `accounts.db.test.ts:96-121` ✔ | Fully Implemented | |
| RQ-06 | Reject missing or invalid keys (negative) | B | `src/middleware/auth.ts:27-36` | `errors.test.ts:127-150` ✔, `accounts.db.test.ts:104-113` ✔ | Fully Implemented | |
| RQ-07 | The key grants access only to its own account's data; a supplied user must belong to that account | B | `consume.service.ts:64-68`, `requests.service.ts:44-51`, `usage.service.ts:42`, `plan-guard.ts:10-12` | `isolation.db.test.ts` ✔, `consume.db.test.ts:672-675` ✔ | Fully Implemented | |
| RQ-08 | Another account's resource returns 404, not 403 | P | `plan-guard.ts:36-42`, `plans.service.ts:22-29` | `isolation.db.test.ts:47-124` ✔ | Fully Implemented | |

### 4.2 Plans

| ID | Requirement | Src | Implementation | Tests (ran) | Status | Sev. |
|---|---|---|---|---|---|---|
| RQ-09 | Predefined account and user plans exist at startup, with documented limits | B | `src/db/seed.ts:20-40`, `docker-entrypoint.sh:5-7`, README:1163-1172 | `schema.db.test.ts:79-114` ✔ | Fully Implemented | |
| RQ-10 | Accounts create, view and update custom plans and assign them | B | `src/routes/plans.ts`, `src/services/plans.service.ts` | `plans.db.test.ts` ✔ | Fully Implemented | |
| RQ-11 | Users sharing a plan keep separate totals | B | PK `(user_id, month)`, `schema.ts:113` | `usage.db.test.ts:115-134` ✔, `consume.db.test.ts:392-414` ✔ | Fully Implemented | |
| RQ-12 | Predefined plans read-only (optional in the brief) | B | `plans.service.ts:56-62` | `plans.db.test.ts:163-200` ✔ | Fully Implemented | |
| RQ-13 | Inspect the plans and limits currently applied to an account and to a user | B | `GET /account`, `GET /users/:id` (`accounts.service.ts:42-61`, `users.service.ts:78-95`) | `accounts.db.test.ts:123-147` ✔, `users.db.test.ts:89-103` ✔ | Fully Implemented | |
| RQ-14 | Plan ownership and type enforced on every assignment (no FK can do it) | P | `plan-guard.ts:30-47`, called from `accounts.service.ts:65`, `users.service.ts:31`, `:102` [Code: no other write of `plan_id`] | `isolation.db.test.ts:102-119` ✔ | Fully Implemented | |

### 4.3 Consumption rules

| ID | Requirement | Src | Implementation | Tests (ran) | Status | Sev. |
|---|---|---|---|---|---|---|
| RQ-15 | Consume takes a user ID, a positive whole number of units and a request ID | B | `src/routes/consume.ts:9-13` (`z.int().min(1).max(MAX_INT32)`, strict body) | `consume.db.test.ts:683-738` ✔ | Fully Implemented | |
| RQ-16 | Accept the full amount only if every rule allows; a rejection consumes nothing | B | `rules.ts:56-107`, `consume.service.ts:131-140` | `consume.db.test.ts:172-190` ✔, `rules.test.ts` ✔ | Fully Implemented | |
| RQ-17 | Monthly allowance per UTC calendar month | B | `lib/month.ts:5-16`, `rules.ts:76-87` | `month.test.ts` ✔, `consume.db.test.ts:466-486` ✔ | Fully Implemented | |
| RQ-18 | Maximum units per request, at both levels | B | `rules.ts:64-75` | `rules.test.ts:34-56` ✔ | Fully Implemented | |
| RQ-19 | The brief's worked examples: 25 → user per-request reject; 10 → accepted, +10 on both totals; 5 left on the account → account reject | B | as above | `consume.db.test.ts:98-151` ✔ | Fully Implemented | |
| RQ-20 | A larger user allowance doesn't raise the account's | B | `rules.ts:82-87` | `consume.db.test.ts:153-170` ✔ | Fully Implemented | |
| RQ-21 | Account usage = sum of accepted user usage | B | both increments in one transaction, `consume.service.ts:131-140` | `expectInvariant` in `consume.db.test.ts:84-91` (6 uses) ✔; `load/check-invariants.sql` in every load run [Doc, spot-checked: 0 violations in 7 runs] | Fully Implemented | |
| RQ-22 | Identify a rule that blocked the request and its owner | B | `rules.ts:26-35`, `consume.service.ts:23-33` | `consume.db.test.ts:120-151` ✔ | Fully Implemented | |
| RQ-23 | Rule check order (user per-request → account per-request → user monthly → account monthly) | P | `rules.ts:63-90` | `rules.test.ts:103-154` ✔ | Fully Implemented | |
| RQ-24 | New usage belongs to the UTC month in which it's processed; each month starts at 0; earlier months stay queryable | B | `consume.service.ts:76-77`, `usage.service.ts` | `consume.db.test.ts:230-240`, `:466-486` ✔ | Fully Implemented | |

### 4.4 Plan changes

| ID | Requirement | Src | Implementation | Tests (ran) | Status | Sev. |
|---|---|---|---|---|---|---|
| RQ-25 | Plan changes apply to new requests after the update succeeds, with no redeploy | B | plans read in step 7, after the lock, `consume.service.ts:108-119` | `consume.db.test.ts:350-414` ✔ | Fully Implemented | |
| RQ-26 | Updating a custom plan affects its assigned account or users | B | plan rows referenced by ID | `consume.db.test.ts:369-414` ✔ | Fully Implemented | |
| RQ-27 | Switching plans keeps consumed units (no fresh allowance) | B | usage keyed by account/user and month, not by plan | `consume.db.test.ts:351-367` ✔, `accounts.db.test.ts:151-158` ✔ | Fully Implemented | |
| RQ-28 | Allowance reduced below usage → 0 remaining, reject at that level | B | `max(0, …)`, `rules.ts:92-95` | `consume.db.test.ts:351-383` ✔, `rules.test.ts:239-275` ✔ | Fully Implemented | |
| RQ-29 | Changes preserve past request history | B | snapshot row, `consume.service.ts:142-161` | `consume.db.test.ts:416-463` ✔ | Fully Implemented | (QA F4, Low, still open: plan *limits* aren't snapshotted, only plan IDs. Documented, README:1338) |
| RQ-30 | Correct under concurrent plan updates | B | `READ COMMITTED` + read after the lock; serial-order argument in README:1206-1212 [Code: argument holds] | `consume.db.test.ts:523-548` ✔ | Fully Implemented | |
| RQ-31 | Explain any additional rules and demonstrate them | B | None implemented; a daily cap is described in README:1153-1161 | — | Fully Implemented (nothing to demonstrate) | |

### 4.5 Usage, history, persistence

| ID | Requirement | Src | Implementation | Tests (ran) | Status | Sev. |
|---|---|---|---|---|---|---|
| RQ-32 | Consumed and remaining for the account and each user | B | `src/services/usage.service.ts` | `usage.db.test.ts` ✔ | Fully Implemented | |
| RQ-33 | Previous months' usage and request outcomes; simple pagination | B | `?month`, `src/services/requests.service.ts:42-78` (cursor) | `requests.db.test.ts` ✔ | Fully Implemented | (AUD-02: late-commit ordering, Low) |
| RQ-34 | Store accounts, users, plans, assignments, usage and history in the DB | B | `src/db/schema.ts`; named volume `db-data`, `docker-compose.yml:10-11`, `:67-68` | `schema.db.test.ts` ✔ | Fully Implemented | |
| RQ-35 | Data survives a restart | B | as RQ-34 | No automated test. README:42 says it was checked by hand on an earlier commit | Unable to Verify (at HEAD) | Low (AUD-17) |
| RQ-36 | Usage reads never create rows | P | `leftJoin`, no insert, in `usage.service.ts`, `accounts.service.ts:48-51`, `users.service.ts:84-91` | `usage.db.test.ts:65-71`, `:136-144` ✔ | Fully Implemented | |

### 4.6 Example client and Compose

| ID | Requirement | Src | Implementation | Tests (ran) | Status | Sev. |
|---|---|---|---|---|---|---|
| RQ-37 | A small client that calls the service with an account's key on behalf of its users | B | `client/src/quota-api.ts`, `client/src/demo.ts` | `demo.db.test.ts` ✔ | Fully Implemented | |
| RQ-38 | Users with different plans; an accepted action; a user-limit rejection; a shared account-limit rejection | B | `client/src/demo.ts:109-143` | `demo.db.test.ts` ✔ (every step matched fixed expected values) | Fully Implemented | |
| RQ-39 | Switch a plan and show changed behavior with no client code change | B | `demo.ts:125-139` (same `consume` call before and after) | `demo.db.test.ts` ✔ | Fully Implemented | |
| RQ-40 | Display the decision and remaining allowances | B | `client/public/index.html:97-126` [Code] | Not covered by a test. [Executed] `GET http://localhost:8081/` → 200 text/html; not rendered in a browser | Unable to Verify (visual) | Low (AUD-16) |
| RQ-41 | Instructions for running the example | B | README:44-60 | — | Fully Implemented | |
| RQ-42 | Compose file with service, PostgreSQL and client | B | `docker-compose.yml` | `compose.test.ts` ✔ (config only). [Executed] `docker compose config -q` → 0; running containers byte-identical to HEAD | Fully Implemented | |
| RQ-43 | `docker compose up --build` from a fresh clone, with no manual steps | B | entrypoint migrate → seed → start | Not run (§12). QA R59 verified `47fa0e7` plus a patch [Doc] | Unable to Verify (at HEAD) | Low |
| RQ-44 | DB initialization and predefined plans handled at startup | B | `docker-entrypoint.sh:5-7` | seed tests ✔; [Executed] running API healthy | Fully Implemented | (AUD-01 for future migrations) |
| RQ-45 | Document required configuration and how to reach the client | B | README:24-106 | — | Fully Implemented | |

### 4.7 Performance, reliability, deliverables

| ID | Requirement | Src | Implementation | Evidence | Status | Sev. |
|---|---|---|---|---|---|---|
| RQ-46 | Test under load, include evidence, explain method and lessons | B | `load/`, `docs/LOAD_TEST.md` | §1–§8 runs committed; numbers spot-checked [Executed] | Fully Implemented | |
| RQ-47 | Totals and decisions stay correct "as rules change and requests arrive concurrently" | B | lock design | Concurrency plus a plan change: integration test only (30 consumes, `consume.db.test.ts:523-548`). No load run changes a rule or nears a limit (`LOAD_TEST.md:236`) | Partially Implemented | Low (AUD-20) |
| RQ-48 | Commit the tests, scripts, tools and config needed to reproduce performance results | B | `load/*` committed | §9 cites 33 untracked files; the scripts don't record the commit | Partially Implemented | Low (AUD-21, AUD-23) |
| RQ-49 | Understand bottlenecks; improvements that preserve correctness | B | `LOAD_TEST.md` §4, §6, §8 | `WORKERS` measured in 2 sessions; the invariants held in all 28 runs [Doc; medians spot-checked] | Fully Implemented | (QA F7: no implemented hot-account fix) |
| RQ-50 | Safe retries, competing requests, useful errors | B | idempotency steps 2/6/12; 503 mapping, `errors.ts:59-68` | `consume.db.test.ts:212-348`, `:551-659` ✔ | Fully Implemented | |
| RQ-51 | README covers API, model, keys, rules, plan changes, retries, assumptions, design, limitations | B | README | read in full | Fully Implemented | |
| RQ-52 | Automated tests incl. API key validation and account isolation | B | `tests/` | 562 passed [Executed] | Fully Implemented | |

### 4.8 Implicit and negative requirements

| ID | Requirement | Src | Implementation | Tests (ran) | Status |
|---|---|---|---|---|---|
| RQ-53 | No integer overflow in usage totals | I | input max `MAX_INT32`; an increment is accepted only when `used + units ≤ limit ≤ MAX_INT32` [Code] | `consume.db.test.ts:734-738`, `plans.db.test.ts:53-58` ✔ | Fully Implemented |
| RQ-54 | Malformed input is never a 500 (JSON, charset, invalid UTF-8, NUL, lone surrogates, bad percent-encoding, dot segments) | I | `app.ts:30-37`, `lib/schemas.ts:19-44`, `middleware/errors.ts:14-58` | `input-encoding.db`, `unicode-*`, `dot-segment-*`, `errors.test` ✔ | Fully Implemented |
| RQ-55 | A 500 exposes no internals | I | `middleware/errors.ts:70-71` | `errors.test.ts:57-64` ✔ | Fully Implemented |
| RQ-56 | A quota rejection is a 200 decision, not an error | P | `routes/consume.ts:19-22` | `consume.db.test.ts:120-132` ✔ | Fully Implemented |
| RQ-57 | Billing, refunds, multiple resource types, end-user login, RBAC, distributed infra are out of scope | B (negative) | none present [Code] | — | Fully Implemented (correctly absent) |

### 4.9 Internal acceptance criteria (not brief requirements)

| ID | Criterion | Source | Result |
|---|---|---|---|
| IC-01 | TP-LOAD-04: one hot-account run after the F10 fix, RPS in 85.2–103.3 req/s | `docs/TEST_PLAN.md` §4.8 | **Not met**: 77.3 req/s (`hot-account-84e77ce8`, untracked). Correctness and error criteria met. [Executed: numbers match the raw file.] `docs/REQUIREMENTS.md` sets no throughput minimum |
| IC-02 | PLAN Phase 8: fresh clone, run the README end to end, trace a request out loud | `docs/PLAN.md` | Unticked in PLAN.md. Not done in this audit |

**Totals (57 brief, implicit and project rows):** Fully Implemented 52 · Partially Implemented 2 (RQ-47, RQ-48) · Missing 0 · Unable to Verify 3 (RQ-35, RQ-40, RQ-43). One row (RQ-31) is Fully Implemented with nothing to demonstrate.

---

## 5. Findings

Every finding is present in the current commit `b454b81` unless marked otherwise. None is only in local changes, because there are none.

### 5.1 Confirmed defects

**AUD-01: Migrations and seed run under the request-path timeouts**
- **Severity:** Low · **Confidence:** Confirmed [Code]
- **Location:** `src/scripts/run-with-db.ts:14` calls `createPool()`, which sets `statement_timeout` 4s, `lock_timeout` 3s and `query_timeout` 5s (`src/db/client.ts:5-19`). `docker-entrypoint.sh:5` runs it with `set -e`.
- **Failure scenario:** A future migration builds an index or rewrites a populated table and runs longer than 4s. One example is the index the README proposes for the user+month history query (README:1336). Postgres cancels it (57014). Drizzle's migrator rolls the whole transaction back (verified in `drizzle-orm/pg-core/dialect.js` `migrate()`), `migrate.js` exits 1, and the API container never starts. A migration that waits more than 3s for a table lock fails the same way.
- **Impact:** RQ-44 (initialization on startup), for any future schema change. The current single migration runs on an empty database and is unaffected.
- **Fix:** let `runWithDb` build a pool without the three timeouts, for example an options argument to `createPool`.
- **Regression test:** a unit or integration test that the migration pool reports `statement_timeout = 0`, or a temporary migration folder with `select pg_sleep(5)` that must succeed.
- **Blocks release:** No.

**AUD-04: The example client ignores listen errors**
- **Severity:** Low · **Confidence:** Confirmed [Code]
- **Location:** `client/src/server.ts:23-25`
- **Failure scenario:** The client runs outside Docker with `PORT` already taken. Express 5 passes `EADDRINUSE` to the callback, which ignores it, logs "listening", and the process stays up without serving. The API fixed exactly this bug (`src/server.ts:43-48`, `LOAD_TEST.md:253`).
- **Impact:** Developer experience only. Inside Compose the port is free.
- **Fix:** take an `err` parameter and exit 1, as `src/server.ts` does.
- **Regression test:** spawn the client on a held port and expect exit 1, mirroring `tests/server.db.test.ts:149-159`.
- **Blocks release:** No.

**AUD-05: The root typecheck doesn't cover `client/src/server.ts`**
- **Severity:** Low · **Confidence:** Confirmed [Code + Executed]
- **Location:** `tsconfig.json:16` includes only `src`, `tests` and two config files. The tests import `client/src/demo.ts` and `client/src/quota-api.ts`, never `server.ts`.
- **Failure scenario:** A type error in `client/src/server.ts` passes `npm run typecheck`, `npm run lint` and `npm test`. It only fails in the client image build during `docker compose up --build`.
- **Evidence:** `cd client && npx tsc --noEmit -p tsconfig.json` exits 0 today [Executed], so there is no current error.
- **Fix:** add `client/src` to the root `include`, or a `typecheck:client` script that `npm run typecheck` chains.
- **Blocks release:** No.

### 5.2 Potential defects needing reproduction

**AUD-02: A decision that commits late can sort behind rows a newest-first reader has already passed**
- **Severity:** Low · **Confidence:** Probable [Code, not reproduced]
- **Location:** `src/services/consume.service.ts:76` reads `created_at` before the pool wait (≤2s), the upserts and the lock wait (≤3s). `src/services/requests.service.ts:68` orders by `created_at DESC, id DESC`.
- **Failure scenario:** On one account, C commits at t0. Request A reads t1, then waits for a pooled connection or the account lock. Request B reads t2 > t1, gets the lock first and commits. A caller lists `/requests` and gets [B, C]. A then commits and sorts between B and C. A caller that polls newest-first and stops at the first row it has seen (B) never sees A. Ordinary page-by-page traversal isn't affected, and neither are usage totals or decisions.
- **Impact:** History completeness for incremental consumers. The brief asks only for "simple pagination", so no requirement is violated. README:1309 already says history is in arrival order, not decision order, but not this consequence. README:1253 ("A cursor keeps its position") is accurate but could be read as a change-feed guarantee.
- **Fix (recommended, docs only):** one sentence in README "Usage and history": newest-first paging is not a change feed, and an entry can appear up to about 5s behind newer ones.
- **Alternative (needs approval):** a commit-order column. It changes the schema and the locked "one clock read per request" decision.
- **Regression test (if code changes):** a 1-connection pool holds A after its clock read while B commits through another pool, then assert the listing order.
- **Blocks release:** No.

**AUD-03: The example client container ignores SIGTERM**
- **Severity:** Low · **Confidence:** Probable [Code + known PID-1 behavior. Not run, because it would stop your running container]
- **Location:** `client/Dockerfile:18` (`CMD ["node", "dist/server.js"]`). `client/src/server.ts` has no signal handler. `docker-compose.yml:43-52` has no `init: true`.
- **Failure scenario:** On `docker compose stop` or `down`, Node is PID 1 with no SIGTERM handler, so the kernel drops the signal. Docker waits the default 10s grace, then sends SIGKILL. Every stop of the stack takes at least 10s for the client.
- **Impact:** Operational only. The client is stateless.
- **Fix:** `init: true` on the `client` service, or a SIGTERM handler that closes the server.
- **Regression test:** an e2e check that `docker compose stop client` finishes in under 2s.
- **Blocks release:** No.

### 5.3 Security vulnerabilities and hardening

No exploitable vulnerability was found in the API. Details in §7.

**AUD-06: Postgres, the API and the client are published on all host interfaces, and the DB uses default credentials**
- **Severity:** Low (hardening) · **Confidence:** Confirmed [Code]
- **Location:** `docker-compose.yml:9`, `:30`, `:49`; credentials at `:5-7`.
- **Failure scenario:** The laptop is on a shared network. Anyone who can reach it connects to `<host>:5433` as `quota`/`quota` and can read or write every account, plan, usage row and API key hash. They can also call the client's unauthenticated `POST /demo/run` on `:8081` to create accounts.
- **Impact:** This is a local development stack, as the brief intends, so it's hardening, not a vulnerability in the service.
- **Fix:** `"127.0.0.1:${DB_PORT:-5433}:5432"`, and the same for 3000 and 8081.
- **Blocks release:** No.

**AUD-07 (Info):** `POST /accounts` is public and not rate-limited. This is a locked decision in PLAN.md §6 and is documented at README:1344. No change recommended.

**AUD-08 (Info):** The API sends no `X-Content-Type-Options: nosniff` and uses Node's default server timeouts. The API serves JSON only and needs no CORS (every client call is server to server). Hardening only.

**AUD-09 (Info):** [Executed] `npm audit` reports 0 production vulnerabilities for the API and the client. Including dev dependencies, the API has 4 moderate findings, all through `drizzle-kit` → `esbuild` and its old loader packages. They are dev-only: [Executed] the runtime image layers show `npm ci --omit=dev`, and `drizzle-kit` is used only for `generate`. The audit database is the npm registry at the time of the run, and nothing was upgraded.

**AUD-10 (Info):** The base images aren't pinned to a digest (`node:22-alpine`, `postgres:16`). A rebuild can pick up a different patch release than the `api_node v22.23.3` recorded in the load runs. `grafana/k6:1.3.0` is pinned.

### 5.4 Requirements not fully satisfied

**AUD-20: Correctness while rules change is not exercised under load** (RQ-47)
- **Severity:** Low · **Confidence:** Confirmed [Code + Doc]
- **Location:** `load/lib.js:20-21`: allowances of 2,000,000,000 units, so no run rejects anything. No scenario sends `PATCH /plans` or a plan switch. `docs/LOAD_TEST.md:236-237` acknowledges this.
- **Failure scenario:** The brief's "decisions remain correct as rules change and requests arrive concurrently" rests on one integration test with 30 consumes and one PATCH (`consume.db.test.ts:523-548`). That test passes [Executed], but nothing shows it at load-test concurrency, or on the rejected path.
- **Fix:** a k6 scenario with small allowances and a VU that PATCHes the plan periodically, followed by `check-invariants.sql` and a check that no account or user exceeds the limit in force. This requires a new load run, which needs your approval.
- **Blocks release:** No. The integration evidence exists and the design argument (README:1206-1212) holds [Code].

**AUD-21: `docs/LOAD_TEST.md` §9 cites 33 untracked result files** (RQ-48)
- **Severity:** Low · **Confidence:** Confirmed [Executed]
- **Location:** `docs/LOAD_TEST.md:3-5`, `:17-18`, `:396-472`; `git status`.
- **Failure scenario:** A reviewer cloning the repository can't check any number in §9. The README's load summary cites only committed runs (`README.md:1348`), and §1–§8 are fully committed.
- **Fix:** your decision (§14). Either commit the 33 files with explicit paths (never `git add .`), or keep them local and leave §9 as is. It already says the files are untracked.
- **Blocks release:** No.

**AUD-23: `load/run.sh` doesn't record the git commit or dirty state** (QA F11, still open)
- **Severity:** Low · **Confidence:** Confirmed [Code]
- **Location:** `load/run.sh:59-78` (the `env.txt` block).
- **Impact:** No result file can be tied to a commit. §9 had to infer the commit from timestamps (`LOAD_TEST.md:402`). The anomalous `many-accounts-06e6a282` run can't be explained after the fact.
- **Fix:** record `git rev-parse HEAD`, `git status --porcelain | wc -l`, and the API image ID in `env.txt`. These are test scripts, but the change needs approval under TEST_PLAN D6.
- **Blocks release:** No.

**AUD-22 (Info):** The internal throughput criterion TP-LOAD-04 is not met (IC-01): 77.3 req/s against a floor of 85.2. It is one run, with an unknown cause. It's correctly labeled as an internal criterion (`LOAD_TEST.md:452`).

### 5.5 Test-quality findings

**AUD-15 (Low): No concurrent test where the user's monthly limit decides mid-race.** In `consume.db.test.ts:510-521`, 50 parallel requests × 20 units exactly equal Basic's 1,000, so all 50 are accepted and none contends at the boundary. The 10 requests over the limit run only after those finish. Risk is low, because the account lock serializes all of one account's consumes, and the account-limit race (`:489-508`) proves that. Suggested test: 60 parallel × 20 on Basic, expecting exactly 50 accepted and 10 `USER`/`MONTHLY_LIMIT_EXCEEDED`, with the invariant checked.

**AUD-16 (Low): The client's HTTP route and page are untested.** `tests/demo.db.test.ts` calls `runDemo()` directly. `client/src/server.ts` (`POST /demo/run`, static files, 502 on error) and `index.html` rendering are covered by no test (RQ-40). Suggested test: start the client server against the test API, then `POST /demo/run` returns 200 with `ok: true`, and `GET /` contains the `Run demo` button.

**AUD-17 (Low): Restart persistence isn't automated** (RQ-35). README:42 says it was checked by hand on an earlier commit. TEST_PLAN's TP-PERS-01/02 are planned but haven't run.

**AUD-18 (Info): Two kinds of silent skip.** `compose.test.ts` only inspects `docker compose config`, and it skips silently when Docker is missing, because `REQUIRE_DB` doesn't cover it. There is no CI, so `REQUIRE_DB=1` is enforced only by convention. My run used `REQUIRE_DB=1` and had 0 skipped.

**AUD-19 (Info): Timing thresholds can be flaky.** `consume.db.test.ts:593-594` asserts 2.5s ≤ elapsed < 4.5s for the lock timeout. That's reasonable, but it can flake on a heavily loaded host.

Strengths: the assertions are mostly exact `toEqual` on whole bodies, not vacuous ones. Cleanup is safe: `TRUNCATE` runs only on a database whose name ends in `_test` (`tests/global-setup.ts:17-19`), and `DATABASE_URL` is deliberately ignored. The race tests use real concurrency and `pg_stat_activity` waits rather than sleeps. Several tests were shown to fail without their fix (QA rev 3/4 red runs [Doc]).

### 5.6 Performance and reliability risks

**AUD-11 (Info):** No service has a restart policy. [Executed] `RestartPolicy.Name` is `no` for api, client and db. A crashed API, or a host reboot, leaves the stack down.

**AUD-12 (Info):** `/healthz` shares the request pool (`src/app.ts:49`, `src/server.ts:40`). When the pool is saturated (the 200-VU probes), the healthcheck can time out and Docker marks a working API unhealthy. Nothing acts on that status after startup.

**AUD-13 (Info):** The API's host port is fixed at 3000 (`docker-compose.yml:30`), while the DB and client ports are configurable. A second stack, for example an isolated fresh-clone check, can't run next to the dev stack without editing the file. QA R59 had to remap it [Doc].

**AUD-14 (Info):** `.dockerignore` patterns match only at the root, so `client/node_modules` (31 MB), `load/results` (2 MB) and `.claude/` go into the API build context. [Executed] The image layers contain only `dist`, `drizzle`, the entrypoint and production dependencies, so the image is unaffected. Builds are just slower.

Known and documented: one account's consumes serialize on its usage row (QA F7). Requests fail on the 2s pool wait at 200 VUs (now a 503, but the evidence predates that mapping: QA F6).

### 5.7 Maintainability suggestions (non-blocking)

- **M-01:** The pool size isn't configurable (pg's default of 10, `src/db/client.ts:6`). Tuning needs a code change.
- **M-02:** The README's "seed order" for `GET /plans` (README:242) holds only because the four seeded rows share one `created_at` and their fixed IDs sort in seed order (`plans.service.ts:18`). It's correct today but fragile.

### 5.8 Previous QA findings, re-checked against `b454b81`

| QA ID | QA status | Re-check | Current |
|---|---|---|---|
| F1, F2, F10, F12, F13 | Resolved | [Code] fixes present (`errors.ts:14-26`, `schemas.ts:19-44`, `app.ts:30-37`, `load/duration.js`); [Executed] their tests pass | Resolved |
| F3 | Open | [Code] `usage.service.ts:24`: a past month uses the current plan; documented README:1317 | Open (accepted assumption) |
| F4 | Open | [Code] only plan IDs are snapshotted, `consume.service.ts:155-156` | Open (documented README:1338) |
| F5 | Open | [Code] `GET /users` has no usage | Open (documented README:1339) |
| F6 | Open | Still true: no 200-VU run after the 503 mapping | Open |
| F7 | Open | No hot-account improvement implemented | Open |
| F8 | Info, Open | Now documented at README:1302 (committed in `b454b81`) | Resolved in docs. The QA table still says Open (DOC-04) |
| F9 | Info, Open | Now documented at README:26 | Resolved in docs. The QA table still says Open (DOC-04) |
| F11 | Low, Open | Unchanged (AUD-21, AUD-23) | Open |

---

## 6. Test and validation results

Every command was run from the repository root, on Node v22.15.0, npm 10.9.2, Docker 29.9.0 and Compose 5.6.0.

| # | Command | Exit | Outcome |
|---|---|---|---|
| 1 | `git status --short`, `git log --oneline --decorate -10`, `git diff`, `git diff --cached`, `git status --ignored` | 0 | §2 |
| 2 | `npm run typecheck` | 0 | no errors |
| 3 | `npm run lint` | 0 | no warnings or errors |
| 4 | `cd client && npx tsc --noEmit -p tsconfig.json` | 0 | no errors |
| 5 | `npx tsc -p tsconfig.build.json --outDir <scratchpad>/build-out` | 0 | 37 `.js` files. `diff -rq <scratchpad>/build-out dist` found no difference, so the local `dist/` equals a fresh build of HEAD |
| 6 | `env -u WORKERS -u TEST_DATABASE_URL REQUIRE_DB=1 npx vitest run` | 0 | **Test Files 27 passed (27), Tests 562 passed (562)**, 81.5s, 0 skipped. Against `quota_test` on the Compose Postgres |
| 7 | `docker compose config -q`; `docker compose --profile load config -q` | 0, 0 | valid |
| 8 | `npm ls --all` (root); same in `client/` | 0, 0 | installed trees match the lockfiles |
| 9 | `npm audit --omit=dev --json`, root and `client/` (piped to `jq`, exit code not captured) | n/a | 0 vulnerabilities in each |
| 10 | `npm audit --json` (all deps), root and `client/` (piped, exit not captured) | n/a | root: 4 moderate (`drizzle-kit`, `esbuild`, `@esbuild-kit/*`); client: 0 |
| 11 | `curl http://localhost:8081/`, `curl http://localhost:3000/healthz`, `curl http://localhost:8081/demo/run` (GET) | n/a (curl exit not captured) | 200 `text/html` (6,311 B); 200 `{"status":"ok","db":"up"}`; 404 (only POST is routed) |
| 12 | sha256 of `dist/**/*.js` inside the `api` container vs local `dist/`; sha256 of `dist/` + `public/` inside the `client` container vs a fresh `tsc` build of `client/` | n/a | identical, both |
| 13 | `docker compose exec api id -un`, same for `client`; `docker history quota-service-api`; `docker inspect … RestartPolicy` | 0 | `node`, `node`; layers clean; restart policy `no` ×3 |
| 14 | `git ls-remote origin refs/heads/main` | 0 | equals HEAD |
| 15 | grep for `mk_…` keys, private keys, cloud tokens in all files (tracked and untracked, excluding `node_modules`, `.git`, `dist`) | n/a | none found |
| 16 | Scratch `tsx` probe of `externalUserIdSchema`, `requestIdSchema`, `nameSchema` lengths | 0 | lengths count code points (128 emoji accepted, 129 rejected), matching README:147 |
| 17 | `jq` over `SUMMARY_JSON` of 7 cited runs, plus the `compare-*.txt` medians | 0 | every number cited in README and LOAD_TEST §3, §4, §8, §9 matches |
| 18 | Before/after sha256 of every file in `load/results/` and `dist/`; before/after `git status --porcelain --ignored` | 0 | unchanged |

Side effects of these commands: #6 truncated and reseeded `quota_test`, which the suite does by design, and spawned and killed server processes on random ports. #9 and #10 sent the dependency trees to the npm registry. No other state changed.

**Not run, and why:**

| Item | Reason |
|---|---|
| `load/run.sh`, `load/compare.sh`, `load/uncontended.sh`, k6 | Load tests need your explicit approval |
| Fresh-clone `docker compose up --build` | Needs ports 3000/5433/8081 (3000 can't be remapped without editing the file, AUD-13), several minutes of builds, and a new volume whose cleanup would be a volume removal, which you prohibited |
| `docker compose restart`, `stop`, `down`/`up` persistence | Would disrupt your running stack |
| `POST /demo/run` against the dev stack | Creates an account in your dev database. The same demo ran against `quota_test` in #6 |
| Browser rendering of the client page | No browser session was used, so it's not visually verified |
| Migrations against the dev DB | Prohibited. The migration path ran only against `quota_test` (`tests/global-setup.ts`) |

---

## 7. Security and data-integrity assessment

**Threat model:** a multi-tenant HTTP API reached by backend services. Each tenant (account) has one bearer key. The assets are each tenant's usage, plans and history, quota correctness (metering can't be bypassed), and the API keys.

| Threat | Assessment |
|---|---|
| Cross-tenant read or write | [Code] Every query is scoped by `account_id`, including the joins in step 7 (`consume.service.ts:113-118`) and history (`requests.service.ts:59`). The composite FKs block cross-account rows at the DB level. Another account's resource is 404. [Executed] isolation tests pass. **No issue.** |
| Authentication bypass | [Code] Every router except `/healthz` and `POST /accounts` is mounted behind `requireApiKey` (`app.ts:52-58`). An empty header counts as missing. The lookup runs on the SHA-256 via a unique index, so there's no timing side channel on the key. **No issue.** |
| Key storage and leakage | [Code] Only the hash is stored (`accounts.service.ts:30`). The plaintext key appears once, in the 201 response. A failed query can log its parameters, but those include the hash, never the key. [Executed] No `mk_` key in any file, including the committed `-api.log` files. No key rotation (documented limitation). |
| Quota bypass via idempotency | [Code] Replays compare user and units (`consume.service.ts:38-46`); the recheck after the lock and the unique constraint stop double counting. The F10 and UTF-8 checks close the aliasing route where distinct IDs collapse to U+FFFD. [Executed] 20-way and burst races pass, and `check-invariants.sql` check 4 (account usage = sum of accepted request units) is 0 in every run I checked. **No issue.** |
| Quota bypass via races or overflow | See §8. **No issue.** |
| Injection | [Code] All SQL goes through Drizzle parameters. The only raw `sql` fragments interpolate bound values (`users.service.ts:59`, `requests.service.ts:54`, `consume.service.ts:134`, `:138`). The test helper quotes identifiers. **No issue.** |
| Prototype pollution or mass assignment | [Code] Bodies are `z.strictObject`, so an own `__proto__` key is rejected as an unknown field. Spreads into inserts and updates use only parsed fields. **No issue.** |
| Malformed or oversized input, DoS | Body limit is Express's default 100 KB (→ 400). `limit` is ≤ 100. IDs are ≤ 128 and names ≤ 200 code points. Account creation isn't rate-limited (AUD-07). The history query by user and old month scans that user's newer rows (documented, README:1336). |
| Information leakage in errors | [Code] A 500 returns a fixed message. Validation messages echo only field paths and Zod texts. 404 for foreign resources. |
| Secrets in the repo or images | [Executed] None. The only credentials are the local defaults `quota:quota` in `.env.example`, compose, README and the test helper. Image layers hold no source or secrets. |
| Container privileges | [Executed] api and client run as `node` (uid 1000). No `privileged` and no added capabilities. Postgres uses the stock image. Ports are published on all interfaces (AUD-06). |
| TLS | None. That's fine for local Compose; a deployment would need a TLS-terminating proxy. |

**Data integrity:** the DB `CHECK`s (`units_used ≥ 0`, `units > 0`, `remaining ≥ 0`, first-of-month dates, and status ↔ reason/owner/limit nullability), the PKs, the unique keys and the composite FKs back the application rules [Code; `schema.db.test.ts` ✔]. Nothing is ever deleted (no DELETE route, all FKs `NO ACTION`). A partial failure rolls back as a whole (`inTransaction`, `db/client.ts:35-60`). A broken connection is destroyed rather than returned to the pool, so a half-finished transaction can't commit on the next request.

---

## 8. Database, concurrency and idempotency assessment

[Code] I traced `POST /consume`: `express.json` (UTF-8 verify) → `requireApiKey` (1 query) → strict Zod parse → `consume()`.

1. User lookup by `(account_id, external_user_id)` (unique index). 404 if absent.
2. Fast-path `requests` lookup on the unique `(account_id, request_id)` index. On a match: replay, or 409.
3. A single clock read (`at`), then `inTransaction`: a pooled client, `BEGIN`.
4. `INSERT … ON CONFLICT DO NOTHING` into `account_usage`, then `user_usage`.
5. `SELECT … FOR UPDATE` on the account row, then the user row.
6. Recheck `requests`. `READ COMMITTED` takes a new snapshot per statement, so a same-key transaction that committed while we waited is visible.
7. One join reads both plans.
8. `evaluate()`, pure.
9. On accept, two `UPDATE … + units`.
10. `INSERT requests … RETURNING`.
11. `COMMIT`. The response is built from the returned row and sent only after `COMMIT` succeeds.
12. On 23505 for `requests_account_id_request_id_unique`, re-read and replay or 409.

| Question | Answer |
|---|---|
| Can two consumes over-allocate? | No [Code]. Every consume of an account locks that account's month row first, so decisions for one account are serial and each sees the previous commit. [Executed] 50 parallel requests: exactly ⌊100/3⌋ = 33 accepted, 33 distinct `remaining` values. |
| Deadlocks? | None possible between consumes [Code/Inferred]. Each upsert of a new row runs before step 5, so a holder of the account lock never waits on another transaction's insert. User-row locks are taken only while holding the account lock. Plan updates take no usage locks. No deadlock appears in any load-run log [Doc]. |
| Integer overflow? | No. An increment is applied only if `used + units ≤ limit ≤ 2^31−1`. Lowering a limit never increments. |
| Month boundary? | The clock is read once before the transaction. The month, the usage rows locked and `requests.month` all derive from it. A same-key retry across the boundary replays (tested). Two concurrent same-key copies on either side of the boundary hold different locks; step 12 resolves them (the unique-violation tests pass). |
| Plan change during consume? | Plans are read after the lock in one statement. A consume that read the old plan and commits after the update is serialized before it. That's a valid order, because updates don't read usage. Tested with 30 consumes plus a PATCH. |
| Rejected requests? | Recorded, with no usage change. The first request of a month may create zero-valued rows (documented, README:1310). |
| Replays change usage? | No. Replays return before step 9. [Executed] `check-invariants.sql` check 4 = 0 in every run I inspected. |
| Retry after a transient failure? | 503 cases (pool wait, lock or statement timeout) roll back with nothing written. A client-side `COMMIT` timeout gives a 500 that may have committed, and a same-key retry is still correct (README:1203). Accurate. |
| Pool exhaustion? | A 2s connection wait → 503 with `Retry-After`. At 200 VUs this happens (QA F6), as documented. |
| Process death mid-transaction? | Postgres rolls back when the connection drops. `idle_in_transaction_session_timeout` of 10s releases locks held by a vanished client. Graceful shutdown waits for in-flight requests (`server.close`), with a 10s forced exit. Draining under load is untested (documented, LOAD_TEST:393). |
| Migrations? | One transactional migration; the journal is ordered; re-running is a no-op. Seeding is idempotent with fixed IDs (tested). Future migrations: see AUD-01. |
| Index use | History filters each have a matching index; the plan for the month filter is asserted (`requests.db.test.ts:217-255`). User+month has no exact index (documented). Users are paginated on `(account_id, created_at, id)`. No N+1 patterns: list endpoints are one query each, plus one user lookup for `?externalUserId`. |
| Test isolation | Files run serially on `quota_test`, which each test truncates and reseeds. The `_test` suffix guard prevents truncating any other database. |

---

## 9. Example client and Compose assessment

**Client** [Code + Executed demo test]:
- The demo creates a fresh account and a custom account plan of 200/month · 50/request, then registers Alice (Basic) and Bob (Premium).
- Alice: 10 accepted → 25 rejected (USER per-request, limit 20) → switch to Premium → the same 25 accepted.
- Bob: 50, 50, 50 and 15 accepted (account remaining reaches exactly 0), then 50 rejected (ACCOUNT monthly, limit 200).
- Every step is checked against fixed expected values, including both `remaining` numbers. I checked the arithmetic by hand: the account has 200 − 35 − 165 = 0 left, and Bob 5,000 − 165 = 4,835.
- The page renders status, reason, owner, limit and both remaining values with `textContent`, so there's no XSS. The API key never reaches the browser.
- The client reaches the API at `http://api:3000`, starts after the API is healthy, and its 10s per-call timeout and non-JSON error handling are tested (`quota-api.test.ts`).
- Gaps: the browser rendering wasn't verified (RQ-40), the HTTP route is untested (AUD-16), it ignores SIGTERM (AUD-03) and listen errors (AUD-04).

**Compose and startup** [Code + Executed config and inspection]:
- Ordering: db (`pg_isready` healthcheck) → api (`depends_on: service_healthy`; entrypoint migrate → seed → `exec node`; healthcheck `/healthz` with `start_period` 20s) → client (`depends_on: api healthy`).
- `stop_grace_period: 15s` covers the cluster's 12s backstop. The named volume `db-data` persists data across `down`/`up` (`down -v` deletes it, as documented).
- Docker Engine 25+ is needed because of `start_interval`, and README:26 says so. `COPY --chmod` needs BuildKit, the default in Engine 25+. `.gitattributes` forces LF in `*.sh`, so a Windows clone still runs the entrypoint.
- An interrupted migration is safe: the migration transaction rolls back, and the next start re-applies it.
- There is no `restart:` policy (AUD-11). The API host port is fixed (AUD-13).
- `tests/compose.test.ts` checks configuration only, not behavior (AUD-18).
- **Fresh clone at HEAD: not verified** (§6). The strongest current evidence is indirect: the running stack's code is byte-identical to HEAD and healthy, but it wasn't started from a clean clone.

---

## 10. Performance evidence assessment

[Executed spot-checks + Code]

- **Scenario validity:** hot account (1 account × 200 users), many accounts (100 × 5) and retry storm (fixed key pool, bursts of 3) match their descriptions (`load/*.js`). Setup traffic is tagged `setup` and excluded from the summaries (`lib.js:46-47`, `:69`).
- **Metrics:** RPS = consume count ÷ the duration in whole seconds, guarded by `load/duration.js`. The count includes iterations that finish during the 5s `gracefulStop`, at most one per VU, which is negligible (≤ 50 of 2,000–10,000 requests).
- **Correctness reconciliation:** good. Every run reconciles k6 fresh responses against request rows (`run.sh:151-157`) and runs four global invariants plus a per-run check. I confirmed `usage_sum_violations 0` and `k6 fresh = request rows` in the 7 runs I read.
- **Measurements:** the `pg_stat_activity` sampling, docker CPU, index-scan deltas and the API log are well designed. The fast-path versus recheck split is calibrated against the hot-account run.
- **Conclusions follow from the data:**
  - The lock-bound hot account is shown by 8.25 of 10 connections waiting on the `FOR UPDATE`.
  - The CPU-bound single process is shown by connections idle in transaction and 107% CPU.
  - The `WORKERS` decision rests on two sessions whose ranges don't overlap.
  - Explanations that weren't verified (the hybrid-core hypothesis, the unfair lock hand-off, the per-worker pool wait) are labeled as such.
  - The anomalies (`06e6a282`, TP-LOAD-04) are disclosed, not explained away.
- **Comparability:** §8 alternates W1 and W4 in one session, as it should. §3 is not compared with §8, which is correct, given 167.7 vs 187–209 req/s for the same configuration in different sessions.
- **Gaps:**
  - No commit recorded per run (AUD-23).
  - §9 evidence is untracked (AUD-21).
  - No rejected-path or rule-change-under-load run (AUD-20).
  - The 503 path is untested at 200 VUs (QA F6).
  - One host is shared by k6, the API and the DB (disclosed).
  - A single run per scenario in the baseline (disclosed).
- **Brief fit:** method, results, bottleneck, one implemented and measured improvement, correctness evidence and lessons are all present. The numeric thresholds are correctly labeled as internal, not as brief requirements (`LOAD_TEST.md:452`).

---

## 11. Documentation discrepancies

| ID | Location | Claim | Reality | Severity |
|---|---|---|---|---|
| DOC-01 | `docs/QA_REPORT.md:591` (§7, rev 4) | "F12 inside the Compose stack: the `api` and `client` images weren't rebuilt, so the running containers still accept `.` and `..`." | Stale. [Executed] Both running containers are byte-identical to a HEAD build, built after `3c39c71`. The F12 behavior inside the stack still wasn't HTTP-probed | Low |
| DOC-02 | `CLAUDE.md:7` | "The Phase 6 baseline is implemented and awaiting review" | `docs/PLAN.md` has every Phase 6 and Phase 7 box ticked. Per CLAUDE.md's own rule PLAN.md wins; flagged as a conflict. CLAUDE.md also doesn't mention Phase 7 | Info |
| DOC-03 | `README.md:1348`, `docs/LOAD_TEST.md:5`, `:471`, `QA_REPORT.md:40` | the §9 files are "untracked at commit `9880430`" | Still true at `b454b81`. Anchoring the claim to an older commit than HEAD may confuse a reader | Info |
| DOC-04 | `docs/QA_REPORT.md:41`, findings table `:151-152` | the F8/F9 README changes "weren't committed when this addendum was written"; F8/F9 shown as Open | Both README changes are committed in `b454b81` (README:26, :1302). The table statuses are deliberately frozen at rev 4, but a reader sees "Open" for documented items | Info |
| DOC-05 | `README.md:1253` | "A cursor keeps its position" | True, but an entry that commits late can land behind rows already returned (AUD-02). README:1309 states the ordering, not this consequence | Low |
| DOC-06 | `docs/QA_REPORT.md:38` | full suite on `9880430`: 562 passed, developer-reported, no output saved | Now independently confirmed on `b454b81`: 27 files, 562 passed, 0 skipped (§6 #6). Not a discrepancy; it upgrades the evidence | — |
| DOC-07 | `docs/PLAN.md` Phase 8 | fresh clone, README walkthrough | Unticked; consistent with no fresh-clone verification at HEAD | Info |

Verified accurate (sample): the endpoint table and auth column; the error table and the 503 semantics; code-point length counting (README:147, probe #16); Docker Engine 25 / Compose 2.20.2 and the `docker-compose.yml:41` reference; "at 8 workers at most 80 connections"; all load numbers in README and LOAD_TEST §3, §4, §8, §9; predefined limits and IDs; check order; "rejected `requestId` is spent"; "unknown user beats conflict"; "`query_timeout` is not mapped to 503".

---

## 12. Unverified claims and remaining uncertainty

- **Fresh-clone start at HEAD** (RQ-43): last verified on `47fa0e7` plus a patch, by the QA review [Doc].
- **Restart and `down`/`up` persistence** (RQ-35): manual on an earlier commit [Doc]; not automated.
- **Client page in a browser** (RQ-40): HTML returns 200; rendering not seen. The developer reports `every step matched` [Doc, no saved output].
- **The 503 overload path under real load** (QA F6): unit and integration tests only.
- **The cause of TP-LOAD-04's 77.3 req/s, and of `many-accounts-06e6a282`'s 339.6 req/s with `api_node_processes 2`:** unknown. The healthcheck `node -e` process being counted at that instant is plausible, but not verified.
- **AUD-02 and AUD-03:** probable by code reading, not reproduced.
- **Edge-case test files I read only by structure** (§3): they pass, but I didn't check each assertion's strength line by line.
- **Docker Engine < 25 and other Node versions:** untested.

---

## 13. Prioritized remediation plan

None of these is applied yet. Severity ordering, with a note on the approval each needs.

| # | Item | Effort | Needs approval? | Changes behavior? |
|---|---|---|---|---|
| 1 | **Decide on the 33 untracked §9 files** (AUD-21): commit them with explicit paths, or leave them | minutes | **Yes**: your data and your call | No |
| 2 | AUD-01: migration pool without request timeouts, plus a test | small | Low risk; touches `src/scripts/run-with-db.ts` and `src/db/client.ts` | Startup only |
| 3 | AUD-06: bind published ports to `127.0.0.1` | 3 lines | **Yes**: Docker setup change | Host access only |
| 4 | DOC-01, DOC-02, DOC-04, DOC-05: refresh stale lines; one sentence on history ordering (AUD-02) | small | Docs only | No |
| 5 | AUD-03, AUD-04: `init: true` (or a SIGTERM handler) and listen-error handling in the client | small | `init: true` is a Docker change → **yes** | Stop time only |
| 6 | AUD-05: include `client/src` in the root typecheck | 1 line | No | No |
| 7 | AUD-15, AUD-16: user-limit race test; client route/page test | small | No (tests only) | No |
| 8 | AUD-23: record commit, dirty state and image ID in `load/run.sh` | small | **Yes** (TEST_PLAN D6) | Load evidence format |
| 9 | AUD-20 / QA F6: a load scenario with small limits, a concurrent PATCH, and a 503 check at 200 VUs | medium + runs | **Yes**: new load runs | No |
| 10 | AUD-11/13/14, M-01/M-02: restart policy, `API_PORT`, `**/node_modules` in `.dockerignore`, `PG_POOL_MAX` | small | Docker/config → **yes** | Ops only |

Items 2, 4, 6 and 7 are safe, clearly in scope and don't change the public API or quota semantics. They could be applied on request with regression tests. Every other item changes Docker setup, load tooling or evidence, and needs your sign-off.

---

## 14. Go / no-go

**GO.** No defect found affects quota correctness, tenant isolation, idempotency, or the brief's required demonstrations. The 562 automated tests pass on this exact commit. The running stack is built from it. The documentation is unusually careful about what it has and hasn't verified.

Decisions for you before submitting:
1. **The 33 untracked load-result files.** Commit them, or accept that LOAD_TEST §9 cites evidence a clone doesn't have.
2. **Whether to apply any fix at all,** given the deadline of end of 20/10/2026 and that any commit now is dated 21/10.
3. **Optionally, verify it yourself:** a fresh-clone `docker compose up --build` (needs the dev stack stopped, or the API port changed) and one browser run of the demo. These are the only brief-level items still Unable to Verify at HEAD.
