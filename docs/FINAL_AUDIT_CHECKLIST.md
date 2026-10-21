# Final Audit Checklist

Commit `b454b81`, audited 2026-10-21. Every row points to its evidence in [FINAL_AUDIT_REPORT.md](FINAL_AUDIT_REPORT.md) (§ = report section).

**Remediation, later the same day:** this checklist shows the audit-time state. For what changed afterwards, see [FINAL_AUDIT_REMEDIATION.md](FINAL_AUDIT_REMEDIATION.md) §1–§3:
- fixed or covered: AUD-01, -02, -03, -04, -05, -15, -16, -17, -23, and part of -20;
- RQ-35 is now verified for a restart of the API source process under tsx; not for the compiled image, the container, or a PostgreSQL restart.

Legend: ✅ Fully Implemented / passed · 🟡 Partially Implemented · ❔ Unable to Verify · ❌ Missing / not met. "Ran" = the evidence was executed in this audit; otherwise it's code reading or the repository's own docs.

## Requirements (brief, implicit, project)

| Status | ID | Requirement | Evidence |
|---|---|---|---|
| ✅ | RQ-01 | Create accounts, issue an API key | §4.1; tests ran |
| ✅ | RQ-02 | Register users under accounts | §4.1; tests ran |
| ✅ | RQ-03 | Assign or change user plans | §4.1; tests ran |
| ✅ | RQ-04 | Users and usage separate per account | §4.1, §7; tests ran |
| ✅ | RQ-05 | API key in a header identifies the account | §4.1; tests ran |
| ✅ | RQ-06 | Missing or invalid key rejected (401) | §4.1; tests ran |
| ✅ | RQ-07 | Key scoped to its account; supplied user must belong to it | §4.1, §7; tests ran |
| ✅ | RQ-08 | Another account's resource → 404 | §4.1; tests ran |
| ✅ | RQ-09 | Predefined plans at startup, limits documented | §4.2; tests ran |
| ✅ | RQ-10 | Custom plans: create, view, update, assign | §4.2; tests ran |
| ✅ | RQ-11 | A shared plan keeps separate usage totals | §4.2; tests ran |
| ✅ | RQ-12 | Predefined plans read-only | §4.2; tests ran |
| ✅ | RQ-13 | Inspect the plans and limits currently applied | §4.2; tests ran |
| ✅ | RQ-14 | Plan-assignment guard (owner, type) on every write | §4.2; tests ran |
| ✅ | RQ-15 | Consume input: user, positive whole units, requestId | §4.3; tests ran |
| ✅ | RQ-16 | All-or-nothing; a rejection consumes nothing | §4.3; tests ran |
| ✅ | RQ-17 | Monthly allowance per UTC month | §4.3; tests ran |
| ✅ | RQ-18 | Max units per request, both levels | §4.3; tests ran |
| ✅ | RQ-19 | The brief's three worked examples | §4.3; tests ran |
| ✅ | RQ-20 | A user plan doesn't raise the account allowance | §4.3; tests ran |
| ✅ | RQ-21 | Account usage = sum of user usage | §4.3, §8; tests ran; load invariants spot-checked |
| ✅ | RQ-22 | Rejection names the rule and its owner | §4.3; tests ran |
| ✅ | RQ-23 | Rule check order | §4.3; tests ran |
| ✅ | RQ-24 | Usage in the processing month; month rollover | §4.3, §8; tests ran |
| ✅ | RQ-25 | Plan changes take effect with no redeploy | §4.4; tests ran |
| ✅ | RQ-26 | Editing a custom plan affects its assignees | §4.4; tests ran |
| ✅ | RQ-27 | Switching keeps consumed units | §4.4; tests ran |
| ✅ | RQ-28 | Allowance below usage → 0 remaining, rejected | §4.4; tests ran |
| ✅ | RQ-29 | Past request history preserved (plan limits not snapshotted: QA F4) | §4.4, §5.8; tests ran |
| ✅ | RQ-30 | Correct under concurrent plan updates | §4.4, §8; tests ran |
| ✅ | RQ-31 | Additional rules explained (none implemented) | §4.4 |
| ✅ | RQ-32 | Consumed and remaining, account and user | §4.5; tests ran |
| ✅ | RQ-33 | Past months, history, pagination (AUD-02 caveat) | §4.5, §5.2; tests ran |
| ✅ | RQ-34 | Everything stored in PostgreSQL | §4.5; tests ran |
| ❔ | RQ-35 | Data survives a restart | §4.5, §12; not run at HEAD (AUD-17) |
| ✅ | RQ-36 | Usage reads never create rows | §4.5; tests ran |
| ✅ | RQ-37 | Example client calls with the account's key | §4.6, §9; demo test ran |
| ✅ | RQ-38 | Demo: different plans, accepted, user-limit and account-limit rejections | §4.6, §9; demo test ran |
| ✅ | RQ-39 | Plan switch changes behavior, client code unchanged | §4.6, §9; demo test ran |
| ❔ | RQ-40 | Page displays the decision and remaining allowances | §4.6, §9; HTML 200 ran, browser not used (AUD-16) |
| ✅ | RQ-41 | Instructions for running the example | §4.6 |
| ✅ | RQ-42 | Compose file: API, DB, client | §4.6, §9; config validated and running containers == HEAD (ran) |
| ❔ | RQ-43 | Fresh-clone `docker compose up --build`, no manual steps | §4.6, §6 (not run), §12 |
| ✅ | RQ-44 | DB init and seed at startup (AUD-01 for future migrations) | §4.6, §5.1 |
| ✅ | RQ-45 | Configuration and client access documented | §4.6 |
| ✅ | RQ-46 | Load testing with evidence, method and lessons | §4.7, §10; numbers spot-checked (ran) |
| 🟡 | RQ-47 | Correct "as rules change", under load | §4.7, AUD-20 |
| 🟡 | RQ-48 | Results and tooling committed and reproducible | §4.7, AUD-21, AUD-23 |
| ✅ | RQ-49 | Bottlenecks understood; improvement measured | §4.7, §10 |
| ✅ | RQ-50 | Safe retries, competing requests, useful errors | §4.7, §8; tests ran |
| ✅ | RQ-51 | README covers every required topic | §4.7, §11 |
| ✅ | RQ-52 | Automated tests incl. key validation and isolation | §4.7, §6 #6 (562 passed, ran) |
| ✅ | RQ-53 | No integer overflow | §4.8, §8 |
| ✅ | RQ-54 | Malformed input never a 500 | §4.8; tests ran |
| ✅ | RQ-55 | A 500 leaks no internals | §4.8, §7; tests ran |
| ✅ | RQ-56 | A rejection is HTTP 200 | §4.8; tests ran |
| ✅ | RQ-57 | Out-of-scope features correctly absent | §4.8 |
| ❌ | IC-01 | Internal criterion TP-LOAD-04 (≥ 85.2 req/s), not a brief requirement | §4.9, AUD-22 |
| ❔ | IC-02 | PLAN Phase 8 walkthrough | §4.9, DOC-07 |

