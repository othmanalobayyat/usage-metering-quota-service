-- One row per sample: how the API's DB connections spend their time. Run under \watch by load/run.sh,
-- with '|' as the field separator.
--   active_cpu    running a statement, not waiting on a lock
--   lock_wait     running a statement but blocked on a lock
--   idle_in_tx    inside a transaction, waiting for the API to send the next statement
--   idle          checked into the pool (or open but unused)
-- lock_events and waiting_queries list the distinct wait events and full query texts (whitespace
-- collapsed) of the lock waiters, so a FOR UPDATE is visible in the sample.
SELECT to_char(clock_timestamp(), 'HH24:MI:SS.MS') AS ts,
       COUNT(*) AS conns,
       COUNT(*) FILTER (WHERE state = 'active' AND wait_event_type IS DISTINCT FROM 'Lock') AS active_cpu,
       COUNT(*) FILTER (WHERE state = 'active' AND wait_event_type = 'Lock') AS lock_wait,
       COUNT(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_tx,
       COUNT(*) FILTER (WHERE state = 'idle') AS idle,
       COALESCE(string_agg(DISTINCT wait_event, '+' ORDER BY wait_event) FILTER (WHERE wait_event_type = 'Lock'), '-') AS lock_events,
       COALESCE(string_agg(DISTINCT regexp_replace(query, '\s+', ' ', 'g'), ' ;; ' ORDER BY regexp_replace(query, '\s+', ' ', 'g'))
                FILTER (WHERE wait_event_type = 'Lock'), '-') AS waiting_queries
FROM pg_stat_activity
WHERE datname = current_database() AND backend_type = 'client backend'
  AND pid <> pg_backend_pid() AND application_name NOT LIKE 'load-%';
