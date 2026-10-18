-- Post-run checks. Each violation count must be 0.
-- Run with: psql -v run_id=<RUN_ID> -f load/check-invariants.sql
--   Checks 1 and 4 cover every account and month in the database.
--   Checks 2 and 3 cover the current UTC month only: a limit applies to the month being consumed, and
--   only the current plan assignment is stored, so a past month can't be checked against its plan.
--   Section 5 covers this run only: accounts named load-<scenario>-<run_id>-<n>, matched exactly on the run ID.
\pset footer off

\echo '1. account usage = sum of its users usage, every account and month (violations, must be 0)'
WITH u AS (SELECT account_id, month, SUM(units_used) AS units FROM user_usage GROUP BY 1, 2)
SELECT COUNT(*) AS usage_sum_violations
FROM account_usage a FULL JOIN u USING (account_id, month)
WHERE COALESCE(a.units_used, 0) <> COALESCE(u.units, 0);

\echo '2. no account over its plan monthly limit, current UTC month (violations, must be 0)'
SELECT COUNT(*) AS account_over_limit
FROM account_usage au
JOIN accounts a ON a.id = au.account_id
JOIN plans p ON p.id = a.plan_id
WHERE au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
  AND au.units_used > p.monthly_limit;

\echo '3. no user over its plan monthly limit, current UTC month (violations, must be 0)'
SELECT COUNT(*) AS user_over_limit
FROM user_usage uu
JOIN users u ON u.account_id = uu.account_id AND u.id = uu.user_id
JOIN plans p ON p.id = u.plan_id
WHERE uu.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
  AND uu.units_used > p.monthly_limit;

\echo '4. account usage = sum of its ACCEPTED request units, every account and month: no retry counted twice (violations, must be 0)'
WITH r AS (SELECT account_id, month, SUM(units) AS units FROM requests WHERE status = 'ACCEPTED' GROUP BY 1, 2)
SELECT COUNT(*) AS usage_vs_requests_violations
FROM account_usage a FULL JOIN r USING (account_id, month)
WHERE COALESCE(a.units_used, 0) <> COALESCE(r.units, 0);

\echo '5. this run''s accounts'
WITH run_accounts AS (
  SELECT id FROM accounts WHERE name LIKE 'load-%' AND split_part(name, '-', 3) = :'run_id'
)
SELECT (SELECT COUNT(*) FROM run_accounts) AS accounts,
       COUNT(r.id) AS request_rows,
       COUNT(r.id) FILTER (WHERE r.status = 'ACCEPTED') AS accepted_rows,
       COUNT(r.id) FILTER (WHERE r.status = 'REJECTED') AS rejected_rows,
       COALESCE(SUM(r.units) FILTER (WHERE r.status = 'ACCEPTED'), 0) AS accepted_units,
       (SELECT COALESCE(SUM(au.units_used), 0) FROM account_usage au WHERE au.account_id IN (SELECT id FROM run_accounts))
         AS account_units_used,
       (SELECT COALESCE(SUM(uu.units_used), 0) FROM user_usage uu WHERE uu.account_id IN (SELECT id FROM run_accounts))
         AS user_units_used
FROM requests r
WHERE r.account_id IN (SELECT id FROM run_accounts);
