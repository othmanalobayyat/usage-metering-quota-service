# QA Report

## Phase 1 — Requirements Review

| Revision | Date | Code reviewed | What changed in this report |
|---|---|---|---|
| 1 | 2026-10-19 | commit `e1ab78e` | First review: matrix R1–R77, findings F1–F9 |
| 2 | 2026-10-19 | commit `47fa0e7` + the uncommitted working tree (input validation and malformed URL changes in `src/lib/schemas.ts`, `src/middleware/errors.ts`, `src/routes/{accounts,plans,users}.ts`, `tests/errors.test.ts`, new `tests/input-encoding.db.test.ts`, `README.md`) | F1 and F2 resolved in the working tree (not committed); new F10 and F11; R59 and R64 verified; R68 now Fully Implemented; new R78; line references updated for the changed files |
| 3 | 2026-10-20 | commit `b56dbc0` (the F1/F2 fix, now committed) + the uncommitted working tree: F10 fix in `src/lib/schemas.ts`, `src/app.ts`, `README.md`; new tests `tests/unicode-schemas.test.ts`, `tests/unicode-input.db.test.ts` | F10 tests written and run red, then the approved F10 fix; F10 resolved (the fix was uncommitted when this was written, see Commit state); the raw invalid UTF-8 variant confirmed and recorded under F10; F1/F2 now committed; R78 now Fully Implemented |
| 4 | 2026-10-20 | commit `1468d11` + the uncommitted working tree: dot-segment `externalUserId` fix in `src/lib/schemas.ts`, `client/src/quota-api.ts`, `README.md`; load `DURATION` check in `load/lib.js`, `load/run.sh`, new `load/duration.js`, `load/duration.d.ts`; new tests `tests/dot-segment-ids.test.ts`, `tests/dot-segment-ids.db.test.ts`, `tests/load-duration.test.ts` | New F12 and F13, both resolved (the fixes were uncommitted when this was written and are not in `1468d11`, see Commit state (revision 4); since committed as `3c39c71` and `b5a3486`, see the addendum after revision 4); no requirement status changes; R3, R19, R51, R64, R68, R72 notes; README line references for the revision 4 tree added next to the `1468d11` ones |

No production code was modified by revisions 1 and 2; they changed only this file. Revision 3 records a fix phase the developer approved step by step: first the F10 tests (run red against unchanged code), then the F10 fix in `src/lib/schemas.ts`, `src/app.ts` and `README.md`. Text added in revision 3 is marked "Rev 3". The review itself committed and staged nothing; committing is left to the developer. No file in `load/results/` was changed.

**Commit state (revision 3).** When revision 3 was written, `HEAD` was `b56dbc0`. The F10 fix (`src/app.ts`, `src/lib/schemas.ts`, `README.md`), its tests (`tests/unicode-schemas.test.ts`, `tests/unicode-input.db.test.ts`), this report and `docs/TEST_PLAN.md` were uncommitted changes on top of it, intended to be committed together as one commit. So:
- **In that working tree:** F10 is fixed.
- **In `b56dbc0` and every earlier commit:** F10 is present.
- **If the seven files are committed together as intended:** any checkout that contains this revision of the report also contains the fix.

Wherever this report says F10 is "Resolved", it means the fixed state, not `b56dbc0`. `git log -- src/app.ts` shows whether the fix has been committed.

**Addendum after revision 3 (2026-10-20).** This addendum only points to new evidence. It adds no finding and changes no status, and the revision 3 text above and below is kept as written.
- **Committed:** the F10 fix, its tests, this report and `docs/TEST_PLAN.md` are commit `1468d11` (`git show --stat 1468d11`: the seven files named above).
- **Compose image rebuilt:** the API image was built at 2026-10-19 22:53:56 UTC, after the commit (22:50:08 UTC). Its compiled `dist/` is byte-identical to the local build and contains the F10 checks.
- **TP-LOAD-04 run, not passed** (`load/results/hot-account-84e77ce8-*`, untracked; `docs/LOAD_TEST.md` §9; `docs/TEST_PLAN.md` §9). 50 VUs, `WORKERS=1`: invariants 0 and 0 errors (met), but **77.3 req/s, below the expected 85.2–103.3 req/s** (not met). Every earlier 50-VU single-process hot-account run is in 85.2–96.2 req/s. The cause wasn't investigated, so this report doesn't attribute it.
- **Reported by the developer, no output saved here:** full suite 486 passed; typecheck, lint and build clean; the Compose API, client and DB healthy; the browser demo ended with `every step matched`. These weren't rerun for this addendum.
- **TP-REG-01 passed** (`docs/TEST_PLAN.md` §10). It ran on a clean clone of `1468d11` with `REQUIRE_DB=1` against `quota_test`, Node v22.15.0. `tests/input-encoding.db.test.ts` and `tests/errors.test.ts`: 2 files, 56 passed. Full suite: 24 files, 486 passed, 0 failed, 0 skipped. This confirms the 486 above on committed code. `b56dbc0` on its own wasn't run.

**Revision 4 (2026-10-20).** A targeted check of four items reported in a separate review. Two were already covered here: NUL and lone surrogates (F2, F10) and malformed percent-encoding in path parameters (F1). Both were re-checked by reading the code and tests at `1468d11` and are unchanged. The other two are new: **F12** (dot-segment `externalUserId`) and **F13** (load `DURATION` parsing). That review called them "F2" and "F4"; they are renumbered here so they don't collide with this report's F2 and F4. The developer approved each step: first the findings report, then the fixes with their tests, then this update. Text added in revision 4 is marked "Rev 4".
- **Commit state (revision 4):**
  - When revision 4 was written, `HEAD` was `1468d11`.
  - At that time, the fixes for F12 and F13 existed only as uncommitted changes in the working tree, together with their tests, `README.md`, this report, `docs/TEST_PLAN.md` and `docs/LOAD_TEST.md`. The fixes are absent from `1468d11`. The defects described in F12 and F13 are therefore still present in `1468d11` and every earlier commit.
  - "Resolved" in the revision 4 findings describes the working-tree implementation, not the code at `1468d11`.
  - When revision 4 was written, the plan was to commit these changes in three commits: the F12 fix, the F13 fix, then the documentation. That happened; see the addendum after revision 4.
- The review itself staged and committed nothing; committing is left to the developer. No file in `load/results/` was changed, and no load test or migration was run. The only database access was one read-only `SELECT` on the Compose dev database (F12) and the test suite against `quota_test`.

**Addendum after revision 4 (2026-10-20): commit state at `9880430`.** This addendum records commit state and corrects citations. It adds no finding and changes no status. Writing it involved no test, Compose start, demo or load run.
- **Committed:** the F12 fix and its tests are `3c39c71`, the F13 fix and its tests `b5a3486`, and this report, `docs/TEST_PLAN.md` and `docs/LOAD_TEST.md` `6496b8f`. `9880430` then added the example-client checks to `tests/compose.test.ts`. So F12 and F13 are resolved in `3c39c71` and `b5a3486` and every later commit, and still present in `1468d11` and earlier.
- **Full suite on `9880430`:** 27 test files, 562 of 562 tests passed. The developer ran it on that commit, and no output is saved in the repository. The count is revision 4's 559 plus the three client checks `9880430` added to `tests/compose.test.ts`. The run came before the documentation-only changes on top of `9880430` and wasn't repeated after them.
- **Evidence from earlier revisions, not rerun on `9880430`:** the fresh-clone Compose start (R59) and the persistence check (R49), both on `47fa0e7` plus a patch, and the developer-reported browser demo.
- **Untracked evidence:** at `9880430`, git still doesn't track the 33 files of `hot-account-84e77ce8`, `hot-account-bc7adbf3` and `many-accounts-06e6a282`. They exist only in the developer's working copy, and a clone of the repository doesn't have them. Every citation of them in this report (the addendum after revision 3, R32, F6, F11), `docs/LOAD_TEST.md` §9 and `docs/TEST_PLAN.md` §9 depends on those local files. Every run cited in `README.md` and `docs/LOAD_TEST.md` §1–§8 is committed.
- **Documentation follow-up on top of `9880430`:** `README.md` now states the Docker Engine and Compose minimum (F9) and documents that `perRequestLimit > monthlyLimit` is accepted and what it means for consumes (F8). These README changes weren't committed when this addendum was written. The table statuses of F8 and F9 are kept as they were at revision 4.

**Phase 2 (test design):** the proposed tests for F10, F1/F2 regressions, restart persistence, the 200-VU overload run (F6) and the F8 decision are in [TEST_PLAN.md](TEST_PLAN.md). It adds no findings and changes no status in this report. Its revision 2 (§8 there) records which of those planned tests have been executed. Its later revisions add §9 (TP-LOAD-04), §10 (TP-REG-01) and §11 (the F12 and F13 tests). Together, §8–§11 are its execution record.

### 1. Scope and method

**Read (revision 1):** every file under `src/`, `drizzle/0000_init.sql`, `client/src/*`, `client/public/index.html`, `docker-compose.yml`, both Dockerfiles, `docker-entrypoint.sh`, `.env.example`, `README.md`, `docs/PLAN.md` §3–§6, `docs/LOAD_TEST.md`, and the test inventory (`tests/*.ts`).

**Read (revision 2):** `git diff` of the working tree, `tests/input-encoding.db.test.ts`, `src/app.ts`, `src/middleware/errors.ts`, `src/lib/schemas.ts`, `src/routes/{accounts,plans,users}.ts`, `src/db/migrate.ts`, `docker-entrypoint.sh`, `load/run.sh`, `docs/PLAN.md` (full), `docs/LOAD_TEST.md` §2–§7, the README sections cited below, and every file of the two untracked load runs `hot-account-bc7adbf3` and `many-accounts-06e6a282`. The rest of `src/`, `client/` and `tests/` is unchanged since `e1ab78e` (`git diff e1ab78e --stat`), so revision 1's reading of it stands; a sample of its line references was re-checked.

**Run in revision 1** (previously reported, not rerun as such):

| Command | Result |
|---|---|
| `REQUIRE_DB=1 npx vitest run` (against `quota_test`) | 21 files, 371 tests passed, 0 failed |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| Edge-case probe: a tsx script outside the repo that drives `createApp()` with Supertest against `quota_test` | see §5 (F1, F2, F8) |

**Run in revision 2** (independently verified in this review, on the working tree):

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| `REQUIRE_DB=1 npx vitest run` (against `quota_test`) | **22 files, 400 tests passed**, 0 failed (70.2 s) |
| HTTP probe: a tsx script in the session scratchpad that runs `createApp()` on a real socket against `quota_test` and sends raw requests with `node:http` | see §5: F1 and F2 fixed, F3 and F8 unchanged, new F10 |
| Direct `pg` query: `SELECT $1::text = $2::text` with `'\ud800'`, `'\udfff'` | `same: true`, both stored as `efbfbd` (U+FFFD); cause of F10 |
| `docker compose exec api` on the running dev stack: grep the built `dist/` for the fixes, `ps` | image built 2026-10-19 19:19:11Z contains the NUL check and `undecodableParamNotFound`; one `node` process |
| Clean clone of `47fa0e7` + working-tree patch + `tests/input-encoding.db.test.ts`, then `docker compose -p qafresh up --build -d --wait` (only change: API published on host port 13000, `DB_PORT=15433`, `CLIENT_PORT=18081`, because the dev stack holds the defaults) | exit 0, db, api and client all healthy; see R59 |
| On that stack: `/healthz`, `POST /accounts`, `GET /plans`, `POST /consume`, malformed URL and NUL requests, client `GET /`, client `POST /demo/run`, then `down` (volume kept) + `up` and re-read | see R49, R59, R60; torn down with `down -v --rmi local` afterwards |

