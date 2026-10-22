# Engineering Audit

| | |
|---|---|
| Date | 2026-10-22 |
| Base commit | `6d8a338` (`main`). Every change below is **uncommitted** in the working tree. Nothing was committed, pushed or published |
| Left untouched | `admin-client/` (untracked), the 4 modified and 33 untracked files under `load/results/` that were there at the start, the running Compose stack `quota-service` and its `db-data` volume |
| Builds on | [FINAL_AUDIT_REPORT.md](FINAL_AUDIT_REPORT.md) (AUD-xx, at `b454b81`) and [FINAL_AUDIT_REMEDIATION.md](FINAL_AUDIT_REMEDIATION.md). Findings fixed there aren't repeated |
| Related | [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md), [COMPETITIVE_AUDIT.md](COMPETITIVE_AUDIT.md), [CONSUME_ROUND_TRIPS.md](CONSUME_ROUND_TRIPS.md), [LOAD_TEST.md](LOAD_TEST.md) §11 |

Labels: **[Executed]** I ran it and read the result · **[Code]** a conclusion from reading code · **[Doc]** taken from the repository's documents, not re-verified.

## 1. Baseline (before any change)

| Command | Result |
|---|---|
| `git status --short` | 4 modified tracked files, all in `load/results/`; untracked: `admin-client/` and 33 files under `load/results/` |
| `npm run typecheck` | exit 0 [Executed] |
| `npm run lint` | exit 0 [Executed] |
| `tsc -p tsconfig.build.json --outDir <scratch>` | exit 0 (built outside `dist/`, which `docs/LOAD_TEST.md` §9 cites by checksum) [Executed] |
| `cd client && tsc --noEmit -p tsconfig.json` | exit 0 [Executed] |
| `REQUIRE_DB=1 npx vitest run` | **32 files, 594 tests passed**, 0 failed, 66.9s [Executed] |

There were no pre-existing failures, so every failure seen later in this session was caused by a change made in it (each red check below was deliberate and reverted).

## 2. Strengths confirmed

- **The consume transaction is correct by construction, not by luck.** §3 gives the argument; the concurrency tests exercise it, and the new lock-order test observes it from outside [Executed].
- **Tenant isolation is enforced twice:** in code (every query filters by `account_id`) and in the schema (composite FKs from `user_usage` and `requests` to `users(account_id, id)`).
- **The decision logic is a pure function** (`rules.ts` `evaluate()`), so the stored decision snapshot can be re-checked by calling it again (§4, ENG-01).
- **The test suite is deep and honest:** it uses a real PostgreSQL, runs real server and client processes, includes red checks recorded in the earlier remediation, and has `REQUIRE_DB=1` to forbid silent skips.

## 3. Why the concurrency strategy is correct

Transactions alone don't prevent overspending. At READ COMMITTED, two consumes could each read `units_used = 90` against a limit of 100, both accept 10, and both commit 100 + 10. What prevents that here:

1. **One serialization point per account.** Every consume locks `account_usage(account_id, month)` `FOR UPDATE` before it reads any usage, and holds it until COMMIT. A second consume of the same account waits. When it gets the lock, Postgres hands it the newest committed version of the row, so it decides against the first one's total.
2. **The user total is covered by the same lock.** A user's usage row is only written by consumes of its own account, and they all hold the account lock. Locking the user row as well (always second) costs nothing and keeps the order fixed.
3. **Fresh reads after the lock.** The recheck of `requestId` and the plan read are separate statements issued after the lock was granted. READ COMMITTED gives each statement a new snapshot, so they see whatever the previous lock holder committed.
4. **One order, so no deadlock cycle.** Account row before user row, in every consume, including the upserts that create the rows. Consumes of different accounts share no rows.
5. **Writes are atomic.** Both increments and the request row are in one transaction. Rejected decisions write only the request row.
6. **Idempotency doesn't rely on timing.** The `UNIQUE (account_id, request_id)` constraint is the hard guarantee. The recheck makes duplicates replay normally. Step 12 turns a unique violation into a replay of the committed row.

Month boundary: a request reads the clock once. Two copies of one `requestId` on either side of midnight lock different month rows, and the unique constraint still makes one of them a replay (step 12). This is tested ("a retry in the next month replays the original decision…").

## 4. Findings and remediation

Severity: **High** = wrong decisions or totals, or a security hole · **Medium** = a requirement weakened · **Low** = robustness, hardening or evidence · **Info** = noted, no change.

