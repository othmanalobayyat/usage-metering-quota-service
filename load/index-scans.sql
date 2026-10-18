-- Cumulative index scan counters used by load/run.sh (snapshot before and after a run, then diffed).
-- requests_account_id_request_id_unique: one scan per consume for the fast-path lookup (step 2) and one
-- per consume transaction for the recheck after the lock (step 6).
SELECT indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE indexrelname IN ('requests_account_id_request_id_unique', 'account_usage_account_id_month_pk', 'user_usage_user_id_month_pk')
ORDER BY 1;
