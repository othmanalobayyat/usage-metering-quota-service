#!/usr/bin/env bash
# Runs one k6 scenario against the Compose stack and saves the evidence for docs/LOAD_TEST.md in
# load/results/<scenario>-<run_id>-*:
#   env.txt     host, versions, Postgres settings, k6 parameters
#   k6.txt      k6 result (the SUMMARY_JSON line is machine-readable)
#   pg.txt      pg_stat_activity samples every 0.5s (load/sample-activity.sql), '|'-separated
#   cpu.txt     container CPU from docker stats (~2s per sample)
#   idx.txt     index scan counters before/after the run (load/index-scans.sql)
#   sql.txt     load/check-invariants.sql output
#   api.log     API container log lines written during the run
#   run.txt     everything this script printed, including the summaries below
#
# Usage:    [WORKERS=1] [VUS=50] [DURATION=30s] load/run.sh hot-account|many-accounts|retry-storm
# Requires: bash, Docker with Compose v2, jq (parses k6's SUMMARY_JSON line), od.
# Assumes nothing else uses the API or DB during the run: the index scan deltas count all traffic.
set -euo pipefail

cd "$(dirname "$0")/.."

usage="usage: [WORKERS=n] [VUS=n] [DURATION=30s] load/run.sh hot-account|many-accounts|retry-storm"
scenario="${1:?$usage}"
[[ -f "load/$scenario.js" ]] || { echo "unknown scenario: $scenario ($usage)" >&2; exit 2; }
command -v jq >/dev/null || { echo "load/run.sh needs jq to parse k6's summary line" >&2; exit 2; }

# Random hex, no '-': accounts are named load-<scenario>-<run_id>-<n> and matched on that exact field.
run_id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
out="load/results/$scenario-$run_id"
mkdir -p load/results
exec > >(tee "$out-run.txt") 2>&1

psql_db=(docker compose exec -T -e PGAPPNAME=load-checker db psql -U quota -d quota -X -v ON_ERROR_STOP=1)

sampler=""
stats=""
cleanup() {
  if [[ -n "$stats" ]]; then
    kill "$stats" 2>/dev/null || true
    wait "$stats" 2>/dev/null || true
    stats=""
  fi
  if [[ -n "$sampler" ]]; then
    "${psql_db[@]}" -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'load-sampler'" >/dev/null || true
    wait "$sampler" 2>/dev/null || true
    sampler=""
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

docker compose --progress quiet up -d --wait db api
api_ctr="$(docker compose ps --format '{{.Name}}' api)"
db_ctr="$(docker compose ps --format '{{.Name}}' db)"
[[ -n "$api_ctr" && -n "$db_ctr" ]] || { echo "could not find the api/db containers through docker compose ps" >&2; exit 1; }

{
  echo "run_id $run_id"
  echo "scenario $scenario"
  echo "vus ${VUS:-50 (default)}"
  echo "duration ${DURATION:-30s (default)}"
  echo "started_utc $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host_cpus $(nproc)"
  free -m | awk '/^Mem:/ { print "host_mem_total_mib " $2 } /^Swap:/ { print "host_swap_used_mib " $3 }'
  echo "docker $(docker version --format '{{.Server.Version}}')"
  echo "compose $(docker compose version --short)"
  echo "k6_image $(docker compose --profile load config --format json | jq -r '.services.k6.image')"
  echo "db_image $(docker compose config --format json | jq -r '.services.db.image')"
  echo "api_node $(docker compose exec -T api node --version)"
  echo "api_workers_env $(docker compose exec -T api printenv WORKERS)"
  # Primary + workers in cluster mode, one process with WORKERS=1.
  echo "api_node_processes $(docker compose exec -T api sh -c 'ps -o comm= | grep -c "^node$"')"
  "${psql_db[@]}" -At -F ' ' -c "SELECT 'pg_' || name, current_setting(name) FROM pg_settings
    WHERE name IN ('server_version', 'max_connections', 'shared_buffers', 'synchronous_commit', 'fsync', 'wal_sync_method')
    ORDER BY name"
} >"$out-env.txt"
cat "$out-env.txt"

echo "index scans before:" >"$out-idx.txt"
"${psql_db[@]}" -At -F ' ' -f - <load/index-scans.sql >>"$out-idx.txt"
start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# pg_stat_activity sampler: one session under \watch, ended in cleanup() through pg_terminate_backend.
{ cat load/sample-activity.sql; printf '\\watch 0.5\n'; } |
  docker compose exec -T -e PGAPPNAME=load-sampler db psql -U quota -d quota -X -At -F '|' >"$out-pg.txt" 2>"$out-pg.err" &
sampler=$!
# Container CPU, one sample per docker stats call (~2s each).
( while true; do
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' "$api_ctr" "$db_ctr"
  done ) >"$out-cpu.txt" 2>"$out-cpu.err" &
stats=$!

k6_args=(run -q -e RUN_ID="$run_id")
[[ -n "${VUS:-}" ]] && k6_args+=(-e VUS="$VUS")
[[ -n "${DURATION:-}" ]] && k6_args+=(-e DURATION="$DURATION")
SECONDS=0
# A failing k6 exits the script here (set -e + pipefail); the EXIT trap still stops the samplers.
docker compose --progress quiet --profile load run --rm k6 "${k6_args[@]}" "/scripts/$scenario.js" | tee "$out-k6.txt"
k6_wall=$SECONDS
cleanup

# psql reports its own termination on stderr; anything else there means sampling went wrong.
if grep -v -e 'terminating connection due to administrator command' -e 'server closed the connection unexpectedly' \
     -e 'This probably means the server terminated abnormally' -e 'before or while processing the request' \
     -e 'connection to server was lost' "$out-pg.err" | grep -q .; then
  echo "WARNING: the pg_stat_activity sampler reported errors ($out-pg.err):" >&2
  cat "$out-pg.err" >&2
fi
if [[ -s "$out-cpu.err" ]]; then
  echo "WARNING: docker stats reported errors ($out-cpu.err):" >&2
  cat "$out-cpu.err" >&2
fi
[[ -s "$out-pg.txt" ]] || { echo "no pg_stat_activity samples were captured" >&2; exit 1; }
[[ -s "$out-cpu.txt" ]] || { echo "no docker stats samples were captured" >&2; exit 1; }

# Idle backends flush their statistics within 10s (PGSTAT_IDLE_INTERVAL), so wait before the second snapshot.
# It is taken before the invariant queries, which would add scans of their own.
sleep 11
echo "index scans after:" >>"$out-idx.txt"
"${psql_db[@]}" -At -F ' ' -f - <load/index-scans.sql >>"$out-idx.txt"

echo
echo "k6 wall time (container start, setup, run, teardown): ${k6_wall}s"

echo
echo "== SQL invariants =="
"${psql_db[@]}" -v run_id="$run_id" -f - <load/check-invariants.sql | tee "$out-sql.txt"

echo "== DB connections while k6 ran (pg_stat_activity, 0.5s samples with API traffic) =="
awk -F'|' '($3 + $4 + $5) > 0 { n++; c += $2; a += $3; l += $4; t += $5; i += $6; if ($4 > 0) w++
       if ($4 > maxl) maxl = $4 }
     END { if (n) printf "busy samples %d (with a lock waiter: %d)  avg conns %.2f  active(cpu) %.2f  lock_wait %.2f (max %d)  idle_in_tx %.2f  idle %.2f\n",
                         n, w, c/n, a/n, l/n, maxl, t/n, i/n; else print "no busy samples" }' "$out-pg.txt"
