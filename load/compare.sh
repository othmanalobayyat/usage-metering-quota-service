#!/usr/bin/env bash
# Baseline vs improved, back to back on the same host: WORKERS=1 and WORKERS=4 alternate
# (1, 4, 1, 4, …) so drift in host load hits both sides alike. Each run is an ordinary
# load/run.sh run with its usual load/results/<scenario>-<run_id>-* files.
#   ROUNDS rounds of: many-accounts W1, W4, then hot-account W1, W4 (50 VUs, 30s)
#   then once: hot-account at 200 VUs for 20s, W1 then W4 (the stress probe)
# The session index (order, scenario, workers, VUs, run ID, key k6 numbers) goes to
# load/results/compare-<session>.txt, and the medians per scenario and WORKERS at the end.
#
# Usage:    [ROUNDS=3] load/compare.sh
# Requires: what load/run.sh requires.
set -euo pipefail

cd "$(dirname "$0")/.."

rounds="${ROUNDS:-3}"
session="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
index="load/results/compare-$session.txt"
mkdir -p load/results

printf '%s\n' "session $session  started_utc $(date -u +%Y-%m-%dT%H:%M:%SZ)  rounds $rounds" >"$index"
printf '%s\n' "order scenario workers vus run_id requests rps p50 p95 p99 errors fresh sql_rows" >>"$index"

n=0
one() { # scenario workers [vus duration]
  local scenario="$1" workers="$2" vus="${3:-}" duration="${4:-}" log run_id summary rows
  n=$((n + 1))
  log="$(mktemp)"
  WORKERS="$workers" VUS="$vus" DURATION="$duration" load/run.sh "$scenario" >"$log" 2>&1 || {
    cat "$log" >&2; rm -f "$log"; echo "load/run.sh failed (order $n)" >&2; exit 1; }
  run_id="$(awk '$1 == "run_id" { print $2; exit }' "$log")"
  rm -f "$log"
  summary="$(sed -n 's/^SUMMARY_JSON //p' "load/results/$scenario-$run_id-k6.txt")"
  rows="$(sed -n 's/^k6 fresh=[0-9]*  request rows=\([0-9]*\).*/\1/p' "load/results/$scenario-$run_id-run.txt")"
  jq -r --arg n "$n" --arg s "$scenario" --arg w "$workers" --arg rows "$rows" \
    '[$n, $s, $w, .vus, .runId, .requests, .rps, (.p50*10|round/10), (.p95*10|round/10), (.p99*10|round/10), .errors, .fresh, $rows] | join(" ")' \
    <<<"$summary" | tee -a "$index"
}

for ((r = 1; r <= rounds; r++)); do
  one many-accounts 1
  one many-accounts 4
  one hot-account 1
  one hot-account 4
done
one hot-account 1 200 20s
one hot-account 4 200 20s

{
  echo
  echo "medians (50-VU runs) per scenario and WORKERS:"
  echo "scenario workers runs requests rps p50 p95 p99"
  awk 'NR > 2 && $4 == 50 { k = $2 " W" $3; for (i = 6; i <= 10; i++) v[k, i, ++c[k, i]] = $i; keys[k] = 1 }
       function med(k, i,   m, j, t, a) { m = c[k, i]; for (j = 1; j <= m; j++) a[j] = v[k, i, j]
         for (j = 1; j <= m; j++) for (t = j + 1; t <= m; t++) if (a[t] < a[j]) { x = a[j]; a[j] = a[t]; a[t] = x }
         return (m % 2) ? a[(m + 1) / 2] : (a[m / 2] + a[m / 2 + 1]) / 2 }
       END { for (k in keys) printf "%s %d %s %s %s %s %s\n", k, c[k, 6], med(k, 6), med(k, 7), med(k, 8), med(k, 9), med(k, 10) }' "$index" | sort
  echo "finished_utc $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee -a "$index"
