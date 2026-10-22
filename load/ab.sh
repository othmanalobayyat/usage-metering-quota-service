#!/usr/bin/env bash
# A/B comparison of two API builds on the same host, database, settings and workload. The two images
# take turns in ABBA order (A B, then B A, …) for every scenario, so drift in host load and the
# database growing between runs fall on both sides alike. Each run is an ordinary load/run.sh run
# with its usual load/results/<scenario>-<run_id>-* files; only the API container's image changes.
#   1. Warm-up: one short hot-account run per image (10s), recorded but excluded from the medians.
#   2. ROUNDS rounds of every scenario in SCENARIOS, ABBA.
# Before every run the database is ANALYZEd. A new database starts with a tiny requests table and no
# statistics, and until autovacuum catches up the planner reads it with sequential scans: the first
# runs of a session were slower for both images for that reason alone. ANALYZE gives every run, of
# either image, current statistics.
# The session index (order, label, image, scenario, run ID, k6 numbers, invariant violations) goes to
# load/results/ab-<session>.txt, and per scenario and label at the end: RPS min/median/max, the
# median latencies, total errors and violations, and the share of rejected decisions (which must be
# about equal for both images, or the two did different work; see load/mixed.js). "violations" is
# the sum of checks 1-4 and 6 of load/check-invariants.sql right after that run; it must stay 0.
#
# Usage:    A_IMAGE=<image> B_IMAGE=<image> [A_LABEL=A] [B_LABEL=B] [ROUNDS=3]
#           [SCENARIOS="hot-account many-accounts retry-storm mixed"] [AB_API_PORT=3000] load/ab.sh
#           Build the images first, e.g. docker build -t quota-api:a <checkout-a>, likewise for b.
#           Both must contain the same migrations: they share the database.
# Requires: what load/run.sh requires.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${A_IMAGE:?set A_IMAGE and B_IMAGE to the two API images to compare}"
: "${B_IMAGE:?set A_IMAGE and B_IMAGE to the two API images to compare}"
a_label="${A_LABEL:-A}"
b_label="${B_LABEL:-B}"
rounds="${ROUNDS:-3}"
read -r -a scenarios <<<"${SCENARIOS:-hot-account many-accounts retry-storm mixed}"
for image in "$A_IMAGE" "$B_IMAGE"; do
  docker image inspect "$image" >/dev/null || { echo "no such image: $image" >&2; exit 2; }
done
for scenario in "${scenarios[@]}"; do
  [[ -f "load/$scenario.js" ]] || { echo "unknown scenario: $scenario" >&2; exit 2; }
done

export COMPOSE_FILE="docker-compose.yml:load/ab.compose.yml"
session="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
index="load/results/ab-$session.txt"
mkdir -p load/results

{
  echo "session $session  started_utc $(date -u +%Y-%m-%dT%H:%M:%SZ)  rounds $rounds  scenarios ${scenarios[*]}"
  echo "A $a_label $A_IMAGE $(docker image inspect --format '{{.Id}} created {{.Created}}' "$A_IMAGE")"
  echo "B $b_label $B_IMAGE $(docker image inspect --format '{{.Id}} created {{.Created}}' "$B_IMAGE")"
  echo "order phase label scenario vus run_id requests rps p50 p95 p99 errors accepted rejected fresh sql_rows violations"
} >"$index"