### Fixed in this session

**ENG-01 (Medium): past decisions couldn't be re-explained after a plan edit**
- **Root cause:** a request row stored the plan IDs, the blocking `limit` (rejections only) and `remaining`, but not the limits the decision used or the usage it started from. A `PATCH` of a custom plan changes what the stored ID means. This was QA F4 and RQ-29's caveat, and the brief says "Changes must preserve past request history".
- **Fix:** migration `drizzle/0001_decision_snapshot.sql` adds six nullable integer columns to `requests`: the account and user `monthly_limit` and `per_request_limit` as read under the lock, and both usage totals before the request. Step 10 writes them (`consume.service.ts`), and `GET /requests` returns them as `snapshot` (`requests.service.ts`). `requests_snapshot_check` makes them all-or-nothing, and spells out `IS NOT NULL` because a CHECK lets a NULL comparison through.
- **Compatibility:** an additive migration with no table rewrite and no backfill. Old rows get `snapshot: null`, the consume response is unchanged (a replay is still byte-identical), and the history response gains one field.
- **Tests:** `tests/decision-snapshot.db.test.ts`, 11 tests.
  - The stored inputs re-derive each of 6 accepted and rejected decisions with `evaluate()`, after a user plan PATCH, an account allowance cut below usage and a switch to a predefined plan.
  - A replay keeps the original snapshot.
  - Under 40-way concurrency the snapshots chain 0, 3, 6, …
  - A pre-0001 row shows `snapshot: null`.
  - The CHECK rejects 5 kinds of partial or invalid snapshot.
  - The migration on a database populated under `0000` leaves every existing column of every row unchanged.
  - `requests.db.test.ts` expectations gained the field.
- **Red check:** with the six writes removed, 4 tests fail. [Executed]
- **Also used by:** `load/check-invariants.sql` check 6 (ENG-05).

**ENG-02 (Low): the response carrying the plaintext API key was cacheable**
- **Fix:** `Cache-Control: no-store` on `POST /accounts` (`routes/accounts.ts`).
- **Test:** `accounts.db.test.ts` "…marked Cache-Control: no-store".
- **Red check:** without the header, it fails. [Executed]

**ENG-03 (Low): any header value was hashed and looked up in the database**
- **Impact:** garbage keys cost a SHA-256 and a query each, and an 8 KB header was hashed. There was no disclosure.
- **Fix:** `isWellFormedApiKey()` (`mk_` + 43 base64url characters, exactly what `generateApiKey()` emits) is checked first. Failures get the same `401 Invalid API key` as an unknown key. The contract is unchanged: same status, code and message, and a missing header still says `Missing X-API-Key header`.
- **Timing:** a malformed key is answered faster than a well-formed unknown one. That reveals only the public format, not anything about stored keys.
- **Tests:** `errors.test.ts`, 8 malformed shapes against an app whose DB stub throws on use, so a 401 proves no lookup happened. `accounts.db.test.ts` shows unknown and malformed keys get identical bodies. `lib.test.ts` checks that 1,000 generated keys pass and 6 near-misses fail.
- **Red check:** with the check disabled, 8 tests fail. [Executed]
- **Existing tests changed:** two `errors.test.ts` cases that used `mk_anything` to reach the DB-failure path now use a well-formed key, so they still test that path. No assertion changed.

**ENG-04 (Low): no CI** (was AUD-18)
- **Fix:** `.github/workflows/ci.yml` has two jobs.
  - `checks`: `npm ci` (root and client), typecheck, lint, build, client typecheck, and `npm test` with `REQUIRE_DB=1` against `postgres:16` on port 5433, the tests' default URL.
  - `compose`: `docker compose up --build --wait` from the checkout, then a curl smoke test (healthz, account, user, consume, `POST /demo/run` with `ok: true`), and `down -v`.
- No new dependencies; actions `checkout@v4` and `setup-node@v4`, and permissions `contents: read`.
- **Not run on GitHub** (nothing was pushed). Every command in it was run locally (§6), but GitHub-specific behavior (service container networking, runner image) is unverified.

**ENG-05 (Low): load-test checks 2 and 3 are invalid while plans change**
- **Root cause:** they compare usage with the *current* plan (documented precondition, AUD-20).
- **Fix:** `load/check-invariants.sql` check 6 compares each decision with the limits and usage on its own row. No accepted decision exceeded them, no rejection was within them, and every `remaining` matches.
- Checks 1–5 are unchanged and their output format is the same. Pre-0001 rows are counted, not checked.
- **Evidence:** 0 violations on every row of every load run in [LOAD_TEST.md](LOAD_TEST.md) §11 [Executed]. The `ab.sh` parser was tested on a synthetic violation.