echo "lock waits by sample (samples · wait events · waiting queries):"
awk -F'|' '$7 != "-" { print $7 " · " $8 }' "$out-pg.txt" | sort | uniq -c | sort -rn

echo "== Container CPU (100% = one core) =="
awk -v api="$api_ctr" -v db="$db_ctr" '{ name = ($1 == api) ? "api" : ($1 == db) ? "db" : $1
       gsub("%", "", $2); v = $2 + 0; n[name]++; s[name] += v; if (v > m[name]) m[name] = v }
     END { for (k in n) printf "%s avg %.0f%% max %.0f%% (%d samples)\n", k, s[k]/n[k], m[k], n[k] }' "$out-cpu.txt" | sort

echo "== API log during the run =="
docker compose logs --no-log-prefix --since "$start" api >"$out-api.log"
echo "log lines: $(wc -l <"$out-api.log")  unhandled errors: $(grep -c 'unhandled error' "$out-api.log" || true)  service unavailable (overload): $(grep -c 'service unavailable (overload)' "$out-api.log" || true)"
grep -A1 -e 'unhandled error' -e 'service unavailable (overload)' "$out-api.log" |
  grep -v -e 'unhandled error' -e 'service unavailable (overload)' -e '^--' | sed 's/^ *//' | cut -c1-120 |
  sort | uniq -c | sort -rn | head -5 || true

echo "== Fresh decisions (k6) vs request rows (SQL) =="
summary="$(sed -n 's/^SUMMARY_JSON //p' "$out-k6.txt")"
consumes="$(jq '.requests' <<<"$summary")"
fresh="$(jq '.fresh' <<<"$summary")"
rows="$("${psql_db[@]}" -Atc "SELECT COUNT(*) FROM requests r JOIN accounts a ON a.id = r.account_id
  WHERE a.name LIKE 'load-%' AND split_part(a.name, '-', 3) = '$run_id'")"
echo "k6 fresh=$fresh  request rows=$rows  $([[ "$fresh" == "$rows" ]] && echo OK || echo MISMATCH)"

echo "== Index scans during the run =="
awk '/^index scans before:/ { phase = "b"; next } /^index scans after:/ { phase = "a"; next }
     { if (phase == "b") b[$1] = $2; else d[$1] = $2 - b[$1] }
     END { for (k in d) print k, d[k] }' "$out-idx.txt" | sort | tee "$out-idx-delta.txt"
req_scans="$(awk '$1 == "requests_account_id_request_id_unique" { print $2 }' "$out-idx-delta.txt")"
# One fast-path lookup per consume plus one recheck per consume transaction (see load/index-scans.sql).
tx=$((req_scans - consumes))
echo "consume transactions = request-index scans − consumes = $req_scans − $consumes = $tx"
# A request that failed (e.g. a pool timeout before the fast path) breaks the one-scan-per-consume model.
[[ "$(jq '.errors' <<<"$summary")" == 0 ]] || echo "  NOT VALID for this run: some consumes failed, so not every consume did its fast-path scan"
echo "  fresh decisions $fresh, replays inside a transaction $((tx - fresh)), fast-path replays $((consumes - tx))"

echo
echo "Raw output: $out-*"