**Not run in revision 2:** `load/run.sh`, `load/compare.sh`, `load/uncontended.sh` (they write into `load/results/`, which this review doesn't modify). The newest load evidence was produced by the developer; it was inspected, not reproduced (§5, F6 and F11). The client page was fetched (HTTP 200, `text/html`) but not rendered in a browser.

**Read (revision 3):** `docs/REQUIREMENTS.md`, `docs/TEST_PLAN.md`, `git show --stat b56dbc0`, `src/app.ts`, `src/lib/schemas.ts`, `src/lib/cursor.ts`, `src/routes/{consume,users}.ts`, `src/middleware/errors.ts` (mapping of body-parser errors), `tests/input-encoding.db.test.ts`, `tests/helpers/*`, and `node_modules/body-parser/lib/{read.js,types/json.js}` (charset and `verify` handling, body-parser 2.3.0).

**Run in revision 3, before the fix** (code at `b56dbc0`, only the two new test files added):

| Command | Result |
|---|---|
| `REQUIRE_DB=1 npx vitest run tests/unicode-schemas.test.ts tests/unicode-input.db.test.ts` | 2 files failed; **63 failed, 23 passed** (86). Every failure is an F10 case (TP-UNIT-01/02, TP-ENC-01…04, TP-ENC-08, TP-IDEM-01…04); every valid-Unicode guard passed |
| `REQUIRE_DB=1 npx vitest run` | 24 files (2 failed, 22 passed); **63 failed, 423 passed** (486), 0 skipped. The 22 existing files (400 tests) all passed |
| Raw-socket probe: a tsx script in the session scratchpad, `createApp()` on a real port, `node:http` bodies with raw bytes | invalid UTF-8 in a JSON body collides on the full app (F10, "Variant") |
| `iconv-lite` probe (the decoder body-parser uses) on invalid UTF-16LE, UTF-16, UTF-32LE, UTF-7 input | UTF-32 values above U+10FFFF → U+FFFD; a trailing odd UTF-16 byte is dropped; UTF-16, UTF-32 and UTF-7 can yield lone surrogates (F10, "Resolution") |

The first run of the two files reported 58 failed / 27 passed: the five TP-ENC-08 tests passed **falsely**. Supertest (superagent 10.4.1) JSON-serializes a `Buffer` sent with a JSON `Content-Type`, so the server received `{"type":"Buffer","data":[…]}` and the strict schema returned 400. The test helper now sends the bytes unchanged (`.serialize((data) => data)`, `tests/unicode-input.db.test.ts:72-79`) and a valid-bytes positive control guards it (`:244`). The counts above are from the corrected tests. No existing test sends a `Buffer` this way.

**Run in revision 3, after the fix** (`b56dbc0` + the uncommitted F10 changes; the two test files unchanged since the red run until the commit-prep edit below):

| Command | Result |
|---|---|
| `REQUIRE_DB=1 npx vitest run tests/unicode-schemas.test.ts tests/unicode-input.db.test.ts` | 2 files, **86 passed** |
| `REQUIRE_DB=1 npx vitest run` | **24 files, 486 passed**, 0 failed, 0 skipped |
| `npm run typecheck`, `npm run lint`, `npm run build` | exit 0 each |
| Charset probe: the same 20 `POST /accounts` requests against `createApp()` from `HEAD` (`b56dbc0`, exported with `git archive` to the scratchpad) and from the fixed working tree | 6 of 20 differ, all intended (F10, "Compatibility") |

**Commit-prep review in revision 3** (after the runs above): the two test files were reviewed byte by byte. Writing them had stored the `\uXXXX` escapes for *valid* characters as the literal characters. Lone surrogates can't be stored that way, so every F10 input was sent as intended. The values were the same, with one exception: **TP-IDEM-06** (`tests/unicode-input.db.test.ts:386`) was meant to send the JSON escape `\ud83d\ude00` but held a literal 😀, so it sent the same raw UTF-8 twice and never tested the escaped form. That test's earlier pass didn't cover its stated purpose. Fixed: that body now contains the escape, and the other valid-Unicode literals (`\ufffd`, `\ud83d\ude00`, `\ud83d\ude01`, `\u00e9`, `e\u0301`, `\u200d`) are written as escapes, with unchanged values. The headers of both files no longer say the cases "fail until the F10 fix lands", and the TP-ENC-08 comment names the actual decoder (iconv-lite, not WHATWG). No assertion changed and no line moved, so the line references in this report still hold. The F10 files and the full suite (`REQUIRE_DB=1`) were rerun afterwards with the same counts, 86 and 486 passed, and typecheck, lint and build were clean.

**Not run in revision 3:** any load script (TP-LOAD-04), the Compose stack (not rebuilt; the running containers still serve the pre-fix image), TP-REG-01 on a clean checkout of `b56dbc0`, and Node versions other than 22.15.0.

**Read (revision 4):** `src/lib/schemas.ts`, `src/app.ts`, `src/middleware/errors.ts`, `src/routes/{users,plans,accounts,consume,usage}.ts`, `client/src/quota-api.ts`, `client/src/demo.ts`, `load/{lib,hot-account,many-accounts,retry-storm}.js`, `load/run.sh`, `load/compare.sh`, `tests/{unicode-schemas,quota-api,errors}.test.ts`, `tests/{unicode-input,input-encoding}.db.test.ts`, `tests/helpers/db.ts`, the README assumptions, `node_modules/superagent/lib/node/index.js` (`preserveDotSegments`), and the `-env.txt` and `SUMMARY_JSON` lines of every run in `load/results/`.

**Run in revision 4** (on `1468d11` + the working tree):

| Command | Result |
|---|---|
| `node -e` probe of `new URL(path, base).pathname` | `/users/../plan` → `/plan`; `/users/./plan` → `/users/plan`; `/users/%2E%2E/plan` and `/users/.%2E/plan` → `/plan` (F12) |
| Read-only `SELECT … FROM users WHERE external_user_id IN ('.', '..')` on the Compose dev database | 0 rows; 14,508 users in total (F12, existing data) |
| `REQUIRE_DB=1 npx vitest run tests/dot-segment-ids.test.ts tests/dot-segment-ids.db.test.ts` with the schema refinement and the client guard temporarily disabled | **17 failed, 17 passed** (34). Every failure is an F12 case; the 17 passes are controls and look-alike IDs (`...`, `a.b`, `.alice`, `%2E%2E`) |
| The same, with both restored | **34 passed** |
| `npx vitest run tests/load-duration.test.ts` with the `load/run.sh` check temporarily removed | **13 failed, 26 passed** (39). The 13 failures are the invalid `DURATION` values against `run.sh` |
| The same, with the check restored | **39 passed** |
| `docker compose --profile load run --rm --no-deps k6 inspect /scripts/hot-account.js` (k6 1.3.0; init code only, no requests) | exit 0; scenario `duration: "30s"`, `vus: 50` |
| The same with `k6 inspect -e DURATION=20s` | exit 0; `duration: "20s"` |
| The same with `k6 inspect -e DURATION=1m` | **exit 107**, `DURATION must be whole seconds such as 30s or 90s, got "1m"`, thrown from `durationSeconds` (`/scripts/duration.js:10`) called at `/scripts/lib.js:16` |
| `REQUIRE_DB=1 npx vitest run` | **27 files, 559 passed**, 0 failed, 0 skipped |
| `npm run typecheck`, `npm run lint`, `npm run build`; `npx tsc --noEmit -p .` in `client/` | exit 0 each |

The disabled-guard runs changed `src/lib/schemas.ts`, `client/src/quota-api.ts` and `load/run.sh` for a few seconds each and restored them from copies; the final diffs were checked afterwards. The first version of the F12 path tests passed in the red run: no `.` user existed, so the 404 didn't depend on the rule. They now store a user with that ID first, and the 17 red failures above are from the corrected tests. A `DURATION` passed as a container variable (`docker compose run -e DURATION=1m k6 …`) never reaches k6's `__ENV`; that check exited 0 with `duration: "30s"` and tested nothing. `load/run.sh` passes it as a k6 flag (`k6 run -e DURATION=…`, `load/run.sh:97`), which is what the `inspect -e` checks above use.

**Not run in revision 4:** any load script (`load/run.sh`, `compare.sh`, `uncontended.sh`), migrations, the Compose images (not rebuilt; the running `api` and `client` containers serve `1468d11`), and Node versions other than 22.15.0.

**Status values:** Fully Implemented · Partially Implemented · Missing · Unable to Verify. Each requirement has exactly one status. A status based on uncommitted code says so in Notes.

### 2. Summary

| Status | Rev 1 | Rev 2 | Rev 3 | Rev 4 |
|---|---:|---:|---:|---:|
| Fully Implemented | 72 | 75 | 76 | 76 |
| Partially Implemented | 3 | 3 | 2 | 2 |
| Missing | 0 | 0 | 0 | 0 |
| Unable to Verify | 2 | 0 | 0 | 0 |
| **Total** | 77 | 78 | 78 | 78 |

Rev 2 changes: R59 and R64 Unable to Verify → Fully Implemented; R68 Partially → Fully Implemented (in the revision 2 working tree); new R78 Partially Implemented. Rev 3 changes: R78 Partially → Fully Implemented (F10 resolved; see Commit state). Rev 4: no status changes. F12 and F13 were found and fixed in the same revision, and neither leaves a requirement short in the revision 4 working tree. No revision of this report reviewed or tested `9880430` (see the addendum after revision 4).

| ID | Severity | Status (rev 3; unchanged since rev 2 unless marked) | Finding |
|---|---|---|---|
| F1 | Medium | **Resolved, committed in `b56dbc0`** (rev 3) | A malformed percent-encoding in a URL path parameter returned 500 instead of 400/404 |
| F2 | Medium | **Resolved, committed in `b56dbc0`** (rev 3) | A NUL character (`\u0000`) in any string input passed validation and returned 500 |
| F10 | Medium | **Resolved** (rev 3; not in `b56dbc0`, see Commit state) | Lone UTF-16 surrogates in IDs are silently replaced with U+FFFD, so distinct `requestId`s and `externalUserId`s collide; a new request can be answered as a replay and not metered |
| F3 | Low | Open | A past month's `remaining` is computed against the current plan |
| F4 | Low | Open | History doesn't snapshot plan limits, so a later PATCH changes what a stored plan ID means |
| F5 | Low | Open | No bulk per-user usage read |
| F6 | Low | Open (re-confirmed) | The 200-VU load evidence predates the 503 overload mapping |
| F7 | Low | Open | The hot-account bottleneck has no implemented improvement |
| F11 | Low | **Open (new)** | The newest load runs are uncommitted, uncited, and disagree with the documented baseline; one reports 2 API processes under `WORKERS=1` |
| F12 | Low | **Resolved** (rev 4; committed in `3c39c71`, not in `1468d11`) | `.` and `..` were accepted as `externalUserId`, but `fetch` and `new URL()` resolve them as dot segments, so such a user couldn't be addressed by path; the example client sent `PUT /users/../plan` as `PUT /plan` |
| F13 | Low | **Resolved** (rev 4; committed in `b5a3486`, not in `1468d11`) | The load summary computed req/s with `parseFloat(DURATION)`, so `1m` counted as 1 s and `500ms` as 500 s. Latent: every recorded run used `20s` or `30s`, so no result is affected |
| F8 | Info | Open (re-confirmed) | `perRequestLimit > monthlyLimit` is accepted and not documented |
| F9 | Info | Open (unverifiable here) | The Compose healthcheck's `start_interval` needs Docker Engine 25+, which isn't stated |

**Rev 2 (`47fa0e7` + the uncommitted working tree):** the core (consume transaction, rule evaluation, idempotency for well-formed IDs, isolation, plan changes, month handling) matches the brief and is well tested. The two Medium input-handling findings from revision 1 are fixed in the working tree and covered by tests, but when revision 2 was written the fix wasn't committed, so a clone at that time still had the old behavior. It was committed in `b56dbc0` (Rev 3 below). F10 is the only open finding that can change a decision: it needs ill-formed UTF-16 in an ID, which a normal client doesn't send, but when it happens it is silent.

**Rev 3:** F1 and F2 are committed (`b56dbc0`). F10 is fixed (see Commit state): lone surrogates in any caller-supplied string, and request bodies that aren't valid UTF-8 or declare another charset, are now rejected with 400. All 63 F10 tests that failed before the fix pass, and the full suite passes (486 tests). `b56dbc0` itself still has F10. At revision 3, no open finding left could change a decision.

**Rev 4:** two new Low findings, F12 and F13, are fixed (not in `1468d11`; the fixes were uncommitted when this was written, see Commit state (revision 4), and have since been committed as `3c39c71` and `b5a3486`) and covered by 73 new tests: 34 for F12 and 39 for F13. Each fix was shown to be needed by a red run (§1). The full suite passed on the revision 4 tree (559 tests). F1, F2 and F10 were re-checked against `1468d11` and are unchanged. At revision 4, no open finding left could change a decision. Revision 4 doesn't change the load or planned-test results: TP-LOAD-04 is still not passed (77.3 req/s against the 85.2 req/s lower bound; see the addendum after revision 3), 29 of the 54 planned tests in `docs/TEST_PLAN.md` are still not run (§10 there), and the items in §7 are still unverified.

### 3. Traceability matrix

E = explicit in the brief, I = implicit (follows from the brief or required for it to hold). Line references are to the working tree in revision 2. Notes marked "Rev 3" cite the revision 3 working tree. Revision 3 shifted lines in `src/lib/schemas.ts` and `README.md`, so revision 2 references into those two files are now a few lines off (for example, the NUL assumption `README.md:1289` is now `:1290`; rev 4: `:1291`). *Addendum:* the exact README shift from `b56dbc0` (the revision 2 numbering) to `1468d11`, per `git diff b56dbc0 1468d11 -- README.md`: lines up to 147 are unchanged; 148–1289 move by +1; 1290–1334 by +3; 1335 and later by +4. The cited text is the same. References marked "Rev 3" already use the `1468d11` numbering. §6 and the open findings F6 and F11 also give the `1468d11` line. *Rev 4:* the README shift from `1468d11` to the revision 4 working tree, per `git diff -U0 1468d11 -- README.md`, is: lines up to 1289 unchanged; 1290–1332 move by +1; 1333 and later by +2. The cited text is the same. Revision 4 adds the new line next to every `1468d11`-numbered README reference at or after line 1290 (as "rev 4: `:N`"), and its own references use the revision 4 numbering. References in older numbering are left as written; this chain of shifts still resolves them. Revision 4 also moves lines in four code files, per `git diff -U0 1468d11` on each: `src/lib/schemas.ts` 38 and later +7; `client/src/quota-api.ts` 52 and later +12; `load/lib.js` 5–13 +1, 14 and later +3; `load/run.sh` 14–22 +1, 23 and later +4. References marked "at `1468d11`" use the old numbering, and revision 4's own references use the new one. The two `1468d11`-numbered references into these files that moved get the new line inline (R51, F11).

#### 3.1 Accounts, users and API keys

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R1 | E: Create accounts and issue an API key for each | `src/routes/accounts.ts:18-21`, `src/services/accounts.service.ts:20-39`, `src/lib/api-key.ts:6-8` | `tests/accounts.db.test.ts:31`, `:89` | Fully Implemented | Key is returned once and stored only as SHA-256. Rev 2: also exercised on the fresh Compose stack |
| R2 | E: Register users under accounts | `src/routes/users.ts:43-46`, `src/services/users.service.ts:30-51` | `tests/users.db.test.ts:39`, `:53`, `:76` | Fully Implemented | Default plan Basic; duplicate → 409 |
| R3 | E: Assign or change users' plans | `src/routes/users.ts:64-68`, `src/services/users.service.ts:98-105` | `tests/users.db.test.ts:125`, `:138`, `:149` | Fully Implemented | Rev 4: a user registered as `.` or `..` couldn't be re-planned by path through a URL-resolving client (F12). Those IDs are now rejected (`tests/dot-segment-ids.db.test.ts`) |
| R4 | E: Keep each account's users and usage separate | Every query filters `account_id`, e.g. `src/services/users.service.ts:92`, `src/services/usage.service.ts:42`; composite FKs `src/db/schema.ts:115-119`, `:153-157` | `tests/isolation.db.test.ts:47-126`, `tests/usage.db.test.ts:213-251`, `tests/requests.db.test.ts:297-308`, `tests/schema.db.test.ts:175`, `:190` | Fully Implemented | F10 aliases IDs within one account only; it never crosses accounts. Rev 3: F10 resolved (see Commit state) |
| R5 | E: Calling application supplies an API key in a request header | `src/middleware/auth.ts:24-40`, mounted in `src/app.ts:33-39` | `tests/accounts.db.test.ts:97`, `:115` | Fully Implemented | Header `X-API-Key` |
| R6 | E: Reject missing or invalid keys | `src/middleware/auth.ts:27-36` | `tests/errors.test.ts:141`, `:146`, `tests/accounts.db.test.ts:104`, `:108`, `tests/consume.db.test.ts:677`, `tests/input-encoding.db.test.ts:89` | Fully Implemented | 401 on every authenticated route, including an empty header. Rev 2: auth still runs before the malformed-parameter mapping (probe: `GET /users/%ZZ` without a key → 401) |
| R7 | E: The key grants access only to that account's data | Scoped queries as R4; plan visibility `src/services/plan-guard.ts:10-12` | `tests/isolation.db.test.ts:70-126` | Fully Implemented | Another account's resource is 404 |
| R8 | E: Validate that any supplied user belongs to the identified account | `src/services/consume.service.ts:64-68`, `src/services/requests.service.ts:44-51`, `src/services/usage.service.ts:42` | `tests/consume.db.test.ts:672`, `tests/usage.db.test.ts:245`, `:251`, `tests/requests.db.test.ts:302` | Fully Implemented | |
| R9 | I: API keys are not stored in plaintext | `src/services/accounts.service.ts:30`, `src/lib/api-key.ts:15-17`, `src/db/schema.ts:57` | `tests/lib.test.ts:8`, `:15` | Fully Implemented | |

#### 3.2 Plans

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R10 | E: Predefined account and user plans exist when the service starts | `src/db/seed.ts:20-25`, `:32-40`, `docker-entrypoint.sh:5-7` | `tests/schema.db.test.ts:80`, `:101`, `:108` | Fully Implemented | Fixed UUIDs, idempotent seed. Rev 2: fresh stack logged `seed: 4 predefined plan(s) inserted`, then `0` after a restart; `GET /plans` returned all four |
| R11 | E: Sensible example limits, documented | `src/db/seed.ts:21-24`; README "Predefined plans" (`README.md:1162`) | `tests/schema.db.test.ts:80` | Fully Implemented | Starter 10,000/100, Pro 100,000/1,000, Basic 1,000/20, Premium 5,000/100 (confirmed on the fresh stack) |
| R12 | E: An account can create, view and update its own plans | `src/routes/plans.ts:42-63`, `src/services/plans.service.ts:13-82` | `tests/plans.db.test.ts:38`, `:89`, `:119`, `:137`, `:156` | Fully Implemented | |
| R13 | E: Custom plans can be assigned to the account or its users | `src/services/plan-guard.ts:30-47`, `src/services/accounts.service.ts:64-68`, `src/services/users.service.ts:31`, `:102` | `tests/accounts.db.test.ts:160`, `tests/users.db.test.ts:53` | Fully Implemented | One guard: ownership (404) before type (400) |
| R14 | E: Several users may share a plan with separate usage totals | Usage keyed by user, `src/db/schema.ts:103-123` | `tests/usage.db.test.ts:115` | Fully Implemented | |
| R15 | E: Predefined plans can remain read-only | `src/services/plans.service.ts:56-62`, `src/routes/plans.ts:57-63` | `tests/plans.db.test.ts:163`, `:191` | Fully Implemented | 403 regardless of body |
| R16 | I: Plan type can't be assigned to the wrong target | `src/services/plan-guard.ts:43-45` | `tests/accounts.db.test.ts:168`, `tests/users.db.test.ts:63`, `:138` | Fully Implemented | |
| R17 | I: Plan limits validated (non-negative monthly, positive per-request, int32) | `src/routes/plans.ts:14-15`; DB CHECKs `src/db/schema.ts:49-50` | `tests/plans.db.test.ts:53`, `:60`, `:176`, `tests/schema.db.test.ts:263`, `:274` | Fully Implemented | See F8 for the cross-field case |

#### 3.3 Consuming units and decisions

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R18 | E: Identify the account through its API key | `src/routes/consume.ts:21` (`accountOf(req)`) | `tests/consume.db.test.ts:677` | Fully Implemented | |
| R19 | E: Accept a user identifier, a positive whole number of units, and a request identifier | `src/routes/consume.ts:9-13`, `src/lib/schemas.ts:14-16` (`textSchema`, NUL), `:22-29` (`callerIdSchema`, `externalUserIdSchema`), `:59` (`requestIdSchema`) | `tests/consume.db.test.ts:683`, `:710`, `:734`, `tests/input-encoding.db.test.ts:104-121` | Fully Implemented | Strings like `"5"` and fractions are 400. Rev 2: NUL now 400 (F2 resolved, working tree). Exact preservation of the identifiers is tracked separately as R78 (F10). Rev 3: unpaired surrogates (`src/lib/schemas.ts:19-24`) and bodies that aren't UTF-8 (`src/app.ts:30-37`) are 400 too, `tests/unicode-input.db.test.ts:111-158`, `:219-281`. Rev 4: `externalUserId` also rejects exactly `.` and `..` (`src/lib/schemas.ts:42-44`, F12): 400 in a body or query, `tests/dot-segment-ids.test.ts`, `tests/dot-segment-ids.db.test.ts` |
| R20 | E: Accept the full amount only if all account and user rules allow it | `src/services/rules.ts:63-90` | `tests/rules.test.ts:21-155` | Fully Implemented | |
| R21 | E: A rejection consumes nothing | `src/services/rules.ts:91`, `src/services/consume.service.ts:131-140` | `tests/consume.db.test.ts:172` | Fully Implemented | Rejections are still recorded |
| R22 | E: Return whether the request was accepted | `src/services/consume.service.ts:23-33` | `tests/consume.db.test.ts:98` | Fully Implemented | 200 for both outcomes |
| R23 | E: On rejection, identify the rule and whether it belongs to the account or user | `src/services/rules.ts:100-106` (`reasonCode`, `rejectedBy`, `limit`) | `tests/consume.db.test.ts:120`, `:134`, `tests/rules.test.ts:103-155` | Fully Implemented | Deterministic order, first failure wins |
| R24 | E: Callers can inspect the plans and limits currently applied to each | `GET /account` `src/services/accounts.service.ts:42-61`; `GET /users/:id` `src/services/users.service.ts:78-95` | `tests/accounts.db.test.ts:124`, `tests/users.db.test.ts:90` | Fully Implemented | |
| R25 | I: Unit counts can't overflow the storage type | `src/lib/schemas.ts:5`, `src/routes/consume.ts:11`; accepted totals bounded by `monthlyLimit` ≤ int32 | `tests/consume.db.test.ts:734`, `tests/plans.db.test.ts:53` | Fully Implemented | |

#### 3.4 How plans affect consumption

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R26 | E: Monthly allowance per UTC calendar month, at both levels | `src/services/rules.ts:76-87`, `src/lib/month.ts:5-16` | `tests/rules.test.ts:57`, `:67`, `tests/month.test.ts:5-76` | Fully Implemented | Independent of process time zone |
| R27 | E: Maximum units per request, at both levels | `src/services/rules.ts:64-75` | `tests/rules.test.ts:35`, `:46`, `:157`, `:174` | Fully Implemented | |
| R28 | E: Every request must satisfy both plans | `src/services/consume.service.ts:108-128` | `tests/consume.db.test.ts:153` | Fully Implemented | A larger user plan doesn't raise the account cap |
| R29 | E: Example: 25 units rejected by the user per-request limit | `src/services/rules.ts:64-69` | `tests/consume.db.test.ts:120` | Fully Implemented | |
| R30 | E: Example: 10 units accepted adds 10 to user and account | `src/services/consume.service.ts:131-140` | `tests/consume.db.test.ts:98` | Fully Implemented | Rev 2: also on the fresh stack (10 units → remaining 9,990 / 990) |
| R31 | E: Example: 10 units rejected when the account has 5 left | `src/services/rules.ts:82-87` | `tests/consume.db.test.ts:134` | Fully Implemented | |
| R32 | E: Account usage = sum of accepted usage across its users | Both rows incremented in one transaction, `src/services/consume.service.ts:131-140` | `tests/consume.db.test.ts:489`, `:523`; `load/check-invariants.sql` | Fully Implemented | Rev 2: checks 1 and 4 also 0 in the two 2026-10-19 runs (`*-bc7adbf3-sql.txt`, `*-06e6a282-sql.txt`) |
| R33 | E: Users sharing a plan don't share their individual allowance | As R14 | `tests/usage.db.test.ts:115` | Fully Implemented | |
| R34 | E: New usage belongs to the UTC month in which it is processed | One clock read, `src/services/consume.service.ts:76-77` | `tests/usage.db.test.ts:58`, `tests/month.test.ts:100` | Fully Implemented | |
| R35 | E: Each new month starts at zero; previous months stay queryable | `(account_id, month)` / `(user_id, month)` keys, `src/db/schema.ts:97`, `:113` | `tests/consume.db.test.ts:467`, `tests/usage.db.test.ts:164` | Fully Implemented | |
| R36 | I: Concurrent requests can't over-consume | Row locks in fixed order, `src/services/consume.service.ts:89-101` | `tests/consume.db.test.ts:489`, `:510`; load invariants (`docs/LOAD_TEST.md:96`) | Fully Implemented | |

#### 3.5 Changing and extending rules

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R37 | E: Plan settings change without redeploying | Plans read per request, `src/services/consume.service.ts:108-119` | `tests/consume.db.test.ts:369`, `:392` | Fully Implemented | |
| R38 | E: Plan changes apply to new requests after the update succeeds | Plans read after the lock, at READ COMMITTED, `src/services/consume.service.ts:108-119` | `tests/consume.db.test.ts:523` | Fully Implemented | In-flight request may use the old plan; documented `README.md:1205` |
| R39 | E: Updating a custom plan affects its assigned account or users | `src/services/plans.service.ts:65-82` | `tests/consume.db.test.ts:392` | Fully Implemented | |
| R40 | E: Switching plans preserves units already consumed | Usage not keyed by plan; `src/services/accounts.service.ts:64-68`, `src/services/users.service.ts:98-105` | `tests/accounts.db.test.ts:151`, `tests/users.db.test.ts:125`, `tests/consume.db.test.ts:351` | Fully Implemented | |
| R41 | E: Allowance reduced below usage → remaining 0, further consumption rejected | `src/services/rules.ts:92-95`, `src/services/views.ts:27` | `tests/rules.test.ts:240-275`, `tests/consume.db.test.ts:351`, `:369`, `tests/accounts.db.test.ts:142` | Fully Implemented | |
| R42 | E: Changes preserve past request history | Request rows never updated; plan IDs snapshotted, `src/services/consume.service.ts:142-162` | `tests/consume.db.test.ts:416` | Fully Implemented | Limits themselves aren't snapshotted for accepted rows, see F4 |
| R43 | E: Explain how any additional rules interact with plans, and demonstrate them | README "Supported rules" (`README.md:1145-1160`) | n/a | Fully Implemented | No additional rules are implemented (`README.md:1152`); the README explains how one would fit |

#### 3.6 Usage and history

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R44 | E: Return consumed and remaining units for the account | `GET /usage`, `src/routes/usage.ts:28-31`, `src/services/usage.service.ts:12-25` | `tests/usage.db.test.ts:51`, `:65` | Fully Implemented | |
| R45 | E: Return consumed and remaining units for its users | `GET /users/:id/usage`, `src/routes/users.ts:58-62`, `src/services/usage.service.ts:28-45` | `tests/usage.db.test.ts:96`, `:136` | Fully Implemented | One user per call, see F5 |
| R46 | E: View previous months' usage | `?month=YYYY-MM`, `src/lib/schemas.ts:42-56` | `tests/usage.db.test.ts:73`, `:164` | Partially Implemented | `consumed` is exact; `remaining` uses the current plan, see F3 (re-confirmed by probe in rev 2) |
| R47 | E: View previous request outcomes | `GET /requests`, `src/services/requests.service.ts:42-78` | `tests/requests.db.test.ts:85`, `:190`, `:206` | Fully Implemented | Filters `month`, `externalUserId` |
| R48 | E: Simple pagination for history | Cursor on `(created_at, id)`, `src/services/requests.service.ts:53-77`, `src/lib/cursor.ts` | `tests/requests.db.test.ts:139`, `:157`, `:166`, `:179` | Fully Implemented | |
| R49 | E: Persist accounts, users, plans, assignments, usage and history | `src/db/schema.ts`; Compose volume `docker-compose.yml:10-11`, `:67-68` | All `*.db.test.ts` read back from PostgreSQL | Fully Implemented | Rev 2, verified manually on the fresh stack: after `docker compose down` (volume kept) and `up`, the same API key still authenticated, `GET /usage` returned `consumed: 10`, `GET /requests` returned the request, a retry of `qa-1` returned `replayed: true`, and the seed inserted 0 plans. Still no automated restart test |
| R50 | I: Reads never create usage rows | LEFT JOINs in `src/services/usage.service.ts:18-21`, `:34-41` | `tests/usage.db.test.ts:65`, `:136`, `tests/accounts.db.test.ts:135` | Fully Implemented | |

#### 3.7 Example client

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R51 | E: Small working client calls the service with an account's API key on behalf of users | `client/src/server.ts:17-21`, `client/src/quota-api.ts:52-118` (rev 4: `:64-130`) | `tests/demo.db.test.ts:30`, `tests/quota-api.test.ts:45-59` | Fully Implemented | Server-to-server; key never reaches the browser. Rev 2: `POST /demo/run` on the fresh Compose stack completed. Rev 4: `QuotaApi.setUserPlan` sent `.` and `..` to the wrong path (F12); it now refuses them before sending (`client/src/quota-api.ts:57-62`, `tests/dot-segment-ids.test.ts`). The demo uses `alice` and `bob` and is unaffected |
| R52 | E: Users under the same account with different plans | `client/src/demo.ts:106-112` (Alice on Basic, Bob on Premium) | `tests/demo.db.test.ts:30` | Fully Implemented | |
| R53 | E: Show an accepted action | `client/src/demo.ts:122` | `tests/demo.db.test.ts:30` | Fully Implemented | Rev 2: present in the fresh-stack demo output |
| R54 | E: Show a rejection by a user limit | `client/src/demo.ts:123` | `tests/demo.db.test.ts:30` | Fully Implemented | `USER` / `PER_REQUEST_LIMIT_EXCEEDED` (also in the fresh-stack demo output) |
| R55 | E: Show a rejection by the shared account limit | `client/src/demo.ts:53-59`, `:141-143` | `tests/demo.db.test.ts:30` | Fully Implemented | `ACCOUNT` / `MONTHLY_LIMIT_EXCEEDED` (also in the fresh-stack demo output, last step) |
| R56 | E: Configure or switch a plan and show the effect without changing client code | `client/src/demo.ts:97-104` (custom plan), `:125-139` (switch, same call) | `tests/demo.db.test.ts:30` | Fully Implemented | Fresh-stack demo output: REJECTED (USER) followed, after the switch step, by ACCEPTED |
| R57 | E: Display the decision and remaining allowances | `client/public/index.html:57`, `:102-116` | `tests/demo.db.test.ts:30` (data only) | Fully Implemented | Page served (HTTP 200, `text/html`) on the fresh stack; rendering not viewed in a browser |
| R58 | E: Instructions for running the example | `README.md:44-60` | n/a | Fully Implemented | |

#### 3.8 Local setup

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R59 | E: `docker compose up --build` starts service, PostgreSQL and client | `docker-compose.yml:1-53`, `Dockerfile`, `client/Dockerfile` | `tests/compose.test.ts` (static checks of the file; at `9880430` `:44-60` for the DB and API, `:62-73` for the client); rev 2 manual run | Fully Implemented | Rev 1: Unable to Verify. Rev 2: clean clone of `47fa0e7` plus the working-tree patch, `docker compose up --build -d --wait` → exit 0, all three services healthy, no manual steps. Caveats: Docker 29.9.0 / Compose 5.6.0 only (F9); API host port remapped with an override file because the dev stack held port 3000; Docker's layer cache was warm. The committed tree alone (without the patch) was not started separately |
| R60 | E: Database initialization and predefined plan setup on startup | `docker-entrypoint.sh:5-7`, `src/db/migrate.ts`, `src/db/seed.ts:32-40` | `tests/schema.db.test.ts:80-114` | Fully Implemented | Rev 2: fresh-stack API log shows migrate → `seed: 4 predefined plan(s) inserted` → `listening`; after restart, `seed: 0` |
| R61 | E: Document required configuration and how to access the client | `README.md:24-42`, `:85-106`, `.env.example` | n/a | Fully Implemented | Docker Engine minimum not stated, see F9 |

#### 3.9 Performance and reliability

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R62 | E: Totals and decisions stay correct as rules change and requests arrive concurrently | `src/services/consume.service.ts:79-172` | `tests/consume.db.test.ts:268`, `:489-549`; invariants after every load run (`docs/LOAD_TEST.md:96`) | Fully Implemented | Load runs never change plans mid-run; the plan-change race is covered by `tests/consume.db.test.ts:523` only |
| R63 | E: Test under load and include evidence, method and lessons | `docs/LOAD_TEST.md`, `load/*.js`, `load/run.sh`, `load/results/` | n/a | Fully Implemented | See F6 and F11 on evidence currency |
| R64 | E: Commit tests, scripts and configuration needed to reproduce, with commands and dependencies | `load/` (11 tracked scripts and SQL files), `docker-compose.yml:56-65`, `README.md:1395`, `docs/LOAD_TEST.md:53` | n/a | Fully Implemented | Rev 1: Unable to Verify. Rev 2: the developer reran `load/run.sh hot-account` and `many-accounts` on 2026-10-19 (19:26Z, 19:30Z) against an API image built at 19:19Z that contains the working-tree fixes (checked in the container). The artifacts are complete and the invariants are 0. **Not rerun by this review**; the new results are untracked (F11). Rev 4: `DURATION` must be whole seconds, documented in the `load/run.sh` usage text and `README.md:1415` (F13) |
| R65 | E (criterion): Understanding of bottlenecks | `docs/LOAD_TEST.md:109-200` | n/a | Fully Implemented | Hot-account row lock, single Node process. The 2026-10-19 hot-account run shows the same profile (8.21 of 9.94 connections waiting on the `account_usage` `FOR UPDATE`) |
| R66 | E (criterion): Improvements that preserve correctness | `WORKERS` cluster, `src/server.ts:24-138`; `docs/LOAD_TEST.md:242-392` | `tests/server.db.test.ts:111-161` | Partially Implemented | See F7 |
| R67 | E (criterion): Safe retries | Fast path + recheck under lock + 23505 net, `src/services/consume.service.ts:70-73`, `:103-106`, `:164-172` | `tests/consume.db.test.ts:218-343` | Fully Implemented | Retries of the same `requestId` are safe. Distinct ill-formed `requestId`s can be mistaken for retries, see R78 / F10. Rev 3: fixed (see Commit state); a different malformed key is now a 400, never a replay or a 409 (`tests/unicode-input.db.test.ts:166-217`, `:219-281`) |
| R68 | E (criterion): Useful errors | `src/middleware/errors.ts:14-26` (param decode → 404), `:37-72`; `src/lib/schemas.ts:14-16` (NUL → 400); `src/errors/codes.ts` | `tests/errors.test.ts:29-125`, `tests/input-encoding.db.test.ts` (whole file) | Fully Implemented | **Rev 2: working tree, uncommitted; since committed in `b56dbc0`.** Rev 1: Partially Implemented (F1, F2). Rev 2 probe: every malformed path parameter and NUL input tried is 400/404 and nothing reaches the 500 branch. Rev 4: `.` and `..` get the same 400/404 (F12), including `%2E`/`%2e` in a path, with no `console.error` (`tests/dot-segment-ids.db.test.ts`) |
| R69 | I: Overload is distinguishable from failure and safe to retry | `src/lib/pg-error.ts:26-33`, `src/middleware/errors.ts:59-69`, `src/db/client.ts:9-17` | `tests/consume.db.test.ts:578`, `:632`, `tests/errors.test.ts:99`, `:112` | Fully Implemented | 503 + `Retry-After: 1`. Not yet exercised under load (F6) |
| R70 | I: No deadlocks between concurrent consumes | Fixed lock order, `src/services/consume.service.ts:89-100` | `tests/consume.db.test.ts:489`, `:523` | Fully Implemented | |

#### 3.10 Deliverables, design and stack

| ID | Requirement | Implementation | Tests | Status | Notes |
|---|---|---|---|---|---|
| R71 | E: README covers API, model, API keys, supported rules, plan changes, retries, assumptions, design decisions, known limitations | `README.md:108`, `:121`, `:1145`, `:1187`, `:1194`, `:1213`, `:1273`, `:1327` | n/a | Fully Implemented | |
| R72 | E: Document assumptions for unspecified behavior | `README.md:1273-1325` | n/a | Fully Implemented | Rev 2 adds NUL and percent-encoding assumptions (`README.md:1284`, `:1289`); `README.md:1288` claims IDs are "compared exactly", which F10 contradicts. Rev 3: the claim now holds (`README.md:1289`); the surrogate and UTF-8 assumptions are at `:1291-1292` (rev 4: `:1292-1293`), the UTF-8-only limitation at `:1338` (rev 4: `:1340`), the convention at `:148` and the error table row at `:1101`. Rev 4: the dot-segment assumption is at `README.md:1290` and the matching known limitation at `:1334` (F12) |
| R73 | E: Automated tests for the important behaviors, including API key validation and account isolation | `tests/` (400 tests in rev 2) | `tests/accounts.db.test.ts:96-121`, `tests/errors.test.ts:127-150`, `tests/isolation.db.test.ts` | Fully Implemented | |
| R74 | E: One resource (units) throughout | Single `units` column/field | n/a | Fully Implemented | |
| R75 | E: TypeScript and SQL with PostgreSQL; one service, one database | `package.json`, `drizzle/0000_init.sql`, `docker-compose.yml:2` | n/a | Fully Implemented | |
| R76 | I: One error shape, details never exposed on 500 | `src/middleware/errors.ts:6-8`, `:70-71` | `tests/errors.test.ts:57` | Fully Implemented | |
| R77 | I: Decision shape enforced at the database | CHECK `src/db/schema.ts:162-175` | `tests/schema.db.test.ts:117-172` | Fully Implemented | |
| R78 | I (new in rev 2): Caller-supplied identifiers (`externalUserId`, `requestId`) are stored and compared exactly, so two different IDs never name the same user or request | `src/lib/schemas.ts:14-27`; README assumption `README.md:1288` ("compared exactly") | `tests/input-encoding.db.test.ts:154-162` (other control characters and non-ASCII round-trip). Rev 3: `tests/unicode-schemas.test.ts:40-72`, `tests/unicode-input.db.test.ts:111-405` | Fully Implemented (rev 3; see Commit state) | Rev 2: Partially Implemented. It held only for well-formed strings: lone UTF-16 surrogates were replaced with U+FFFD on the way to PostgreSQL (F10). Rev 3: input that would be altered on the way in is rejected instead (`src/lib/schemas.ts:19-24`, `src/app.ts:30-37`, `:46`), and valid Unicode, surrogate pairs, emoji and U+FFFD itself round-trip unchanged, with no normalization (TP-UNIT-03, TP-UTF-01/02, TP-IDEM-05…07) |

### 4. Edge cases checked and handled correctly

From revision 1, unchanged:

- A request that exactly reaches a per-request or monthly limit is accepted; the next unit is rejected (`tests/rules.test.ts:157-237`).
- `monthlyLimit: 0` rejects every request (`tests/rules.test.ts:80`, `:91`), documented at `README.md:1297`.
- The same `requestId` retried in the next month replays the original and counts nothing new (`tests/consume.db.test.ts:230`).
- 20 parallel copies of one `requestId` produce one increment (`tests/consume.db.test.ts:268`); two copies on different sides of a month boundary are caught by the unique-violation net (`tests/consume.db.test.ts:326`, `:343`).
- Process time zone doesn't affect month bucketing (`tests/month.test.ts:53-76`).
- Pagination ties on `created_at`, rows inserted mid-walk, and cursors pointing at another account's rows (`tests/users.db.test.ts:191-240`, `tests/requests.db.test.ts:139-179`, `:308`).
- Invalid or repeated `month`, invalid `limit`/`cursor`, unknown body fields, malformed JSON (`tests/usage.db.test.ts:81`, `:85`, `tests/users.db.test.ts:236`, `tests/errors.test.ts:30`).
- int32 boundary values on units and limits (`tests/consume.db.test.ts:734`, `tests/plans.db.test.ts:53`).
- Plan update racing parallel consumes: each decision matches the old or the new plan, invariant holds (`tests/consume.db.test.ts:523`).

Added in revision 2 (probe or test, on the working tree):

- Malformed percent-encoding on routes that don't exist for that method (`DELETE /plans/%ZZ`, `POST /users/%ZZ`) is a 404 in the standard shape, not a 500 (probe).
- A malformed percent-encoding in a **query** value (`GET /requests?externalUserId=%E0%A4%A`) is left undecoded by the query parser and answered 404 `User not found` (probe).
- An encoded lone surrogate in a path (`/users/%ED%A0%80`) can't reach the database: `decodeURIComponent` rejects it and the new mapping returns 404 (by code inspection of the router path; the probe covered the same mapping with `%E0%A4%A` and `%ZZ`).
- Other control characters (`\u0001`, tab) and non-ASCII names are still accepted and round-trip (`tests/input-encoding.db.test.ts:154-162`).
- A NUL in a body, query, or path is rejected before any write; row counts are unchanged (`tests/input-encoding.db.test.ts:103-152`).

Added in revision 3 (tests in `tests/unicode-schemas.test.ts` and `tests/unicode-input.db.test.ts`; all pass after the fix, and the ones not about F10 also passed before it):

- An encoded lone surrogate in a path (`/users/%ED%A0%80`, `%ED%B0%80`) is a 404 on all three user routes. This is now a test (`tests/unicode-input.db.test.ts:313`), not only code inspection.
- Auth still runs first: a lone-surrogate `requestId` without a key is 401 (`:160`).
- Invalid percent-encoding in a query value is decoded leniently to U+FFFD, so `?externalUserId=%FF` reads a user registered as `"\ufffd"`. This is read-only, and a characterization test (`:295`) pins it (TEST_PLAN D4). Cursors made of such escapes are 400 (`:304`).
- Emoji, a ZWJ sequence, a flag, non-BMP letters, Arabic, CJK and U+FFFD itself are accepted unchanged by all four text schemas (`tests/unicode-schemas.test.ts:56`) and round-trip through register, get, usage, plan change, list, consume and history (`tests/unicode-input.db.test.ts:329`, `:353`).
- 😀 and 😁 share a high surrogate and stay distinct keys and users (`:368`). The same key sent as raw UTF-8 and as a `\u` escape is a true retry (`:382`; tested as described only after the commit-prep fix in §1). `é` and `e\u0301` stay distinct, since there is no normalization (`:392`).

Added in revision 4 (tests in `tests/dot-segment-ids.test.ts`, `tests/dot-segment-ids.db.test.ts` and `tests/load-duration.test.ts`):

- IDs that only contain dots, and the literal text `%2E%2E`, are not dot segments and stay valid.
  - `...`, `a.b`, `.alice` and `%2E%2E` are tested end to end: registered, addressed by path, re-planned and charged (`tests/dot-segment-ids.db.test.ts`).
  - `alice.` and `..alice` are tested at the schema level only (`tests/dot-segment-ids.test.ts`).
- `requestId` never appears in a URL path, so `.` and `..` stay valid there.
- Supertest (superagent 10) keeps dot segments as written (`preserveDotSegments`), so `/users/..` reaches the router unresolved. The F12 path tests assert the message `User not found`: a resolved path would instead give `Route … not found`, or a 200 from `GET /usage` for `/users/../usage`.
- `DURATION` unset or empty (what `load/compare.sh` passes for the default) still means 30 s. `20s` and `30s`, the only values in `load/results/`, are accepted unchanged.

### 5. Findings

**Revision 1 probe results** (tsx script in that session's scratchpad, run against `quota_test` through `createApp()` at `e1ab78e`; kept as the evidence for F1, F2 and F8):

| Request | Status | Body |
|---|---:|---|
| `GET /users/%E0%A4%A` | 500 | `INTERNAL_ERROR` |
| `GET /users/%E0%A4%A/usage` | 500 | `INTERNAL_ERROR` |
| `GET /plans/%ZZ` | 500 | `INTERNAL_ERROR` |
| `POST /users` with `externalUserId: "a\u0000b"` | 500 | `INTERNAL_ERROR` |
| `POST /accounts` with `name: "a\u0000b"` | 500 | `INTERNAL_ERROR` |
| `POST /plans` with `name: "p\u0000"` | 500 | `INTERNAL_ERROR` |
| `POST /consume` with `requestId: "r\u0000"` | 500 | `INTERNAL_ERROR` |
| `GET /requests?externalUserId=a%00b` | 500 | `INTERNAL_ERROR` |
| `POST /plans` with `monthlyLimit: 5, perRequestLimit: 1000` | 201 | plan created |

A direct `pg` query confirmed the NUL cause: PostgreSQL rejects `'a\u0000b'::text` with SQLSTATE `22021` (`invalid byte sequence for encoding "UTF8": 0x00`).

**Revision 2 probe results** (a new tsx script in this session's scratchpad: `createApp()` listening on a real port, raw `node:http` requests, against `quota_test`, working tree). The `console.error` count during the whole probe was **0**, so nothing reached the 500 branch.

| Request | Status | Body |
|---|---:|---|
| `GET /users/%E0%A4%A`, `/users/%E0%A4%A/usage`, `/users/%` | 404 | `NOT_FOUND`, `User not found` |
| `GET /plans/%ZZ`, `/plans/%E0%A4%A`; `PATCH /plans/%ZZ` | 404 | `NOT_FOUND`, `Plan not found` |
| `PUT /users/%ZZ/plan` | 404 | `NOT_FOUND`, `User not found` |
| `DELETE /plans/%ZZ`, `POST /users/%ZZ` (no such routes) | 404 | `NOT_FOUND` |
| `GET /users/%ZZ` without a key | 401 | `UNAUTHORIZED` |
| `POST /accounts`, `POST /plans`, `POST /users`, `POST /consume` with a NUL in a string | 400 | `VALIDATION_ERROR`, `…: must not contain NUL characters` |
| `GET /requests?externalUserId=a%00b`, `GET /requests?cursor=%00` | 400 | `VALIDATION_ERROR` |
| `GET /users/a%00b` | 404 | `NOT_FOUND` |
| `POST /plans` with `monthlyLimit: 5, perRequestLimit: 1000` | 201 | plan created (F8 unchanged) |
| `PATCH` a plan with `perRequestLimit: 10` to `monthlyLimit: 5` | 200 | accepted (F8 unchanged) |
| `POST /users` with `externalUserId: "\ud800"` | 201 | stored and returned as `"�"` |
| `POST /users` with `externalUserId: "\udbff"` (a different ID) | 409 | `ALREADY_EXISTS` |
| `GET /users/%EF%BF%BD` (U+FFFD) | 200 | the user registered as `"\ud800"` |
| `POST /consume` `requestId: "\ud800"`, 1 unit | 200 | `ACCEPTED`, `requestId: "�"`, `replayed: false` |
| `POST /consume` `requestId: "\udfff"` (a different ID), 1 unit | 200 | `ACCEPTED`, `replayed: true`, **nothing consumed** |
| `POST /consume` `requestId: "\udc00"` (a different ID), 2 units | 409 | `IDEMPOTENCY_CONFLICT` |
| `GET /usage` in September (Starter), then switch to Pro, then in October `GET /usage?month=2026-09` | 200 | `remaining` 9,994 → 99,994 for the same September (F3 unchanged) |

#### F1 — Malformed percent-encoding in a path parameter returns 500 (Medium)

- **Status:** Rev 1: Confirmed (probe output: 500 on all three routes tried). **Rev 2: Resolved in the working tree, not committed.**
- **Where (rev 1):** `src/middleware/errors.ts:28-35` (at `e1ab78e`) only mapped 4xx errors that carry a `type` (body-parser errors). Express 5's router throws on an undecodable parameter with `status: 400` and no `type` (`node_modules/router/lib/layer.js:219-233`), so the error fell through to the 500 branch and was logged as `unhandled error`.
- **Scenario:** `GET /users/%E0%A4%A` with a valid key → `500 INTERNAL_ERROR`. Affected every route with a path parameter: `/users/:externalUserId`, `/users/:externalUserId/usage`, `/users/:externalUserId/plan`, `/plans/:id`.
- **Requirement affected:** R68 (useful errors). The README error table (`README.md:1083`) says a malformed ID in the URL is 404 and invalid input is 400; 500 is reserved for unexpected failures.
- **Suggested fix (rev 1):** Have the error handler treat any error with a 4xx `status` from the router (not only body-parser errors with `type`) as a client error, mapping a parameter decode failure to 400 `VALIDATION_ERROR` or 404 `NOT_FOUND` per the documented convention.
- **Resolution (rev 2):** `undecodableParamNotFound(what)` (`src/middleware/errors.ts:22-26`) is mounted last in `usersRouter` (`src/routes/users.ts:70`) and `plansRouter` (`src/routes/plans.ts:65`) and turns a `URIError` with `status: 400` into `404 User/Plan not found`; `errorHandler` has a generic 404 fallback for any other router (`src/middleware/errors.ts:46-50`). Documented as an assumption (`README.md:1284`) and in the error table (`README.md:1103`). **Evidence:** `tests/input-encoding.db.test.ts:61-101` (4 encodings × 5 routes, plus auth-first and well-formed cases), `tests/errors.test.ts:66-77` (fallback); rev 2 probe (table above); on the fresh Compose stack `GET /users/%E0%A4%A` → 404. **Residual:** not committed, so `47fa0e7` still has F1.
- **Rev 3:** committed in `b56dbc0` (with `tests/input-encoding.db.test.ts` and `tests/errors.test.ts`). Both files pass in the rev 3 full run (486 passed). TP-REG-01 on a clean checkout of `b56dbc0` was not run.

#### F2 — A NUL character in string input passes validation and returns 500 (Medium)

- **Status:** Rev 1: Confirmed (probe output: 500 on all five inputs tried). **Rev 2: Resolved in the working tree, not committed.**
- **Where (rev 1):** `src/lib/schemas.ts:14-20` at `e1ab78e` (`externalUserId`, `requestId`), names at `src/routes/accounts.ts:11`, `src/routes/plans.ts:12`, `src/routes/users.ts:14`. Zod accepted `\u0000`; PostgreSQL `text` rejects it with `22021`, which is not mapped and became a 500. By code inspection the same applied to a NUL in a URL path (`GET /users/a%00b`).
- **Scenario:** `POST /consume {"externalUserId":"alice","units":1,"requestId":"r\u0000"}` → `500 INTERNAL_ERROR`. Nothing was written, so data stayed consistent; the caller got a misleading 500 and, per `README.md:1202`, is told to retry 500s with the same `requestId`, which fails the same way forever.
- **Requirement affected:** R68 (useful errors), R19 (input validation).
- **Suggested fix (rev 1):** Reject control characters (at least `\u0000`) in every caller-supplied string in the shared Zod schemas so they return 400 (404 in a path), and add the case to the validation tests.
- **Resolution (rev 2):** `textSchema()` (`src/lib/schemas.ts:14-16`) rejects `\u0000`; it backs `callerIdSchema` (`:22-27`, so `externalUserId` and `requestId` in bodies, queries and the `externalUserIdParam` path check), `nameSchema` (`:32`, used by `src/routes/accounts.ts:11`, `src/routes/plans.ts:13`, `src/routes/users.ts:23`) and `pageCursorSchema` (`:40`). `month` and `type` reject NUL through their own parsers. Documented at `README.md:1100` and `:1289`. **Evidence:** `tests/input-encoding.db.test.ts:104-121` (8 body inputs, row counts unchanged), `:123-134` (7 query inputs), `:136-152` (path inputs); rev 2 probe; on the fresh Compose stack `POST /consume` with `requestId: "r\u0000"` → 400. **Residual:** not committed. Only NUL is rejected, which is what the README documents; other ill-formed text is F10.
- **Rev 3:** committed in `b56dbc0`. The NUL check is kept: `textSchema()` now has two refinements, NUL then unpaired surrogates (`src/lib/schemas.ts:22-23`), and the NUL message is unchanged (`tests/unicode-schemas.test.ts:66`, `tests/input-encoding.db.test.ts:104-152` pass).

#### F10 — Lone UTF-16 surrogates in IDs collapse to U+FFFD, so distinct requests and users collide (Medium, new in rev 2)

- **Status:** Confirmed (rev 2 probe and a direct `pg` query).
- **Where:** `src/lib/schemas.ts:14-27`: `textSchema()` and `callerIdSchema()` accept any JavaScript string, including ill-formed UTF-16 (`"\ud800".isWellFormed() === false`). JSON allows such strings through `\uXXXX` escapes. node-postgres encodes parameters as UTF-8 with `Buffer.from`, which replaces every lone surrogate with U+FFFD (`ef bf bd`). The direct query `SELECT $1::text = $2::text` with `'\ud800'` and `'\udfff'` returns `true`. All writes and lookups therefore use U+FFFD: the fast path and the step 6 recheck (`src/services/consume.service.ts:70-73`, `:103-106`), the user lookup (`:64-68`) and `UNIQUE (account_id, external_user_id)`.
- **Scenario:** Within one account, `POST /consume {"requestId":"\ud800","units":1,…}` is accepted and counted. A *different* request `{"requestId":"\udfff","units":1,…}` gets `200 ACCEPTED, replayed: true` and **consumes nothing**, so the caller performs an action that was never metered. With a different `units`, it gets a 409 `IDEMPOTENCY_CONFLICT` for a key it never used. The echoed `requestId` is `"�"`, not what the caller sent. For users, `"\ud800"` registers as `"�"`, a second user `"\udbff"` is refused with 409 `ALREADY_EXISTS`, and consumes for `"\udbff"` are charged to the `"\ud800"` user.
- **Requirement affected:** R78 (identifiers compared exactly; `README.md:1288` says they are), R67 (a new request is mistaken for a retry), R32 in spirit (account usage still equals the sum of user usage, but it no longer matches the actions the caller performed). Isolation (R4/R7) is not affected: collisions stay within one account. Likelihood is low, because only a client that builds IDs from ill-formed UTF-16 (for example by slicing a string through a surrogate pair) or sends raw `\uD8xx` escapes triggers it.
- **Suggested fix:** Add a well-formedness check to `textSchema()` (`value.isWellFormed()`, Node 20+, or a `/[\uD800-\uDFFF]/` scan that allows valid pairs), so these inputs get the same 400 in bodies and queries and 404 in paths as NUL. Add the cases to `tests/input-encoding.db.test.ts`, and extend the README assumption at `README.md:1289`.
- **Rev 3 status:** **Resolved.** Not in `b56dbc0`. When this was written, the fix was uncommitted and intended to be committed together with its tests and this report (see Commit state). It was committed in `1468d11`.
- **Rev 3: tests written first, run red.** `tests/unicode-schemas.test.ts` (TP-UNIT-01…04) and `tests/unicode-input.db.test.ts` (TP-ENC-01…04, 06, 07, 08; TP-IDEM-01…07, 09; TP-UTF-01/02; TP-ERR-03; a TP-REG-03 subset). Against `b56dbc0`: 63 failed, 23 passed (§1). The failures reproduced the rev 2 probe exactly:
  - `requestId: "\ud800"` → 200 `ACCEPTED`, then `"\udfff"` → 200 `replayed: true` with nothing consumed (TP-IDEM-01).
  - `"\udc00"` with 2 units → 409 `IDEMPOTENCY_CONFLICT` (TP-IDEM-02).
  - `"r\ud800"` → a replay of a legitimate `"r\ufffd"` (TP-IDEM-03).
  - User `"\ud800"` → 409 `ALREADY_EXISTS` against a registered `"\ufffd"` user (TP-IDEM-04).
  - Consumes for `"\ud800"`, `"\udfff"` and `"\udc00"` were charged to the `"\ufffd"` user (TP-ENC-02).
  - Lone-surrogate names → 201 and 200, and PATCH renamed the plan to `�` (TP-ENC-04).
- **Variant confirmed in rev 3: raw invalid UTF-8 bytes in a JSON body** (TEST_PLAN P4/D2, recorded here as part of F10). `express.json()` decoded each invalid sequence to U+FFFD before validation, so the decoded string is well-formed and a well-formedness check alone can't see it. Confirmed by TP-ENC-08 and by a raw-socket probe:
  - `requestId` `"r"`+`FF` → 200 `ACCEPTED`, stored as `72efbfbd`. `"r"`+`FE` → 200 `replayed: true`, nothing consumed.
  - `"r"`+`ED A0 80` and `"r"`+`ED B0 80` (surrogates encoded as bytes) both became `r���`, so the second was a false replay.
  - **Reverse direction:** after `"r"`+`FF`, a legitimate, valid-UTF-8 `"r\ufffd"` request was answered `replayed: true`, so a correct client went unmetered.
  - `externalUserId` `FF` → 409 `ALREADY_EXISTS` against a `"\ufffd"` user.
  - The other charsets `express.json()` accepted reach the same effects: UTF-32 code points above U+10FFFF decode to U+FFFD, a trailing odd UTF-16 byte is dropped, and UTF-16, UTF-32 and UTF-7 can produce lone surrogates (iconv-lite probe, §1).
- **Resolution (rev 3):**
  - `textSchema()` adds `.refine((value) => !LONE_SURROGATE.test(value))` with `LONE_SURROGATE = /\p{Surrogate}/u` (`src/lib/schemas.ts:11`, `:19-24`). With the `u` flag a valid pair matches as one code point, so only unpaired surrogates are rejected. The project targets ES2023, where `String.prototype.isWellFormed()` doesn't typecheck, hence the regex. All strings go through `textSchema()` (names, `externalUserId`, `requestId`, `cursor`), so a body or query gets 400 `VALIDATION_ERROR` (`<field>: must not contain unpaired UTF-16 surrogates`) and a path gets 404 through `externalUserIdParam`.
  - `express.json({ verify: requireUtf8Body })` (`src/app.ts:30-37`, `:46`) checks the raw bytes before decoding. A declared charset other than `utf-8` → `unsupported charset "UTF-16": request bodies must be UTF-8`. Bytes that fail `isUtf8()` (`node:buffer`) → `Request body is not valid UTF-8`. body-parser tags a `verify` throw `entity.verify.failed` with a 4xx status, which the existing branch at `src/middleware/errors.ts:52-57` already returns as 400 `VALIDATION_ERROR`; `errors.ts` is unchanged. The hook sees the body after gzip/deflate inflation, so compressed bodies are checked too.
  - README: the convention (`README.md:148`), the `VALIDATION_ERROR` row (`:1101`), the assumptions (`:1291`, `:1292`; rev 4: `:1292`, `:1293`) and the known limitation (`:1338`; rev 4: `:1340`).
- **Evidence (rev 3):**
  - The two F10 files: 86 passed. The full suite (`REQUIRE_DB=1`): 24 files, 486 passed, 0 skipped. Typecheck, lint and build are clean.
  - The test files are unchanged between the red and green runs: mtimes 00:12/00:13 (+0300), first red run 00:14, first production edit 00:26. They were edited once afterwards, in the commit-prep review (§1). That edit fixed TP-IDEM-06 and comments only; no assertion changed.
  - TP-IDEM-09 still passes: node-postgres still sends `"\ud800"` and `"\udfff"` as the same U+FFFD. This shows the guard has to stay in the app.
- **Compatibility (rev 3, UTF-8-only policy accepted by the developer).** Charset probe, same 20 requests against `HEAD` (`b56dbc0`) and the fixed working tree.
  - **Changed** (201 → 400): raw invalid UTF-8; gzipped invalid UTF-8; `charset=utf-16le`; `charset=utf-16` with a BOM; `charset=utf-32le`; `charset=utf-7`.
  - **Unchanged:** `application/json` with no charset, `charset=utf-8`, `charset=UTF-8`, `charset="utf-8"`, a UTF-8 BOM, gzipped UTF-8, an escaped `\ufffd`. Also `charset=utf8` and `latin1` (400 before and after), `text/plain`, no Content-Type, `application/vnd.api+json`, an empty body and malformed JSON.
  - The example client, the k6 scripts and the tests send `application/json` without a charset, so they aren't affected.
- **Residual (rev 3):**
  - Not committed when this was written (see Commit state).
  - The Compose image isn't rebuilt.
  - The load tests weren't rerun after the fix (TP-LOAD-04). The added work is one native `isUtf8()` pass over each body and one regex per string of at most 200 characters.
  - *Addendum:* the fix is committed (`1468d11`) and the Compose image rebuilt from it. TP-LOAD-04 then ran once (`hot-account-84e77ce8`): invariants 0 and 0 errors, but 77.3 req/s, below its expected range of 85.2–103.3. Not passed; cause not investigated (`docs/LOAD_TEST.md` §9).
  - Lenient U+FFFD decoding of query values (D4) is unchanged. It is read-only and pinned by `tests/unicode-input.db.test.ts:295`.
  - TP-ENC-05, TP-UNIT-05, TP-UTF-03/04 and TP-REG-02/04 are not implemented.

#### F3 — A past month's `remaining` is computed against the current plan (Low)

- **Status:** By code inspection; documented as an assumption (`README.md:1310`) and a known limitation (`README.md:1330`); also listed as an intended assumption in `docs/PLAN.md:428-429`. Rev 2: re-confirmed by probe (September `remaining` 9,994 → 99,994 after an October switch to Pro).
- **Where:** `src/services/usage.service.ts:13-24`, `:29-44` join the account's or user's *current* plan; `src/services/views.ts:22-28` computes `remaining` from it.
- **Scenario:** Account on Starter (10,000) consumed 9,000 in September, then switched to Pro in October. `GET /usage?month=2026-09` reports `remaining: 91000` for September, an allowance that never existed in that month. `consumed` is correct. Tested and accepted as-is by `tests/usage.db.test.ts:73`.
- **Requirement affected:** R46 (previous months' usage).
- **Suggested fix:** For a month other than the current one, either omit `remaining` or compute it from the plan that applied, for example from the last request row's plan snapshot for that month, or a stored plan-assignment history. PLAN.md lists the current behavior as a planned assumption, so a change needs the developer's sign-off.

#### F4 — History doesn't snapshot plan limits, so a PATCH changes what a stored plan ID means (Low)

- **Status:** By code inspection; documented (`README.md:1330`). Unchanged in rev 2.
- **Where:** `src/db/schema.ts:139-147` stores `account_plan_id`, `user_plan_id` and `limit_value` (rejections only); `src/services/plans.service.ts:65-82` updates a custom plan in place.
- **Scenario:** A request accepted under custom plan P (100/month) shows `accountPlanId: P` in history. After `PATCH /plans/P {monthlyLimit: 50}`, looking up P shows 50, so the history entry no longer explains why it was accepted. The history row itself is unchanged, so R42 still holds.
- **Requirement affected:** R42 (preserve past history), auditability.
- **Suggested fix:** Store the monthly and per-request limits of both plans on each request row at decision time, or version plans so an update creates a new immutable revision.

#### F5 — No bulk per-user usage read (Low)

- **Status:** By code inspection; documented (`README.md:1331`). Unchanged in rev 2.
- **Where:** `src/services/users.service.ts:14-21` (`userView` without usage), `src/services/users.service.ts:57-75`.
- **Scenario:** An account with 1,000 users needs 1,000 calls to `GET /users/:id/usage` to see per-user consumption for a month.
- **Requirement affected:** R45 (usage for users). Met per user, but costly for the "account and its users" view.
- **Suggested fix:** Add the month's `usage` to each `GET /users` entry (a LEFT JOIN on `user_usage` for the page's users), or add a paginated per-user usage endpoint with `?month=`.

#### F6 — The 200-VU load evidence predates the 503 overload mapping (Low)

- **Status:** By document inspection. **Rev 2: still open.** The two new runs (2026-10-19) are 50 VUs (`*-bc7adbf3-env.txt`, `*-06e6a282-env.txt`: `vus 50 (default)`) and report `service unavailable (overload): 0`, which is expected at that load. No 200-VU run exists after `e1ab78e`.
- **Where:** `README.md:1393` (at `1468d11`: `:1397`; rev 4: `:1399`) and `docs/LOAD_TEST.md:209` state the 200-VU errors were 500s and that the code now returns 503; every 200-VU run in `load/results/` predates commit `e1ab78e`.
- **Scenario:** The current overload behavior (503 + `Retry-After: 1`) is verified only by integration tests (`tests/consume.db.test.ts:578`, `:632`, `tests/errors.test.ts:99`, `:112`), never under load.
- **Requirement affected:** R63 (load evidence), R69.
- **Suggested fix:** Rerun the 200-VU hot-account probe on the current code, commit its results, and update the tables to show 503s and the client-side retry outcome.

#### F7 — The hot-account bottleneck has no implemented improvement (Low)

- **Status:** By document inspection. Unchanged in rev 2.
- **Where:** `docs/LOAD_TEST.md:221-228` (proposals), `docs/LOAD_TEST.md:242-392` (`WORKERS` measurement); `src/config.ts:10` defaults `WORKERS` to 1.
- **Scenario:** The one measured improvement, `WORKERS=4`, gains 31–35% for many accounts but costs 9–10% throughput for a single busy account, so it is off by default. The improvements aimed at the identified bottleneck (fewer round trips under the row lock, an advisory lock for duplicate `requestId`s) are proposed only, and both need sign-off because they touch the locked transaction order (`docs/LOAD_TEST.md:225-226`).
- **Requirement affected:** R66 ("improvements that preserve correctness").
- **Suggested fix:** Implement and measure the round-trip reduction while the account row is locked (for example by sending the post-lock statements as one batch or function call), and keep the invariant check after each run.

#### F11 — The newest load runs are uncommitted, uncited, and disagree with the documented baseline (Low, new in rev 2)

- **Status:** By inspection of `load/results/*-bc7adbf3-*` and `*-06e6a282-*` (untracked in `git status`; neither ID appears in `docs/` or `README.md`).
- **Evidence:**
  - `many-accounts-06e6a282` (`WORKERS=1`): **339.6 req/s**, p50 136.9 ms. Every other `WORKERS=1` many-accounts run is 167.7–209.8 req/s, and every `WORKERS=4` run is 261.7–268.4 req/s (all 14 `many-accounts-*-k6.txt`). The documented conclusion (`docs/LOAD_TEST.md` §8, `README.md:1365`, at `1468d11` `:1369`, rev 4 `:1371`) is that `WORKERS=4` is about 31% faster for many accounts. This single `WORKERS=1` run beats every `WORKERS=4` run. Its DB CPU averages 152% against 111–113% in the earlier `WORKERS=1` runs, with similar API CPU (108% vs 112–116%), so the API did more requests per CPU second.
  - The same run's `-env.txt` reports `api_workers_env 1` but `api_node_processes 2`. `load/run.sh:70` (rev 4: `:74`) counts `node` processes with `ps` at one instant. The Compose healthcheck runs `node -e fetch(...)` in the API container every 5 s (`docker-compose.yml:36`), so a healthcheck process caught by `ps` is a plausible cause. Not verified; in this review the container showed one `node` process.
  - `hot-account-bc7adbf3`: 91.3 req/s, inside the documented spread (85.2–103.3); all invariants 0, 0 errors, `fresh=2738 request rows=2738 OK`. *Addendum:* that range's upper bound, 103.3, is a 200-VU probe (`76c60ef4`). The 50-VU single-process runs span 85.2–96.2 req/s (`docs/LOAD_TEST.md` §9). 91.3 is inside both.
- *Addendum (citations of untracked files):* `README.md:1343` (rev 4: `:1345`) says "Every run's files are in `load/results/`", and `docs/LOAD_TEST.md` says its numbers come from saved files there. That is true on disk. At `1468d11`, though, git doesn't track the 33 files of `hot-account-84e77ce8`, `hot-account-bc7adbf3` and `many-accounts-06e6a282`, and `docs/LOAD_TEST.md` §9, `docs/TEST_PLAN.md` §9 and this report cite them. Committing them, or removing the citations, is the developer's decision. Either way, the many-accounts result above stays unexplained. F11's status is unchanged.
- **Scenario:** A reviewer comparing the repository's `load/results/` with `docs/LOAD_TEST.md` finds runs that aren't explained, and one that contradicts the stated `WORKERS` trade-off, while the docs say run-to-run variation wasn't measured for the baseline (`docs/LOAD_TEST.md` §7).
- **Requirement affected:** R63 (load evidence and lessons), R65.
- **Suggested fix:** Either commit and cite the new runs with an explanation of the many-accounts jump (host load, cache state, or a process-count artifact), or leave them out of the commit. If the number is real, rerun `load/compare.sh` before relying on the §8 conclusion. Make `load/run.sh` record the git commit and dirty state in `-env.txt`, and count processes in a way that excludes the healthcheck (for example by parent PID).

#### F12 — `.` and `..` are accepted as `externalUserId` but can't be addressed in a URL path (Low, new in rev 4)

- **Status:** Confirmed by code reading and a `new URL()` probe (rev 4). **Rev 4: Resolved.** Not in `1468d11`; the fix was uncommitted when this was written (see Commit state (revision 4)) and has since been committed in `3c39c71`.
- **Where (at `1468d11`):**
  - `src/lib/schemas.ts:30-37`: `externalUserIdSchema` checked length, NUL, surrogates and edge whitespace only, so `.` and `..` were valid.
  - `client/src/quota-api.ts:85` built `` `/users/${encodeURIComponent(id)}/plan` ``. `encodeURIComponent` leaves `.` unencoded.
  - `call()` passes that path through `new URL(path, baseUrl)` (`:96`). WHATWG URL resolves dot segments, including when they're written as `%2E`.
- **Scenario:** `POST /users {"externalUserId":".."}` → 201. `QuotaApi.setUserPlan('..', planId)` then sends `PUT /plan`, and `'.'` sends `PUT /users/plan`. `fetch('/users/..')` requests `/`.
  - The following outcome is inferred from the routing, not executed: neither route exists, so the caller gets a misleading 404 `Route … not found`.
  - No other user is changed, and metering is unaffected, because `POST /consume` carries the ID in the body.
  - A client that sends the path unresolved reaches the user routes with the parameter `..`. Supertest does this (superagent's `preserveDotSegments`). The green run shows it: `GET /users/../usage` gets 404 with the message `User not found`, which only the user routes send. Had the path been resolved, the request would have reached `GET /usage` and got a 200. What the red run returned for these paths wasn't recorded, only that the tests failed. `curl --path-as-is` should behave like Supertest, but this review didn't run curl.
- **Requirement affected:** R3 (change users' plans), R51 (example client), R68 (useful errors).
- **Resolution (rev 4):**
  - **Server:** `externalUserIdSchema` refines `id !== '.' && id !== '..'` with the message `must not be "." or ".."` (`src/lib/schemas.ts:42-44`). The same schema backs the `/users` and `/consume` bodies, the `/requests` query and `externalUserIdParam`, so those IDs get 400 in a body or query and 404 `User not found` in a path, `%2E`/`%2e` included. `requestId` is unchanged.
  - **Client:** `userPath()` refuses both IDs before sending (`client/src/quota-api.ts:57-62`), and `setUserPlan` is now `async`, so the refusal is a rejected promise (`:96`).
  - **README:** the ID rules (`README.md:111`, `:147`, `:513`, `:706`), the `VALIDATION_ERROR` row (`:1101`), the assumptions (`:1285`, `:1290`) and the known limitation (`:1334`).
- **Existing data:** the rule is only in validation, and nothing is deleted or migrated. A user stored before the rule is still listed by `GET /users`, and its usage still counts toward the account. It can no longer be addressed by path (404) or charged (400). A read-only query found no such user in the Compose dev database (0 of 14,508). Other databases weren't checked.
- **Evidence (rev 4):**
  - `tests/dot-segment-ids.test.ts`: schema cases; the client's request lines, recorded by a stub server; a `new URL()` control.
  - `tests/dot-segment-ids.db.test.ts`:
    - `POST /users` and `POST /consume` → 400 with row counts unchanged. `GET /requests` → 400 with the expected message; it reads only, so row counts aren't checked.
    - Path forms `.`, `..`, `%2E`, `%2e`, `%2E%2E`, `%2e%2e` on the three user routes → 404 `User not found`, each with a stored user of that ID, and that user's plan unchanged.
    - Look-alike IDs; a pre-existing `..` row.
  - Red run with the server refinement and client guard disabled: 17 failed, 17 passed. Green: 34 passed (§1).
- **Residual:** not committed when this was written (since committed in `3c39c71`); the Compose images weren't rebuilt. Only `QuotaApi` guards these IDs on the client side. Other clients rely on the server's 400/404.

#### F13 — The load summary misreads any `DURATION` that isn't whole seconds (Low, new in rev 4)

- **Status:** Confirmed by code reading (rev 4). Latent. **Rev 4: Resolved.** Not in `1468d11`; the fix was uncommitted when this was written (see Commit state (revision 4)) and has since been committed in `b5a3486`.
- **Where (at `1468d11`):** `load/lib.js:13`, `:37` pass `DURATION` unchanged to k6 as the scenario duration, and k6 accepts Go-style durations. The summary used `seconds = parseFloat(DURATION)` (`:138`) and `rps = total / seconds` (`:146`), and printed `rps` both in its text line and in the `SUMMARY_JSON` line. `load/compare.sh` reads `.rps` from `SUMMARY_JSON` into its session index and medians (`load/compare.sh:45`). `load/run.sh` doesn't read `rps`, at `1468d11` or now. It takes only `.requests`, `.fresh` and `.errors` from `SUMMARY_JSON`, and saves the k6 output, including the `req/s` text, to `-k6.txt` (revision 4 line numbers: `load/run.sh:153-154`, `:168`, `:100`).
- **Scenario:** `DURATION=1m` runs for 60 s but divides by 1, so `rps` is 60× too high. `1m30s` is 90× too high and `1h` 3,600× too high; `500ms` divides by 500 and is 1,000× too low.
- **Existing results:** not affected.
  - Of the 36 `load/results/*-env.txt` files, 30 say `duration 30s (default)` and 6 say `duration 20s`.
  - Every `SUMMARY_JSON` has `durationSeconds` 30 or 20, matching its env file.
  - So every recorded and cited `rps` used the right divisor.
- **Requirement affected:** R63, R64 (load evidence and reproducibility).
- **Resolution (rev 4):** `DURATION` must be whole seconds, matching `^[1-9][0-9]*s$`.
  - `load/duration.js` holds the check as `durationSeconds()`. It has no k6 imports, so the test suite can load it, and `load/duration.d.ts` types it.
  - `load/lib.js` calls it at init (`:16`), so a bad value fails before setup, and uses the result for req/s (`:141`).
  - `load/run.sh:25-26` checks the same pattern before anything starts or any file is written to `load/results/`. The usage text says so (`:13-14`, `:21`), as does `README.md:1415`.
  - Unset or empty still means 30 s.
- **Evidence (rev 4):**
  - `tests/load-duration.test.ts`: 5 valid and 14 invalid values for `durationSeconds`. `load/run.sh` itself runs with a `PATH` holding only `dirname`, so Docker, jq and k6 can't be reached: valid values pass the check and stop at the jq requirement, and 13 invalid values exit 2.
  - Red with the `run.sh` check removed: 13 failed.
  - k6 1.3.0 `inspect`: the default and `-e DURATION=20s` load and exit 0; `-e DURATION=1m` fails at `lib.js:16` with exit 107 (§1).
- **Residual:**
  - Not committed when this was written (see Commit state (revision 4)); since committed in `b5a3486`.
  - `1m`-style values are refused rather than supported.
  - Inference, not measured: `rps` divides by the nominal duration, while `gracefulStop: '5s'` (`load/lib.js:40`) lets in-flight requests finish after it. That adds at most about one request per VU (`BURST` per VU for retry-storm), roughly 0.5–2% at 50 VUs. It's not a finding, and it doesn't change any conclusion in `docs/LOAD_TEST.md`.

#### F8 — `perRequestLimit > monthlyLimit` is accepted and not documented (Info)

- **Status:** Confirmed (rev 1 probe: 201 for `monthlyLimit: 5, perRequestLimit: 1000`). Rev 2: re-confirmed on create (201) and through PATCH (200).
- **Where:** `src/routes/plans.ts:14-27` validates each limit independently; `PATCH` can also produce this state.
- **Scenario:** A plan whose per-request limit can never be reached. Decisions stay correct (the monthly rule rejects), but the configuration is probably a mistake and the README assumptions don't mention it.
- **Requirement affected:** R17 (plan validation), R72 (documented assumptions).
- **Suggested fix:** Either reject `perRequestLimit > monthlyLimit` (when `monthlyLimit > 0`) on create and on the merged result of PATCH, or document under Assumptions that it is allowed and why.

#### F9 — The Compose healthcheck's `start_interval` needs Docker Engine 25+, which isn't stated (Info)

- **Status:** Unable to Verify (no older engine available); based on Docker's documented minimum for `start_interval`. Rev 2: the fresh-clone start succeeded on Docker 29.9.0 / Compose 5.6.0, which says nothing about older engines.
- **Where:** `docker-compose.yml:41`; prerequisites at `README.md:26` say only "Docker with Compose v2".
- **Scenario:** On Docker Engine < 25, `docker compose up --build` can fail to create the `api` container or ignore the option, which would affect R59 on a reviewer's machine.
- **Requirement affected:** R59, R61.
- **Suggested fix:** State the minimum Docker Engine version in the README prerequisites, or drop `start_interval` and rely on `interval` + `start_period`.

### 6. Accepted risks

Documented in the README as deliberate choices or known limitations. They are not findings.

| Risk | README reference |
|---|---|
| No API key rotation or revocation; a lost key makes the account unusable | `README.md:1334` (at `1468d11`: `:1337`; rev 4: `:1339`) |
| `POST /accounts` is public and not rate-limited | `README.md:1335` (at `1468d11`: `:1339`; rev 4: `:1341`; also a locked decision in `docs/PLAN.md` §6) |
| A reused `requestId` with an unknown `externalUserId` returns 404, not 409 | `README.md:1201` (at `1468d11`: `:1202`) |
| A client-side `COMMIT` timeout returns 500 for a request that may have committed; retrying with the same `requestId` resolves it | `README.md:1202` (at `1468d11`: `:1203`) |
| Custom plans may reuse predefined plan names (e.g. a custom "Starter") | `README.md:1296` (at `1468d11`: `:1299`; rev 4: `:1300`) |
| One account's consumes are serialized on its usage row lock | `README.md:1332` (at `1468d11`: `:1335`; rev 4: `:1337`) |
| Control characters other than NUL are stored as given (rev 2) | `README.md:1289` (rev 3: `:1290`; rev 4: `:1291`) |
| Request bodies must be UTF-8: a body declared as UTF-16, UTF-32 or UTF-7 gets 400 (rev 3, accepted by the developer) | `README.md:1292`, `:1338` (rev 4: `:1293`, `:1340`) |
| Invalid percent-encoding in a query value decodes leniently to U+FFFD; read-only (rev 3; TEST_PLAN D4) | `README.md:1291` (rev 4: `:1292`) |
| A user stored as `.` or `..` before the F12 rule is kept but can no longer be addressed by path or charged (rev 4) | `README.md:1334` (rev 4) |

### 7. Not verified

Revision 1 listed three items. Status in revision 2:

- ~~`docker compose up --build` from a clean clone (R59).~~ Verified in rev 2, on Docker 29.9.0 only, with the API port remapped (see R59).
- ~~Rerunning `load/run.sh`, `load/compare.sh` and `load/uncontended.sh` (R64).~~ The developer's 2026-10-19 reruns of `run.sh` were inspected; this review did not rerun any load script, and `compare.sh` and `uncontended.sh` have no run after `e1ab78e`.
- The client page rendered in a browser (R57 checked from the HTML, an HTTP 200 on the fresh stack, and `tests/demo.db.test.ts` only). **Still open.** *Addendum:* the developer reports that the browser demo on the rebuilt stack ended with `every step matched`. No screenshot or output was saved, so this report doesn't count it as evidence, and the item stays open.

Also not verified in revision 2:

- The overload path (503 + `Retry-After`) under real load (F6).
- Behavior on Docker Engine < 25 (F9).
- The committed tree `47fa0e7` on its own (without the uncommitted fixes) under Compose. By the diff it differs only in F1/F2 behavior.
- The cause of the `many-accounts-06e6a282` throughput and process count (F11).

Also not verified in revision 3:

- The F10 fix inside the Compose stack (the image wasn't rebuilt or restarted). *Addendum:* the image has since been rebuilt from `1468d11` (22:53:56 UTC), and its compiled `dist/` is byte-identical to the local build and contains the F10 checks. No HTTP probe of the F10 cases was run against the Compose API, so the behavior inside the stack stays unverified.
- Load behavior after the F10 fix (TP-LOAD-04). *Addendum:* run once, not passed on throughput (77.3 req/s, expected 85.2–103.3); correctness and errors held. Why throughput is lower is not verified (`docs/LOAD_TEST.md` §9).
- TP-REG-01: the F1/F2 tests on a clean checkout of `b56dbc0` alone. *Addendum:* TP-REG-01 passed on a clean clone of `1468d11`, which contains `b56dbc0`: 24 files, 486 tests (`docs/TEST_PLAN.md` §10). `b56dbc0` alone is still not run.
- Node versions other than 22.15.0 (`isUtf8` needs Node 18.14+; the project requires 22+).

Also not verified in revision 4:

- F12 inside the Compose stack: the `api` and `client` images weren't rebuilt, so the running containers still accept `.` and `..`.
- A real load run with the F13 check. Only `k6 inspect` ran (§1), which executes the init code, including the check, but sends no requests and doesn't produce a summary.
- Users stored as `.` or `..` in any database other than the Compose dev database.