**ENG-06 (Low): no load scenario produced rejections** (LOAD_TEST.md §7 "Rejected-path latency wasn't measured")
- **Fix:** `load/mixed.js` puts 1 account and 200 users on 100/month · 10/request and sends 1–15 units: about a third of requests break the per-request limit, and the monthly limit is reached later in the run.
- `load/lib.js` `createAccounts()` takes optional limits. The defaults are unchanged, so the other scenarios are identical.

**ENG-12 (Low): two consume tests detect lock waits by matching SQL text**
- **Where:** `consume.db.test.ts` matches `'insert into "requests"%'` and `'%from "account_usage"%for update'`.
- **Impact:** any change to how the transaction's statements are written makes those helpers time out, even when the behavior is correct. The prototype needed both patterns widened ([CONSUME_ROUND_TRIPS.md](CONSUME_ROUND_TRIPS.md) §4).
- **Not changed in production tests:** the current patterns are correct for the current code. Widening them belongs with the transaction change if it's approved.

**New test coverage (no defect found)**
- `tests/consume-locking.db.test.ts` (4 tests) works for any statement layout:
  - The lock order is observed from a third session.
  - Two users of one account race with duplicated IDs.
  - A trigger-injected failure while recording the decision rolls back the increments, and the retry is decided fresh.
  - A backend terminated mid-transaction leaves nothing counted, and the pool keeps serving 12 more requests.
- All pass on production and on the prototype.
- **Red check:** a prototype variant that locks the user row first fails the lock-order test. [Executed]

### Open: decisions for the owner