## Audit areas

| Status | Area | Evidence |
|---|---|---|
| ✅ | Git state clean, HEAD == `origin/main`, no tracked changes, no secrets or large files | §2, §6 #1, #14, #15 |
| ✅ | Typecheck, lint, client typecheck, build | §6 #2–#5 (ran) |
| ✅ | Full test suite, `REQUIRE_DB=1`, 0 skipped: 27 files, 562 tests | §6 #6 (ran) |
| ✅ | Lockfiles consistent; production dependencies 0 vulnerabilities | §6 #8–#10 (ran); AUD-09 |
| ✅ | Consume transaction order, locking, idempotency, overflow | §8 |
| ✅ | Tenant isolation and auth | §7 |
| ✅ | Running containers built from HEAD, non-root, clean image layers | §6 #12–#13 (ran) |
| 🟡 | Compose / startup hardening (ports on 0.0.0.0, no restart policy, fixed API port, build context) | AUD-06, AUD-11, AUD-13, AUD-14 |
| 🟡 | Migration robustness for future schema changes | AUD-01 |
| 🟡 | Example client operations (SIGTERM, listen errors, typecheck coverage) | AUD-03, AUD-04, AUD-05 |
| 🟡 | Test coverage gaps (user-limit race, client route/page, restart persistence) | AUD-15, AUD-16, AUD-17 |
| ✅ | Load evidence matches the raw files; conclusions follow from it | §10, §6 #17 (ran) |
| 🟡 | Load reproducibility (commit not recorded; §9 untracked) | AUD-21, AUD-23 |
| 🟡 | Documentation current (stale QA/CLAUDE lines; history-ordering caveat) | §11 DOC-01…DOC-05 |
| ❔ | Fresh clone, restart persistence, browser demo, load re-run, 503 at 200 VUs | §6 "Not run", §12 |
| ✅ | Audit integrity: `load/results/` and `dist/` checksums and git status unchanged | §2, §6 #18 (ran) |

## Decisions pending (you)

- [ ] Commit, or keep local, the 33 untracked `load/results/` files (AUD-21)
- [ ] Apply any post-deadline fix? (§1, §14)
- [ ] Approve or decline the fixes that need sign-off: AUD-06, AUD-03 (`init: true`), AUD-23, AUD-20 / F6 load runs, ops items (§13)
- [ ] Optionally run a fresh-clone `docker compose up --build` and one browser demo (§14)
