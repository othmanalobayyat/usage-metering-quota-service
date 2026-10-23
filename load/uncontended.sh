#!/usr/bin/env bash
# Uncontended single-request costs, saved to load/results/uncontended-<run_id>.txt:
#   1. API side: load/uncontended-api.mjs inside the API container (pg round trip, endpoint latencies).
#   2. DB side: each consume transaction statement timed by psql (\timing), 20 measured iterations inside
#      BEGIN … ROLLBACK, with literal values instead of the API's bind parameters, so an approximation.
#   3. WAL flush cost: pg_test_fsync on the data volume (COMMIT can't be timed in step 2 without writing rows).
# Usage: load/uncontended.sh   Requires: bash, Docker with Compose v2, od.
set -euo pipefail

cd "$(dirname "$0")/.."

run_id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
out="load/results/uncontended-$run_id.txt"
mkdir -p load/results
exec > >(tee "$out") 2>&1

psql_db=(docker compose exec -T -e PGAPPNAME=load-checker db psql -U quota -d quota -X -v ON_ERROR_STOP=1)
probe=/var/lib/postgresql/data/load_fsync_probe
trap 'docker compose exec -T db rm -f "$probe" || true' EXIT

docker compose --progress quiet up -d --wait db api
echo "run_id $run_id  started_utc $(date -u +%Y-%m-%dT%H:%M:%SZ)  host_cpus $(nproc)"
echo
echo "== 1. API side (from inside the API container) =="
docker compose exec -T -e RUN_ID="$run_id" api node --input-type=module <load/uncontended-api.mjs

read -r account_id account_plan_id user_id user_plan_id < <("${psql_db[@]}" -At -F ' ' -c "
  SELECT a.id, a.plan_id, u.id, u.plan_id FROM accounts a JOIN users u ON u.account_id = a.id
  WHERE a.name = 'load-uncontended-$run_id-0'")

echo
echo "== 2. DB side: consume transaction statements in psql (mean / p50 of 20 iterations, ms) =="
month="date_trunc('month', now() AT TIME ZONE 'UTC')::date"
{
  echo '\timing on'
  for i in $(seq 0 20); do
    # Iteration 0 is a warm-up and is not counted.
    cat <<SQL
\echo @$i begin
BEGIN;
\echo @$i upsert_account_usage
INSERT INTO account_usage (account_id, month, units_used, updated_at) VALUES ('$account_id', $month, 0, now()) ON CONFLICT DO NOTHING;
\echo @$i upsert_user_usage
INSERT INTO user_usage (user_id, account_id, month, units_used, updated_at) VALUES ('$user_id', '$account_id', $month, 0, now()) ON CONFLICT DO NOTHING;
\echo @$i lock_account_usage
SELECT units_used FROM account_usage WHERE account_id = '$account_id' AND month = $month FOR UPDATE;
\echo @$i lock_user_usage
SELECT units_used FROM user_usage WHERE account_id = '$account_id' AND user_id = '$user_id' AND month = $month FOR UPDATE;
\echo @$i recheck_request
SELECT * FROM requests WHERE account_id = '$account_id' AND request_id = 'probe-$i';
\echo @$i plan_join
SELECT ap.*, up.* FROM accounts a JOIN plans ap ON ap.id = a.plan_id JOIN users u ON u.account_id = a.id AND u.id = '$user_id' JOIN plans up ON up.id = u.plan_id WHERE a.id = '$account_id';
\echo @$i plan_join_planning_only
EXPLAIN (SUMMARY ON) SELECT ap.*, up.* FROM accounts a JOIN plans ap ON ap.id = a.plan_id JOIN users u ON u.account_id = a.id AND u.id = '$user_id' JOIN plans up ON up.id = u.plan_id WHERE a.id = '$account_id';
\echo @$i increment_account_usage
UPDATE account_usage SET units_used = units_used + 1, updated_at = now() WHERE account_id = '$account_id' AND month = $month;
\echo @$i increment_user_usage
UPDATE user_usage SET units_used = units_used + 1, updated_at = now() WHERE account_id = '$account_id' AND user_id = '$user_id' AND month = $month;
\echo @$i insert_request
INSERT INTO requests (account_id, user_id, request_id, units, month, status, account_plan_id, user_plan_id, remaining_account, remaining_user, created_at)
  VALUES ('$account_id', '$user_id', 'probe-$i', 1, $month, 'ACCEPTED', '$account_plan_id', '$user_plan_id', 0, 0, now()) RETURNING id;
\echo @$i rollback
ROLLBACK;
SQL
  done
} | "${psql_db[@]}" -q 2>&1 | awk '
  /^@/ { iter = substr($1, 2) + 0; label = $2; next }
  /^Time:/ && iter > 0 { v[label] = v[label] " " $2; s[label] += $2; n[label]++; next }
  /Planning Time:/ && iter > 0 && label == "plan_join_planning_only" { p = p " " $(NF-1); ps += $(NF-1); pn++ }
  function median(list,   a, k, i, j, t) { k = split(list, a, " "); for (i = 1; i <= k; i++) for (j = i + 1; j <= k; j++) if (a[j] < a[i]) { t = a[i]; a[i] = a[j]; a[j] = t }; return a[int((k + 1) / 2)] }
  END {
    split("begin upsert_account_usage upsert_user_usage lock_account_usage lock_user_usage recheck_request plan_join increment_account_usage increment_user_usage insert_request rollback", order, " ")
    for (o = 1; o in order; o++) { k = order[o]; if (n[k]) { printf "%-26s mean %6.3f  p50 %6.3f  (round trip from psql included)\n", k, s[k] / n[k], median(v[k]); sum += s[k] / n[k] } }
    printf "%-26s mean %6.3f  (sum of the means above)\n", "all statements", sum
    if (pn) printf "%-26s mean %6.3f  p50 %6.3f  (server-side planning of plan_join, EXPLAIN SUMMARY)\n", "plan_join planning", ps / pn, median(p)
  }'

echo
echo "== 3. WAL flush cost (pg_test_fsync on the data volume; wal_sync_method: $("${psql_db[@]}" -Atc 'SHOW wal_sync_method')) =="
docker compose exec -T db pg_test_fsync -s 1 -f "$probe"