| ID | Sev. | Finding | Why it isn't changed | Proposal |
|---|---|---|---|---|
| ENG-10 | Low (perf) | One account's throughput is bounded by the 8-statement hold of its usage row lock | Changing the transaction needs your approval (your instruction for this session) | Prototype with 4 statements under the lock, measured A/B on one host: hot account +44.9% (159.4 → 230.9 req/s), many accounts +18.3%, retry storm +6.7% (within noise), 0 errors and 0 invariant violations in 26 runs. Second session, paired by round (§12): hot account +42.3% geometric mean, prototype faster in 8/8 pairs over both sessions. Statement-level review and race tests: [CONSUME_ROUND_TRIPS.md](CONSUME_ROUND_TRIPS.md) §8, [LOAD_TEST.md](LOAD_TEST.md) §11–§12 |
| ENG-07 | Low | No API key rotation or revocation: one key per account, forever | A new endpoint and table (e.g. `api_keys` with `revoked_at`); not required by the brief. Documented in README Known limitations | `POST /account/keys` to issue a second key, `DELETE /account/keys/:id` to revoke, auth on the new table |
| ENG-08 = AUD-07 | Info | `POST /accounts` is public with no rate limit, so anyone who can reach the port can create accounts without bound | Locked decision (PLAN.md §6, "Account creation is unauthenticated") | Rate limiting at a reverse proxy, or an operator key for account creation (the approach competitor #4 took) |
| ENG-09 = AUD-06 | Low | Compose publishes Postgres (default credentials), the API and the client on all host interfaces | Deployment intent is the owner's call | `127.0.0.1:` prefixes on the three `ports` |
| ENG-11 = AUD-02 | Low | A decision that commits late is listed behind newer history entries | Documented ("History isn't a change feed"); a fix changes the schema or the one-clock-read decision | A commit-order column |
| ENG-13 | Info | Old request rows have `snapshot: null` | Their limits at the time can't be recovered; backfilling from today's plans would record something false | None |

## 5. Files changed in this session

| File | Change |
|---|---|
| `src/db/schema.ts` | Six snapshot columns and `requests_snapshot_check` |
| `drizzle/0001_decision_snapshot.sql`, `drizzle/meta/0001_snapshot.json`, `drizzle/meta/_journal.json` | Generated by `drizzle-kit generate --name decision_snapshot` |
| `src/services/consume.service.ts` | Step 10 writes the snapshot. No statement added, removed or reordered |
| `src/services/requests.service.ts` | `snapshot` in the history view |
| `src/lib/api-key.ts`, `src/middleware/auth.ts` | Key format check before the lookup |
| `src/routes/accounts.ts` | `Cache-Control: no-store` |
| `tests/decision-snapshot.db.test.ts`, `tests/consume-locking.db.test.ts` | New |
| `tests/accounts.db.test.ts`, `tests/errors.test.ts`, `tests/lib.test.ts`, `tests/requests.db.test.ts` | New cases; two keys made well-formed; history expectations gained `snapshot` |
| `.github/workflows/ci.yml` | New |
| `load/check-invariants.sql` | Check 6 |
| `load/lib.js`, `load/mixed.js`, `load/run.sh` | Optional plan limits; the mixed scenario; usage text |
| `load/ab.sh`, `load/ab.compose.yml` | A/B harness for two API images |
| `README.md`, `docs/LOAD_TEST.md`, `CLAUDE.md` | Documentation of the above |
| `docs/COMPETITIVE_AUDIT.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/ENGINEERING_AUDIT.md`, `docs/CONSUME_ROUND_TRIPS.md`, `docs/prototypes/consume-round-trips.patch` | New |

## 6. End-to-end verification

### Checks after the changes [Executed]

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `tsc -p tsconfig.build.json --outDir <scratch>` | exit 0 |
| `cd client && tsc --noEmit -p tsconfig.json` | exit 0 |
| `REQUIRE_DB=1 npx vitest run` | **36 files, 640 tests passed**, 0 failed, 0 skipped (baseline: 32 / 594; 35 / 629 before `tests/consume-races.db.test.ts`) |
| Prototype copy, `REQUIRE_DB=1 npx vitest run` | 34 files, 626 passed (before `tests/load-ab.test.ts` existed) |

### Fresh-clone `docker compose up --build` [Executed]

- **Source:** an export of the working tree as it would be committed (`git ls-files -co --exclude-standard`, without `load/results/` and `admin-client/`): no `node_modules`, no `dist`, no `.env`. A `git clone` of HEAD would test `6d8a338` without this session's changes, so this export is the closer stand-in. It ran as its own Compose project (`freshclone`) with the documented `DB_PORT=5435` and `CLIENT_PORT=8082`.
- **Port 3000 is hardcoded** in `docker-compose.yml`, so the developer's `api` container was stopped (`docker compose stop api`) during the check and restarted afterwards. It reported healthy again on its existing image. Nothing of that stack was removed.

| Check | Result |
|---|---|
| `docker compose up --build -d --wait` | exit 0, all three services healthy after 12 s (Docker reused layers from the benchmark images) |
| `docker compose build --no-cache`, then `up` | exit 0, healthy; build took 12 s |
| Entrypoint log | `migrate: database is up to date` after applying `0000` and `0001` (2 rows in `drizzle.__drizzle_migrations`); `seed: 4 predefined plan(s) inserted`; `listening on port 3000` |
| Schema | `requests` has the snapshot columns |
| `GET /healthz` | `{"status":"ok","db":"up"}` |
| `POST /accounts` | 201, `Cache-Control: no-store` |
| `GET /account` with `X-API-Key: mk_short` | 401 `Invalid API key` |
| `POST /users`, then consume 10 and 25 | ACCEPTED (9,990 / 990 remaining); REJECTED `USER` `PER_REQUEST_LIMIT_EXCEEDED` limit 20 |
| `GET /requests` | entries with `snapshot` (the real output now in README "Decision snapshots") |
| Client `GET /` on :8082 | 200 `text/html` |
| Client `POST /demo/run` | `ok: true`, 14 steps, none failed |
| `docker compose restart` | usage, history and replay of `f-1` (`replayed: true`) unchanged |
| `docker compose down` (no `-v`), `build --no-cache`, `up` | unchanged again; the second seed inserted 0 plans (idempotent) |
| `docker compose down` | 1 s: every container stopped gracefully, no 10 s SIGKILL wait |
| Cleanup | `docker compose down -v` on `freshclone` and on the benchmark project `quotaab`; their 4 images removed. The developer's `quota-service_db-data` volume untouched |

### Not verified

- **The page in a browser** (RQ-40): HTML 200 and the demo JSON only.
- **The CI workflow on GitHub:** nothing was pushed. Its commands were all run locally, as above.
- **The developer's own stack on the new code:** its `api` container still runs the image built 2026-10-20, so its `quota` database hasn't received `0001` yet. The next `docker compose up --build` applies it on startup.
- **A PostgreSQL crash or kill** (as opposed to a clean restart).
