# Test Plan

## Phase 2 — Test Design

| Revision | Date | Based on | Status |
|---|---|---|---|
| 1 | 2026-10-19 | `docs/QA_REPORT.md` revision 2; commit `47fa0e7` + the uncommitted working tree (F1/F2 fixes in `src/lib/schemas.ts`, `src/middleware/errors.ts`, `src/routes/{accounts,plans,users}.ts`, `tests/errors.test.ts`, untracked `tests/input-encoding.db.test.ts`) | Design only. No test in this plan had been executed at this revision. |
| 2 | 2026-10-20 | `docs/QA_REPORT.md` revision 3; commit `b56dbc0` + the uncommitted F10 fix and tests (see the QA report's "Commit state") | **Partially executed:** of the 54 planned tests, 21 were run as specified, 2 were run in part, and 31 have not been run. Only the F10 tests (§4.1–§4.5) were in scope. See §8. |

This plan adds no findings and changes no finding status. Finding IDs (F1–F11) and requirement IDs (R1–R78) are the ones in `docs/QA_REPORT.md`. No production code, test code or load evidence was changed to write it.

**Revision 2** adds only this header and the execution record in §8. The test IDs, scenarios, priorities and expected results in §4, and the decisions in §5, are unchanged, so the plan still shows what was designed. The "Current evidence" column still shows what was known **at design time**, before any test ran: "Not run" there doesn't mean the test hasn't run since. §8 is the only place that says what was executed. Results and finding status are in `docs/QA_REPORT.md` (revision 3).

### 1. Starting point

**Git state when this plan was written:** branch `main`, HEAD `47fa0e7`. Seven tracked files are modified (the F1/F2 fix plus README and `tests/errors.test.ts`), and `tests/input-encoding.db.test.ts`, `docs/QA_REPORT.md` and 22 load result files (`hot-account-bc7adbf3-*`, `many-accounts-06e6a282-*`) are untracked. So:

- The F1/F2 fixes and their tests exist only in the working tree. A clone of `47fa0e7` still returns 500 for both (QA report, F1/F2 "Residual").
- The F1/F2 regression tests below are meaningful only once the fix is committed together with them (TP-REG-01).
- The load tests in §4.8 must run against committed code, or their results have the same citation problem as F11.

**Findings this plan targets:**

| Finding | Severity | Status (QA rev 2) | Tests here |
|---|---|---|---|
| F10 | Medium | Open, confirmed | §4.1–§4.5 (primary focus) |
| F1 | Medium | Resolved in working tree, uncommitted | §4.6 |
| F2 | Medium | Resolved in working tree, uncommitted | §4.6 |
| F6 | Low | Open | §4.8 |
| F11 | Low | Open | §4.8 (preconditions) |
| F8 | Info | Open | §4.9 (decision needed) |
| — (R49) | — | Fully Implemented, verified by hand, no automated test | §4.7 |

### 2. Conventions

**Priority**

| Priority | Meaning |
|---|---|
| P0 | Must run before submission (deadline: end of 2026-10-20). Closes or proves a Medium finding, or guards against a fix that breaks valid input. |
| P1 | Should run before submission. |
| P2 | Worth running if time allows. |
| P3 | Optional, or characterization only. |

**Test types:** *unit* (no DB, no HTTP), *integration* (Supertest against `createApp()` and `quota_test`, the existing `*.db.test.ts` convention), *end-to-end* (real server processes or the Compose stack), *load* (k6 through `load/run.sh`).

**"Current evidence" column.** What is already known about the current working tree, without running the test:

- **Red: QA probe.** QA rev 2's HTTP probe observed the behavior that this test says is wrong. The test is expected to fail until the fix lands.
- **Red: code reading.** Expected to fail, inferred from the code. Not observed.
- **Red: design probe.** Expected to fail, inferred from a design-time probe in §3 that exercised a library in isolation, not the full app.
- **Not run.** Expected to pass. No evidence either way.
- **Existing.** Already covered by a test in the repository (file and line given). It is listed for completeness and is not a new test.

**Assertions shared by every integration test in this plan** (they follow `tests/input-encoding.db.test.ts`):

- Errors use `expectError(res, status, code)`: exactly `{ error: { code, message } }`, with a non-empty message.
- No request reaches the 500 branch: `console.error` is not called (the existing `expectNoUnhandledError()`).
- Rejected input writes nothing: the existing `counts()` helper (accounts, plans, users, requests, account_usage, user_usage) is unchanged.
- Run with `REQUIRE_DB=1`. Without it, the integration suites skip themselves silently when `quota_test` is unreachable, and a skipped suite looks like a pass.

**Expected results for F10 assume decision D1** (§5): ill-formed UTF-16 is rejected the same way NUL is: 400 `VALIDATION_ERROR` in a body or query, 404 `NOT_FOUND` in a URL path. The message wording is the fixer's choice. Tests should check the code and that the message names the field (e.g. starts with `requestId:`), not the exact wording.

**Sample sets used below**

| Set | Values (JavaScript string literals) | Why |
|---|---|---|
| **S** (ill-formed) | `"\ud800"` (lone high), `"\udfff"` (lone low), `"\udc00"` (lone low), `"a\udbffb"` (embedded high), `"\ude00\ud83d"` (pair in the wrong order), `"👍\ud83d"` (valid pair followed by a lone high: a string sliced through a pair) | Every shape of lone surrogate: first, last, embedded, reversed, and after a valid pair |
| **W** (well-formed, non-ASCII) | `"👍"`, `"😀"` (= `"😀"`), `"�"` (U+FFFD itself), `"é"` (U+00E9), `"é"` (e + combining acute), `"用户-42"`, `"مستخدم"`, `"👩‍💻"` (ZWJ sequence), `"🇵🇸"` (flag, two regional indicators), `"𝔘ser"` (non-BMP letter) | Valid text the F10 fix must keep accepting. U+FFFD is included on purpose: it is a legitimate character. |

Supertest serializes bodies with `JSON.stringify`, which writes a lone surrogate as a `\uXXXX` escape, so set S reaches the server as valid JSON (probe P1 in §3).

### 3. Design-time probes

Run on 2026-10-19 while writing this plan, to make the expected results concrete. They exercised libraries in isolation (Node `querystring`, `Buffer`, `express.json()`, Zod), **not** the quota service or its database. They are not test executions. The script was `probe.mjs` in the session scratchpad.

| Probe | Input | Observed | Consequence for this plan |
|---|---|---|---|
| P1 | `express.json()` body `{"r":"\ud800"}` (escaped) | `req.body.r` is the lone code unit `d800`, `isWellFormed() === false` | Lone surrogates reach Zod intact; a check in `textSchema()` can see them (D1). |
| P2 | `decodeURIComponent('%ED%A0%80')` | `URIError` | An encoded surrogate in a **path** hits the F1 mapping and becomes 404. QA §4 states this "by code inspection" only. TP-REG-03 makes it a test. |
| P3 | Express 5 default query parser (`'simple'`, i.e. `node:querystring`) on `a=%ED%A0%80`, `a=%FF`, `a=%FE`, `a=%EF%BF%BD` | `fffd fffd fffd`, `fffd`, `fffd`, `fffd` | A **query** value can never contain a lone surrogate. Invalid percent-encoding is decoded leniently to U+FFFD, so `%FF`, `%FE` and a real `%EF%BF%BD` become the same string. Read-only impact (D4). |
| P4 | `express.json()` body with **raw invalid UTF-8 bytes**: `"r` + `FF` + `"`, `"r` + `FE` + `"`, `"r` + `ED A0 80` + `"` | `r�`, `r�`, `r���`, all well-formed | **Not closed by an `isWellFormed()` check.** Two different invalid byte sequences arrive as the same well-formed string, so the F10 collision is reachable this way too. Full-app effect inferred, not observed (TP-ENC-08, D2). |
| P5 | `Buffer.from(s, 'base64url')` with `s = "eyJh"`, `"eyJh�"`, `"ey�Jh"` | All three decode to the same bytes | `decodeCursor()` ignores characters outside the base64url alphabet, so a valid cursor with junk appended (`<cursor>%FF`) is accepted as the same cursor (TP-ENC-07, D4). |
| P6 | Zod 4.6.7 `z.string().max(128)` on `"👍".repeat(n)` | n = 128 accepted, 129 rejected | Length is counted in **code points**, not UTF-16 code units (`node_modules/zod/v4/core/checks.js:273`). The README says "128 characters". TP-UTF-04, D7. |
| P7 | `" \ud800 ".trim()` | `"\ud800"` | Trimming names doesn't remove a lone surrogate, so `nameSchema` needs the same check (TP-ENC-04). |

### 4. Test cases

#### 4.1 F10 — schema unit tests

New file, suggested `tests/schemas.test.ts` (no DB). The schemas are exported from `src/lib/schemas.ts`.

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-UNIT-01 | F10, R78 | `externalUserIdSchema.safeParse(v)` and `requestIdSchema.safeParse(v)` for every v in S | `success: false`, one issue on the well-formedness rule | unit | P0 | Red: code reading (`textSchema()` checks only NUL) |
| TP-UNIT-02 | F10, R78 | `nameSchema` and `pageCursorSchema` for every v in S | `success: false` | unit | P1 | Red: code reading |
| TP-UNIT-03 | R78, R19 | All four schemas for every v in W | `success: true`, output `===` input (names: `===` the trimmed input) | unit | P0 | Not run. Guards against an over-broad fix, e.g. a `/[\uD800-\uDFFF]/` test that also rejects valid pairs. |
| TP-UNIT-04 | F2, F10 | `requestIdSchema` on `"\u0000\ud800"` and `"\u0000"` | Both fail; the NUL message `must not contain NUL characters` is still present | unit | P1 | Not run |
| TP-UNIT-05 | R19 | `externalUserIdSchema` on `"👍".repeat(128)`, `"👍".repeat(129)`, `"a".repeat(128)` | accepted, rejected, accepted (code points, P6) | unit | P2 | Not run (P6 observed Zod alone) |

#### 4.2 F10 — lone surrogates by location (bodies, query, path, names, cursors)

Extend `tests/input-encoding.db.test.ts` (integration). Setup is that file's `beforeEach`: a fresh account, user `alice` on Basic, and a custom USER plan named `Custom`. Tests that need it also register a user whose ID is the literal `"�"`.

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-ENC-01 | F10, R78, R19 | `POST /consume { externalUserId: "alice", units: 1, requestId: v }` for v in S | 400 `VALIDATION_ERROR`, message starts `requestId:`; `counts()` unchanged | integration | P0 | Red: QA probe (`"\ud800"` → 200 `ACCEPTED`) |
| TP-ENC-02 | F10, R8, R78 | Register `"�"`. Then `POST /consume { externalUserId: v, units: 1, requestId: "r" }` for v in S | 400 (not 404, and not charged to the `"�"` user); `GET /users/%EF%BF%BD/usage` → `consumed: 0`; `counts()` unchanged | integration | P0 | Red: QA probe (consumes for `"\udbff"` were charged to the `"\ud800"` user) |
| TP-ENC-03 | F10, R2, R78 | `POST /users { externalUserId: v }` for v in S | 400, message starts `externalUserId:`; users count unchanged | integration | P0 | Red: QA probe (`"\ud800"` → 201, stored as `"�"`) |
| TP-ENC-04 | F10, R1, R12 | `name: v` (v in S) on `POST /accounts` (no key), `POST /plans`, `PATCH /plans/:id` (the custom plan), `POST /users` (with a valid `externalUserId`) | 400 `VALIDATION_ERROR` each; nothing written; the custom plan's name is still `Custom` | integration | P1 | Red: code reading (P7) |
| TP-ENC-05 | F10, R12 | `POST /plans { name: "P\ud800", … }` then `{ name: "P\udbff", … }` | Both 400. Today the second is expected to be 409 `ALREADY_EXISTS` for a name never used | integration | P2 | Red: code reading (not probed) |
| TP-ENC-06 | F10, R47, R68 | Query values with invalid UTF-8 escapes: `GET /requests?externalUserId=%ED%A0%80`, `?externalUserId=%FF`; `GET /usage?month=%ED%A0%80` | `/requests`: 404 `User not found` (P3: the value arrives as well-formed U+FFFD text, an unknown user). `/usage`: 400. With a user `"�"` registered, `?externalUserId=%FF` → 200 for that user (characterizes P3, see D4) | integration | P2 | Not run |
| TP-ENC-07 | F10, R48 | Cursors: `GET /requests?cursor=%ED%A0%80`, `GET /users?cursor=%FF`; then `GET /requests?cursor=<valid nextCursor>%FF` | First two: 400 `cursor: invalid cursor`. Third: per D4. If lenient decoding is kept, 200 with the same page as `<valid nextCursor>` (P5); if not, 400 | integration | P2 (first two), P3 (third) | Not run |
| TP-ENC-08 | F10 (variant), R78, R67 | Raw body bytes, sent as a `Buffer` with `Content-Type: application/json`: `{"externalUserId":"alice","units":1,"requestId":"r<FF>"}`, then the same with `<FE>` | Per D2. Recommended: both 400 `VALIDATION_ERROR` (the body isn't valid UTF-8), nothing written. Today, inferred: the first is accepted as `"r�"`, the second replays it (`replayed: true`, nothing consumed) | integration | P1 | Red: design probe (P4) |

The `%ED%A0%80` **path** cases are in TP-REG-03, because they go through the F1 mapping.

#### 4.3 Error responses for invalid identifiers (bodies, queries, paths)

The existing suites already cover most of this matrix. The table shows where, and the rows below it add only the gaps. "B" is a JSON body (`/consume`, `/users`), "Q" a query value (`/requests?externalUserId=`), "P" a path segment (`/users/:externalUserId…`, `/plans/:id`).

| Invalid input | B | Q | P | Covered by |
|---|---|---|---|---|
| Empty | 400 | 400 | — (no route) | `tests/consume.db.test.ts:689`, `:691`, `tests/users.db.test.ts:81`, `tests/requests.db.test.ts:268` |
| Over 128 characters | 400 | 400 | 404 | `tests/consume.db.test.ts:690`, `:692`, `tests/requests.db.test.ts:269`, `tests/usage.db.test.ts:146` |
| Leading or trailing ASCII whitespace | 400 | 400 | 404 | `tests/consume.db.test.ts:698-703`, `tests/requests.db.test.ts:270-271`, `tests/users.db.test.ts:117` |
| NUL | 400 | 400 | 404 | `tests/input-encoding.db.test.ts:104-152` (F2) |
| Invalid percent-encoding | — | 404 (P3) | 404 | `tests/input-encoding.db.test.ts:61-101` (F1, path only); TP-ENC-06 (query) |
| Lone surrogate | 400 | can't occur (P3) | 404 | TP-ENC-01…04, TP-REG-03 |
| Non-UUID `planId` | 400 | — | 404 | `tests/users.db.test.ts:81`, `tests/plans.db.test.ts:130` |
| Wrong JSON type | 400 for `externalUserId: 7` | — | — | `tests/users.db.test.ts:81`; TP-ERR-01 for `requestId` |

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-ERR-01 | R19, R68 | `POST /consume` with `requestId` set to `7`, `null`, `["r"]`, `{}`; and `externalUserId: 7` | 400 `VALIDATION_ERROR`, nothing written | integration | P2 | Not run |
| TP-ERR-02 | R19, R78 | Non-ASCII whitespace around IDs: `" alice"`, `"alice　"`, `"﻿alice"` in a `/consume` and `/users` body, and as a path segment (percent-encoded) | Body 400, path 404. JavaScript `trim()` removes these, so the existing whitespace rule should already apply | integration | P3 | Not run |
| TP-ERR-03 | R6, F10 | `POST /consume` with `requestId: "\ud800"` and **no** `X-API-Key` | 401 `UNAUTHORIZED` (auth runs before validation, as for the F1 cases) | integration | P2 | Not run |
| TP-ERR-04 | R68 | `POST /consume { requestId: "\ud800", units: 0, externalUserId: "alice" }` | One 400 whose message names both `requestId:` and `units:` (`parseInput` joins every issue) | integration | P3 | Not run |

#### 4.4 F10 — distinct malformed IDs are never an idempotent replay

Integration. These can live in `tests/input-encoding.db.test.ts` (same setup) or in `tests/consume.db.test.ts` next to the existing replay tests. Each test ends with the invariant check used by `tests/consume.db.test.ts:489`: account usage = sum of user usage = sum of accepted request units.

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-IDEM-01 | F10, R67, R78 | The F10 scenario: `POST /consume` alice, 1 unit, `requestId: "\ud800"`; then alice, 1 unit, `requestId: "\udfff"` | Both 400. Neither body has `replayed`. Account and user usage 0, no request rows | integration | P0 | Red: QA probe (second → `200 ACCEPTED, replayed: true`, nothing consumed) |
| TP-IDEM-02 | F10, R67 | `requestId: "\ud800"` with 1 unit, then `requestId: "\udc00"` with 2 units | Both 400. Never 409 `IDEMPOTENCY_CONFLICT` | integration | P0 | Red: QA probe (409) |
| TP-IDEM-03 | F10, R67, R78 | A legitimate U+FFFD key isn't shadowed: `requestId: "r�"` 1 unit → then `"r\ud800"` 1 unit → then `"r�"` 1 unit again | 1st: 200 `ACCEPTED`, `replayed: false`. 2nd: 400 (not a replay of the 1st). 3rd: 200, `replayed: true`, body otherwise identical to the 1st. Usage = 1 | integration | P0 | Red: code reading (the 2nd would replay the 1st today) |
| TP-IDEM-04 | F10, R2, R8, R32 | User collision: register `"�"` (201). Then `POST /users { externalUserId: "\ud800" }`, then `POST /consume { externalUserId: "\udbff", units: 1, requestId: "u1" }` | `"�"`: 201. `"\ud800"`: 400, not 409 `ALREADY_EXISTS`. The consume: 400. The `"�"` user's usage stays 0 | integration | P0 | Red: QA probe (409 for the second user; consumes charged to the first) |
| TP-IDEM-05 | R67, R78 | Valid pairs that share a high surrogate: `requestId: "😀"` (`😀`) then `"😁"` (`😁`), 1 unit each. Also register users `"😀"` and `"😁"` | Two fresh decisions (`replayed: false`), usage 2, two request rows. Both users 201 | integration | P0 | Not run. Catches a fix that strips or replaces surrogates instead of rejecting only lone ones. |
| TP-IDEM-06 | R67 | The same key in two encodings: `requestId` sent as raw UTF-8 `"😀"`, then a raw body with the escape `"😀"` | 2nd: 200 `replayed: true`. They are the same string, so this is a true retry | integration | P1 | Not run |
| TP-IDEM-07 | R67, R78 | No normalization: `requestId` `"é"` (U+00E9) then `"é"`; register users `"é"` and `"é"` | Two fresh decisions; two users (201, 201). README says IDs are compared exactly (`README.md:1288`) | integration | P1 | Not run |
| TP-IDEM-08 | R36, R67 | 20 parallel copies of `requestId: "🧾-1"`, 3 units each (mirrors `tests/consume.db.test.ts:268` with a non-ASCII key) | One `replayed: false`, 19 `replayed: true`, one request row, usage 3 | integration | P2 | Not run |
| TP-IDEM-09 | F10 | Root-cause canary, direct `pg`: `SELECT $1::text = $2::text` with `"\ud800"`, `"\udfff"` | `true` (the driver replaces both with U+FFFD). Documents why the guard has to be in the app; it changes only if node-postgres changes | integration | P3 | Observed by QA rev 2 (direct query); never a test |

#### 4.5 Valid Unicode and surrogate pairs keep working

Integration, `tests/input-encoding.db.test.ts` or `tests/users.db.test.ts`. Every response comparison uses strict equality (`toBe`), not a pattern match.

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-UTF-01 | R2, R3, R45, R78 | `POST /users { externalUserId: "👍", name: "Thumbs 👍" }`; `GET /users/%F0%9F%91%8D`; `GET /users/%F0%9F%91%8D/usage`; `PUT /users/%F0%9F%91%8D/plan` (Premium); `GET /users` | 201, 200, 200, 200; every response has `externalUserId === "👍"`; the name round-trips; the list contains the user | integration | P0 | Not run (only `"user/42 é"` and `"bob\u0001é"` are tested today) |
| TP-UTF-02 | R19, R30, R47, R78 | Consume for `"👍"` with `requestId: "📄-1"`, 10 units; `GET /requests?externalUserId=%F0%9F%91%8D` | `ACCEPTED`, response `requestId === "📄-1"`; the history entry has the same `requestId` and `externalUserId`; user and account usage 10 | integration | P0 | Not run |
| TP-UTF-03 | R78 | For each v in W: register v, `GET /users/${encodeURIComponent(v)}`, consume 1 unit with `requestId: v` | All 201 / 200 / `ACCEPTED`; strings returned unchanged; each v is its own user (count = \|W\|) | integration | P1 | Not run |
| TP-UTF-04 | R19 | `externalUserId` and `requestId` of `"👍".repeat(128)` (accepted, and resolvable by path), and of 129 (400 in a body, 404 in a path) | As stated. 128 emoji are 256 UTF-16 code units and 512 UTF-8 bytes, so this also checks the URL path length and the text column | integration | P2 | Not run (P6) |
| TP-UTF-05 | R12, R1 | Names: `POST /plans { name: " Plan 😀 " }` → stored `"Plan 😀"`; then `"Plan 😁"` → 201 (distinct); `POST /accounts { name: "Ünïcode ✓ 👍" }` | 201 each, names trimmed but otherwise unchanged | integration | P2 | Not run (`"Ünïcode ✓"` is covered at `tests/input-encoding.db.test.ts:155`) |

#### 4.6 F1 and F2 regression tests

Already covered, in the working tree only: `tests/input-encoding.db.test.ts:61-101` (F1: 4 encodings × 5 routes, auth first, well-formed encodings still resolve), `:104-152` (F2: 8 body inputs, 7 query inputs, path inputs, nothing written), `tests/errors.test.ts:66-77` (F1 fallback for a router without its own mapping). The tests below add the process gate and the gaps.

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-REG-01 | F1, F2, R68 | Gate: the F1/F2 fix and `tests/input-encoding.db.test.ts` are committed together. Then, on a clean checkout of that commit: `REQUIRE_DB=1 npx vitest run tests/input-encoding.db.test.ts tests/errors.test.ts`, then the full suite | Both files pass with 0 skipped; the full suite reports 22 files / ≥ 400 tests (QA rev 2's count), 0 failed | integration | P0 | QA rev 2 ran the suite on the uncommitted tree: 22 files, 400 passed. Not run on a commit. |
| TP-REG-02 | F1, F2 | Fail-before check: copy the regression tests into a `git worktree` of `47fa0e7` (outside the working tree) and run them there | The F1 and F2 cases fail with 500 `INTERNAL_ERROR`. This proves the tests detect the bugs. Nothing in the main working tree changes | integration | P1 | Not run |
| TP-REG-03 | F1, F10, R68 | Extend the `malformed` list at `tests/input-encoding.db.test.ts:62` with `%ED%A0%80` (encoded high surrogate), `%ED%B0%80` (encoded low surrogate), `%C0%AF` (overlong), `%F4%90%80%80` (above U+10FFFF), `%E0%80` (truncated) | Every one: 404 `User not found` / `Plan not found` on all 5 routes; the plan is unchanged; no `console.error` | integration | P1 | Not run (P2: `decodeURIComponent` throws on the first) |
| TP-REG-04 | F1, R68 | A no-500 sweep: a fixed table of {each authenticated route} × {path, query, body where applicable} × {NUL, `%ZZ`, `%ED%A0%80`, a lone surrogate in a body} | Every status is 400, 401 or 404. No 500. No `console.error` | integration | P1 | Not run |
| TP-REG-05 | F2, R19 | NUL gaps: `PUT /account/plan { planId: "<uuid>\u0000" }`; a body key containing NUL (`{"a\u0000": 1}` on `/consume`); `GET /users?limit=1%00` | 400 `VALIDATION_ERROR` each, nothing written | integration | P2 | Not run |
| TP-REG-06 | F2, R67 | A rejected NUL key isn't spent: `requestId: "r\u0000"` → 400, then `requestId: "r"` | 2nd: 200, `replayed: false`, usage 1. A 400 writes nothing (`README.md:1202`) | integration | P2 | Not run |
| TP-REG-07 | F1 | Unknown routes with bad encoding: `GET /nope/%ZZ`, `GET /account/%ZZ` | 404 `NOT_FOUND` in the standard shape | integration | P3 | Not run |

#### 4.7 Restart persistence

R49 says data must survive a restart. QA rev 2 verified it by hand on a fresh Compose stack (`down` without `-v`, then `up`). There is no automated test.

**Feasibility.** `tests/server.db.test.ts:41-80` already starts `src/server.ts` as a real process against `quota_test` (`startServer()`, `waitFor()`, SIGTERM handling). A restart test fits that convention if `startServer()` moves to a shared helper such as `tests/helpers/server.ts` (a test-code refactor, D5). Restarting **PostgreSQL** doesn't fit Vitest, because the test database is the shared Compose `db` container; that case needs a script (TP-PERS-02).

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-PERS-01 | R49, R40, R42, R67 | New `tests/restart.db.test.ts`. `resetDatabase()` once at the start. Start the server (`WORKERS=1`). Over HTTP: `POST /accounts`; create a custom USER plan (100/mo, 20/req); register `alice` on it and `bob` on Premium; `PUT /account/plan` Pro; consume alice 10 (`p-1`, accepted) and alice 25 (`p-2`, rejected by user per-request). Record every response. SIGTERM, wait for exit 0. Start a **new** server process on a new port | The same key authenticates. `GET /account` shows Pro and `consumed: 10`. `GET /users/alice` shows the custom plan; bob shows Premium. `GET /plans` contains the custom plan. `GET /requests` returns both entries, deep-equal to before. Replaying `p-1` and `p-2` returns `replayed: true` with the original bodies. Account usage = sum of user usage | end-to-end | P1 | Not run (manual check in QA rev 2) |
| TP-PERS-02 | R49, R59, R60 | Scripted Compose restart (suggested `scripts/e2e-restart.sh`, D5): an isolated project `-p qa-persist` with remapped ports; `up --build -d --wait`; the same writes as TP-PERS-01 via `curl`; `docker compose restart`; then `down` (keep the volume) and `up -d --wait`; check; `down -v --rmi local` | Same as TP-PERS-01 after both restarts. The API log shows `seed: 0 predefined plan(s) inserted` after each restart. `GET /plans` lists 4 predefined plans plus the custom one | end-to-end | P2 | Verified by hand in QA rev 2 (R49, R59) |
| TP-PERS-03 | R49, R69 | PostgreSQL restarts under a running API: `docker compose restart db` while the API is up | `/healthz` returns 503 while the DB is down and 200 after. The first consume afterwards succeeds. No process crash | end-to-end | P3 | Not run |

#### 4.8 Load: 200-VU hot account, overload responses and invariants

This closes F6: the 503 + `Retry-After` path (R69) has only been tested in integration tests (`tests/consume.db.test.ts:578`, `:632`, `tests/errors.test.ts:99`, `:112`), and every 200-VU run predates `e1ab78e`.

**Preconditions (for every TP-LOAD test)**

1. The code under test is committed and the API image is rebuilt from it (`docker compose up -d --build --wait db api`, `WORKERS=1`). Record `git rev-parse HEAD` and `git status --porcelain` with each run, since `load/run.sh` doesn't record them (F11).
2. Load tooling change, D6. Today `record()` in `load/lib.js:115-128` counts every non-200 as one error. It can't tell a 503 from a 500 and never looks at `Retry-After`. Proposed: count by status (`consume_status_503`, `consume_status_500`, `consume_status_other`), count 503s that break the contract (`consume_503_bad_contract`: `Retry-After` missing or not `1`, or `error.code` not `SERVICE_UNAVAILABLE`), and add all of them to `SUMMARY_JSON`. Optional: `RETRY_503=n`, which retries a 503 with the same `requestId` after `Retry-After`, counting `consume_retried`, `consume_retry_replayed` and `consume_retry_exhausted`.
3. The checks `load/run.sh` already makes are reused: `load/check-invariants.sql` checks 1–4, `k6 fresh = request rows`, and the API log counts of `unhandled error` and `service unavailable (overload)`.

**Why 200 VUs may produce no 503s.** Earlier `WORKERS=1` probes with the same settings had 8, 0, 225 and 0 errors (`docs/LOAD_TEST.md:363`). By Little's law, about 190 requests queue for 10 connections that drain at ~95 req/s, so the expected pool wait is about 190 / 95 ≈ 2.0 s, the same as `connectionTimeoutMillis` (2 s, `src/db/client.ts:9`). That would explain why identical runs swing from 0 to 225. This is an estimate, not a measurement, and it's why TP-LOAD-02 exists.

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-LOAD-01 | F6, R69, R32, R36, R62 | `VUS=200 DURATION=20s load/run.sh hot-account`, 3 runs, `WORKERS=1`, with the D6 counters | Per run: (a) `consume_status_500 = 0` and `consume_status_other = 0`; (b) `consume_503_bad_contract = 0`; (c) API log `unhandled error` = 0, and `service unavailable (overload)` lines = k6's 503 count; (d) invariant checks 1–4 = 0; (e) `k6 fresh = request rows … OK`. R69 counts as verified under load only if at least one run has 503 > 0. If all three have 0, the result is inconclusive (not a failure), and TP-LOAD-02 decides | load | P1 | Not run on the current code. Pre-`e1ab78e` runs returned 500s for the same condition (`README.md:1393`) |
| TP-LOAD-02 | F6, R69 | Forced overload: `VUS=300 DURATION=20s load/run.sh hot-account`, 1 run. Estimated wait ≈ 290 / 95 ≈ 3.1 s, above the 2 s pool timeout | (a)–(e) as TP-LOAD-01, and `consume_status_503 > 0` | load | P1 | Not run |
| TP-LOAD-03 | R67, R69 | TP-LOAD-02 with `RETRY_503=3` | `consume_retry_replayed = 0`: a retry after a 503 must be a fresh decision, because a 503 wrote nothing (a replay would mean the 503 attempt committed). Request rows = distinct `requestId`s that got a 200. Invariants 0. `consume_retry_exhausted` is reported, not a failure | load | P2 | Not run |
| TP-LOAD-04 | R36, R62, F10 | After the F10 fix: `load/run.sh hot-account` at the default 50 VUs, 1 run | Invariants 0, 0 errors, RPS within the documented spread for one run (85.2–103.3 req/s). The fix adds a check on ≤ 128-character strings, so no change is expected | load | P3 | Not run |

The load tests leave their accounts in the dev database (`README.md:1409`). Results go to `load/results/` and should be cited in `docs/LOAD_TEST.md`, which also resolves the citation part of F11 for the new runs.

#### 4.9 F8 — `perRequestLimit > monthlyLimit`

F8 is a product decision (D3). The tests depend on which option is chosen.

**Recommendation: Option B, allow it and document it.** Reasons:

- Decisions are correct either way: a request above the monthly allowance is rejected by the monthly rule (`MONTHLY_LIMIT_EXCEEDED`, with the monthly limit as `limit`).
- Option A conflicts with the brief's "allowance reduced below usage" case. Lowering a custom plan from 10,000/100 to 50/month would become a 400 unless the caller also lowers `perRequestLimit` in the same PATCH.
- `monthlyLimit: 0` already means "suspended" (`README.md:1297`), and with it every plan has `perRequestLimit > monthlyLimit`. Option A needs an exception for it.
- `CLAUDE.md` says unspecified behavior gets a sensible choice plus a README assumption. Option B is that.

**Option B tests (recommended)**

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority | Current evidence |
|---|---|---|---|---|---|---|
| TP-F8-01 | F8, R17 | `POST /plans { type: "USER", monthlyLimit: 5, perRequestLimit: 1000 }`; `PATCH` a 100/10 plan to `{ monthlyLimit: 5 }` | 201; 200 | integration | P1 | QA probe observed 201 and 200 (rev 1 and 2). Not a test. |
| TP-F8-02 | F8, R20, R23 | Assign that 5/1000 USER plan to alice (account on Starter). Consume 6, then 5, then 1 | 6: `REJECTED`, `MONTHLY_LIMIT_EXCEEDED`, `USER`, `limit: 5`. 5: `ACCEPTED`, user remaining 0. 1: `REJECTED`, `MONTHLY_LIMIT_EXCEEDED`. Same pattern for an ACCOUNT plan (`rejectedBy: ACCOUNT`) | integration | P1 | Not run |
| TP-F8-03 | F8, R20 | `evaluate()` unit cases in `tests/rules.test.ts`: user plan 5/1000 with `units` 6 and 5; account plan 5/1000 the same | As TP-F8-02, without a DB | unit | P1 | Not run |
| TP-F8-04 | F8, R41 | Lowering in one call: custom plan 10,000/100 with 60 consumed; `PATCH { monthlyLimit: 50 }` | 200; remaining 0; the next consume is rejected by `MONTHLY_LIMIT_EXCEEDED` | integration | P1 | Not run (similar to `tests/consume.db.test.ts:369`) |
| TP-F8-05 | F8, R72 | Document review: README Assumptions has an F8 entry with its reasoning | Present | review | P1 | Missing today (F8) |

**Option A tests (only if rejection is chosen instead)**

| Test ID | Req / finding | Scenario and setup | Expected result | Type | Priority |
|---|---|---|---|---|---|
| TP-F8-A1 | F8, R17 | `POST /plans` with `monthlyLimit: 5, perRequestLimit: 1000`; and with `monthlyLimit: 0, perRequestLimit: 1000` | 400 `VALIDATION_ERROR`, nothing written; 201 (the suspend case is exempt) | integration | P1 |
| TP-F8-A2 | F8, R17 | The merged PATCH result: plan 100/50, `PATCH { monthlyLimit: 10 }`; then `PATCH { monthlyLimit: 10, perRequestLimit: 10 }` | 400 and the plan unchanged; then 200 | integration | P1 |
| TP-F8-A3 | F8, R37 | Plans created before the change that break the new rule can still be read, assigned and consumed against. If a DB CHECK is added, its migration handles existing rows | No 500, no failed migration | integration | P1 |
| TP-F8-A4 | F8, R10 | The four predefined plans satisfy the rule | They do (100 ≤ 10,000, 1,000 ≤ 100,000, 20 ≤ 1,000, 100 ≤ 5,000) | unit | P2 |

### 5. Decisions that need your approval

| ID | Decision | Recommendation | Affects |
|---|---|---|---|
| D1 | F10 fix policy: reject ill-formed UTF-16 in **every** caller-supplied string (IDs, names, cursor), the same way as NUL (400 body/query, 404 path). Alternative: IDs only, or replace silently | Reject in `textSchema()`, for all strings. Silent replacement is the bug. | §4.1–§4.4 expected results |
| D2 | Raw invalid UTF-8 bytes in a JSON body (P4). `isWellFormed()` doesn't catch them, so the F10 collision stays reachable this way. Options: reject the whole body with 400 (e.g. an `express.json({ verify })` check with `buffer.isUtf8()`), or document it as a known limitation. Also: record it as part of F10 or as a new finding after Phase 3 confirms it on the full app | Reject with 400, as part of the F10 fix. Record it in the QA report only after TP-ENC-08 has confirmed it. | TP-ENC-08 |
| D3 | F8: allow and document (B), or reject (A) | B (§4.9) | §4.9, README |
| D4 | Lenient decoding in query values and cursors (P3, P5): `%FF` and `%FE` both read as U+FFFD; a valid cursor with junk appended is accepted. Read-only, nothing written | Keep it, add one line to README Assumptions, and pin it with TP-ENC-06 and TP-ENC-07 | TP-ENC-06, TP-ENC-07 |
| D5 | Test-code structure: move `startServer()` from `tests/server.db.test.ts` to `tests/helpers/server.ts` for TP-PERS-01; add `scripts/e2e-restart.sh` for TP-PERS-02 | Yes to the helper (P1); the script only if time allows (P2) | §4.7 |
| D6 | Load tooling: change `record()` in `load/lib.js` (status counters, `Retry-After` check, optional `RETRY_503`), and have `load/run.sh` record the commit and dirty state. These are test scripts, but they produce the evidence that `docs/LOAD_TEST.md` cites | Yes. Without it TP-LOAD-01 can't tell a 503 from a 500 | §4.8 |
| D7 | Length unit: Zod counts code points (P6), so 128 emoji are accepted. The README says "128 characters" | Keep it, and say "code points" in the README | TP-UNIT-05, TP-UTF-04 |

### 6. Phase 3 — execution order

1. **Commit the F1/F2 fix with its tests** (TP-REG-01). This is your change in the working tree; Phase 3 shouldn't commit it without your go-ahead.
2. **Write and run the P0 tests**: TP-UNIT-01/03, TP-ENC-01…03, TP-IDEM-01…05, TP-UTF-01/02, with `REQUIRE_DB=1`. Expected outcome on the current tree: the F10 tests (marked "Red") **fail** for the reason the QA probe showed, and TP-UNIT-03, TP-IDEM-05 and TP-UTF-01/02 pass. Record the actual results, including failures, in `docs/QA_REPORT.md`. Keep the failing F10 tests on a branch until the F10 fix (a separate step, after D1/D2) lands, so `main` stays green.
3. **P1 integration tests**: TP-REG-02/03/04, TP-ENC-04/08, TP-IDEM-06/07, TP-UTF-03, and the F8 set chosen in D3.
4. **TP-PERS-01** (after D5).
5. **Load** (after D6, with the fixes committed and the image rebuilt): TP-LOAD-01 ×3, then TP-LOAD-02. About 1 minute of k6 time per run plus about 15 s for the checks.
6. P2/P3 as time allows.

**Exit criteria for Phase 3:** every executed test is reported with its real outcome; every P0 test was executed; the full suite was run with `REQUIRE_DB=1` and its file and test counts recorded; no test is reported as passing without having run.

### 7. Not covered by this plan

- F3, F4, F5, F7, F9 (no tests requested; they are documentation or design items).
- The client page rendered in a browser (QA §7).
- Docker Engine < 25 (F9).
- The cause of the `many-accounts-06e6a282` throughput (F11). §4.8 only prevents the same citation problem for the new runs.

### 8. Execution record (revision 2)

Executed on 2026-10-20 with `REQUIRE_DB=1` against `quota_test`. The code was `b56dbc0` without the F10 fix (red run), then with it (green run). The tests are in `tests/unicode-schemas.test.ts` (unit) and `tests/unicode-input.db.test.ts` (integration). Details, counts and evidence are in `docs/QA_REPORT.md` revision 3 (§1 and F10).

**Run as specified (21):**

| Test IDs | Before the fix | After the fix |
|---|---|---|
| TP-UNIT-01, TP-UNIT-02 | Failed, as predicted (Red) | Pass |
| TP-UNIT-03, TP-UNIT-04 | Pass | Pass |
| TP-ENC-01, 02, 03, 04, 08 | Failed, as predicted (Red) | Pass |
| TP-ENC-06 (both parts; the second is a characterization of D4) | Pass | Pass |
| TP-ERR-03 | Pass | Pass |
| TP-IDEM-01, 02, 03, 04 | Failed, as predicted (Red) | Pass |
| TP-IDEM-05, 07, 09 | Pass | Pass |
| TP-IDEM-06 | Pass, but **not a valid run**: the escaped body had been stored as a literal 😀 | Fixed in the commit-prep review (QA report §1); passes as specified |
| TP-UTF-01, TP-UTF-02 | Pass | Pass |

Totals: before the fix, 63 failed and 23 passed (86); after it, 86 passed. The full suite went from 63 failed / 423 passed to 486 passed. TP-ENC-08 was extended beyond §4.2 with the reverse direction, bytes that encode surrogates, and the user case. Its first run passed falsely because Supertest JSON-encoded the `Buffer`; that was corrected before the counts above (QA report §1).

**Run in part (2):**

| Test ID | Run | Not run |
|---|---|---|
| TP-ENC-07 | The first two cases (400 `cursor: invalid cursor`) | The third case (`<valid nextCursor>%FF`), which depends on D4 |
| TP-REG-03 | `%ED%A0%80` and `%ED%B0%80` on the three user routes, as a separate test in `tests/unicode-input.db.test.ts` | `%C0%AF`, `%F4%90%80%80`, `%E0%80`, the plan routes, and the extension of the `malformed` list in `tests/input-encoding.db.test.ts` |

**Not run (31):**
- TP-UNIT-05; TP-ENC-05; TP-ERR-01, 02, 04; TP-IDEM-08; TP-UTF-03, 04, 05.
- TP-REG-01, 02, 04, 05, 06, 07. For TP-REG-01, the full suite passed (486), but on the working tree, not on a clean checkout of `b56dbc0` as specified.
- TP-PERS-01, 02, 03; TP-LOAD-01, 02, 03, 04.
- TP-F8-01…05; TP-F8-A1…A4.

**Decisions:**

| ID | Status |
|---|---|
| D1 | Applied as recommended: `textSchema()` rejects unpaired surrogates |
| D2 | Applied, and extended with the developer's approval: an `express.json()` `verify` hook rejects bodies that aren't valid UTF-8, **and** bodies declaring any charset other than UTF-8 (UTF-16, UTF-32 and UTF-7 can also yield U+FFFD or lone surrogates). Recorded under F10 in the QA report |
| D4 | Not formally decided. The current lenient behavior is kept, documented in the README surrogate assumption, and pinned by the TP-ENC-06 characterization |
| D3, D5, D6, D7 | Open |

**Changes to §6:**
- Step 1 is done: the F1/F2 fix is commit `b56dbc0`.
- Step 2's "keep the failing F10 tests on a branch" no longer applies, because the tests and the fix are meant to be committed together.
- Steps 3–6 remain open, except the parts listed above.