n=0
one() { # phase label image scenario [duration]
  local phase="$1" label="$2" image="$3" scenario="$4" duration="${5:-}" log run_id summary rows violations
  n=$((n + 1))
  log="$(mktemp)"
  API_IMAGE="$image" docker compose --progress quiet up -d --wait db >/dev/null
  API_IMAGE="$image" docker compose exec -T db psql -U quota -d quota -X -q -v ON_ERROR_STOP=1 -c 'ANALYZE' >/dev/null
  API_IMAGE="$image" DURATION="$duration" load/run.sh "$scenario" >"$log" 2>&1 || {
    cat "$log" >&2; rm -f "$log"; echo "load/run.sh failed (order $n)" >&2; exit 1; }
  run_id="$(awk '$1 == "run_id" { print $2; exit }' "$log")"
  rm -f "$log"
  summary="$(sed -n 's/^SUMMARY_JSON //p' "load/results/$scenario-$run_id-k6.txt")"
  rows="$(sed -n 's/^k6 fresh=[0-9]*  request rows=\([0-9]*\).*/\1/p' "load/results/$scenario-$run_id-run.txt")"
  # Checks 1-4 print one count each; check 6 prints rows_without_snapshot (not a violation) and three counts.
  violations="$(API_IMAGE="$image" docker compose exec -T db psql -U quota -d quota -X -At -v ON_ERROR_STOP=1 \
      -v run_id="$run_id" -f - <load/check-invariants.sql |
    awk -F'|' '/^[0-9]\. / { check = substr($0, 1, 1); next }
               check ~ /^[1-4]$/ && NF == 1 { sum += $1; check = "" }
               check == "6" && NF == 4 { sum += $2 + $3 + $4; check = "" }
               END { print sum + 0 }')"
  jq -r --arg n "$n" --arg phase "$phase" --arg label "$label" --arg s "$scenario" --arg rows "$rows" --arg v "$violations" \
    '[$n, $phase, $label, $s, .vus, .runId, .requests, .rps, (.p50*10|round/10), (.p95*10|round/10), (.p99*10|round/10),
      .errors, .accepted, .rejected, .fresh, $rows, $v] | join(" ")' <<<"$summary" | tee -a "$index"
}

one warmup "$a_label" "$A_IMAGE" hot-account 10s
one warmup "$b_label" "$B_IMAGE" hot-account 10s
for ((r = 1; r <= rounds; r++)); do
  for scenario in "${scenarios[@]}"; do
    if ((r % 2)); then
      one measure "$a_label" "$A_IMAGE" "$scenario"
      one measure "$b_label" "$B_IMAGE" "$scenario"
    else
      one measure "$b_label" "$B_IMAGE" "$scenario"
      one measure "$a_label" "$A_IMAGE" "$scenario"
    fi
  done
done

{
  echo
  echo "measured runs per scenario and label: RPS min/median/max, median latencies, totals, rejected share:"
  echo "scenario label runs rps_min rps_med rps_max p50 p95 p99 errors violations rejected_pct"
  awk 'NR > 4 && $2 == "measure" { k = $4 " " $3; keys[k] = 1; m = ++c[k]
         for (i = 8; i <= 11; i++) v[k, i, m] = $i; e[k] += $12; viol[k] += $17; acc[k] += $13; rej[k] += $14 }
       function sorted(k, i, a,   m, j, t, x) { m = c[k]; for (j = 1; j <= m; j++) a[j] = v[k, i, j]
         for (j = 1; j <= m; j++) for (t = j + 1; t <= m; t++) if (a[t] < a[j]) { x = a[j]; a[j] = a[t]; a[t] = x }
         return m }
       function med(k, i,   a, m) { m = sorted(k, i, a); return (m % 2) ? a[(m + 1) / 2] : (a[m / 2] + a[m / 2 + 1]) / 2 }
       function lo(k, i,   a) { sorted(k, i, a); return a[1] }
       function hi(k, i,   a, m) { m = sorted(k, i, a); return a[m] }
       END { for (k in keys) printf "%s %d %s %s %s %s %s %s %d %d %.1f\n", k, c[k], lo(k, 8), med(k, 8), hi(k, 8),
               med(k, 9), med(k, 10), med(k, 11), e[k], viol[k], (acc[k] + rej[k]) ? 100 * rej[k] / (acc[k] + rej[k]) : 0 }' "$index" | sort
  echo "finished_utc $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee -a "$index"
