// Shared helpers for the k6 scenarios. Setup goes through the public API only:
// POST /accounts → POST /plans (ACCOUNT + USER) → PUT /account/plan → POST /users.
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://api:3000';
// Random hex, unique per run. Accounts are named load-<scenario>-<RUN_ID>-<n>, and load/check-invariants.sql
// finds a run's accounts by that exact third field, so the ID must not contain '-'.
export const RUN_ID = __ENV.RUN_ID || Math.random().toString(16).slice(2, 10);
if (!/^[0-9a-z]+$/.test(RUN_ID)) throw new Error(`RUN_ID must be [0-9a-z]+, got "${RUN_ID}"`);

// Run length for every scenario. Setup and teardown come on top of it, and the whole run stays under 60s.
export const DURATION = __ENV.DURATION || '30s';
export const VUS = Number(__ENV.VUS || 50);

// Allowances far above anything a 30s run can consume, so the accepted path is what gets measured.
const ACCOUNT_PLAN = { monthlyLimit: 2_000_000_000, perRequestLimit: 1_000 };
const USER_PLAN = { monthlyLimit: 2_000_000_000, perRequestLimit: 1_000 };

// http.batch sends at most this many requests in parallel during setup.
const SETUP_BATCH = 50;

export const accepted = new Counter('consume_accepted');
export const rejected = new Counter('consume_rejected');
export const replayed = new Counter('consume_replayed');
export const fresh = new Counter('consume_fresh');
export const errors = new Counter('consume_errors');
export const errorRate = new Rate('consume_error_rate');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** k6 options shared by every scenario: one closed-loop scenario, consume metrics in the summary. */
export function options(scenario) {
  return {
    setupTimeout: '30s',
    scenarios: {
      [scenario]: { executor: 'constant-vus', vus: VUS, duration: DURATION, gracefulStop: '5s' },
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
    // Thresholds on the tagged submetrics make k6 report them; none of them fails the run on purpose,
    // because this is a baseline, not a gate.
    thresholds: {
      'http_req_duration{name:consume}': ['max>=0'],
      'http_reqs{name:consume}': ['count>=0'],
    },
  };
}

function check2xx(res, what) {
  if (res.status < 200 || res.status > 299) {
    throw new Error(`setup: ${what} failed with ${res.status}: ${res.body}`);
  }
  return res.json();
}

function batched(requests, what) {
  const out = [];
  for (let i = 0; i < requests.length; i += SETUP_BATCH) {
    for (const res of http.batch(requests.slice(i, i + SETUP_BATCH))) out.push(check2xx(res, what));
  }
  return out;
}

function post(path, body, apiKey, tag) {
  const headers = apiKey ? { ...JSON_HEADERS, 'X-API-Key': apiKey } : JSON_HEADERS;
  return ['POST', `${BASE_URL}${path}`, JSON.stringify(body), { headers, tags: { name: tag } }];
}

/**
 * Creates `accountCount` accounts, each on its own large custom ACCOUNT plan with `usersPerAccount`
 * users on a large custom USER plan. Returns [{ apiKey, users: [externalUserId] }].
 */
export function createAccounts(scenario, accountCount, usersPerAccount) {
  const names = Array.from({ length: accountCount }, (_, i) => `load-${scenario}-${RUN_ID}-${i}`);
  const created = batched(names.map((name) => post('/accounts', { name }, null, 'setup')), 'POST /accounts');
  const keys = created.map((a) => a.apiKey);

  const accountPlans = batched(
    keys.map((key) => post('/plans', { name: 'load-account', type: 'ACCOUNT', ...ACCOUNT_PLAN }, key, 'setup')),
    'POST /plans (ACCOUNT)',
  );
  const userPlans = batched(
    keys.map((key) => post('/plans', { name: 'load-user', type: 'USER', ...USER_PLAN }, key, 'setup')),
    'POST /plans (USER)',
  );
  batched(
    keys.map((key, i) => [
      'PUT',
      `${BASE_URL}/account/plan`,
      JSON.stringify({ planId: accountPlans[i].id }),
      { headers: { ...JSON_HEADERS, 'X-API-Key': key }, tags: { name: 'setup' } },
    ]),
    'PUT /account/plan',
  );

  const userRequests = [];
  keys.forEach((key, i) => {
    for (let u = 0; u < usersPerAccount; u++) {
      userRequests.push(post('/users', { externalUserId: `u${u}`, planId: userPlans[i].id }, key, 'setup'));
    }
  });
  batched(userRequests, 'POST /users');

  return keys.map((apiKey) => ({
    apiKey,
    users: Array.from({ length: usersPerAccount }, (_, u) => `u${u}`),
  }));
}

export function consumeRequest(apiKey, externalUserId, units, requestId) {
  return post('/consume', { externalUserId, units, requestId }, apiKey, 'consume');
}

/** Records one consume response. Only a non-200 is an error; a REJECTED decision is counted apart. */
export function record(res) {
  if (res.status !== 200) {
    errors.add(1);
    errorRate.add(true);
    if (Math.random() < 0.01) console.warn(`consume ${res.status}: ${res.body}`);
    return;
  }
  errorRate.add(false);
  const body = res.json();
  if (body.status === 'ACCEPTED') accepted.add(1);
  else rejected.add(1);
  if (body.replayed) replayed.add(1);
  else fresh.add(1);
}

function metric(data, name, stat) {
  const m = data.metrics[name];
  return m && m.values[stat] !== undefined ? m.values[stat] : 0;
}

/** Prints one result line plus a machine-readable JSON line that load/run.sh picks up. */
export function summary(scenario) {
  return (data) => {
    const seconds = parseFloat(DURATION);
    const total = metric(data, 'http_reqs{name:consume}', 'count');
    const result = {
      scenario,
      runId: RUN_ID,
      vus: VUS,
      durationSeconds: seconds,
      requests: total,
      rps: Math.round((total / seconds) * 10) / 10,
      p50: metric(data, 'http_req_duration{name:consume}', 'med'),
      p95: metric(data, 'http_req_duration{name:consume}', 'p(95)'),
      p99: metric(data, 'http_req_duration{name:consume}', 'p(99)'),
      max: metric(data, 'http_req_duration{name:consume}', 'max'),
      errors: metric(data, 'consume_errors', 'count'),
      errorRate: metric(data, 'consume_error_rate', 'rate'),
      accepted: metric(data, 'consume_accepted', 'count'),
      rejected: metric(data, 'consume_rejected', 'count'),
      replayed: metric(data, 'consume_replayed', 'count'),
      fresh: metric(data, 'consume_fresh', 'count'),
    };
    const ms = (v) => `${v.toFixed(1)}ms`;
    const text =
      `\n${scenario}: ${result.requests} consumes in ${seconds}s with ${VUS} VUs → ${result.rps} req/s\n` +
      `  latency p50 ${ms(result.p50)}  p95 ${ms(result.p95)}  p99 ${ms(result.p99)}  max ${ms(result.max)}\n` +
      `  errors (non-200) ${result.errors} (${(result.errorRate * 100).toFixed(2)}%)  ` +
      `accepted ${result.accepted}  rejected ${result.rejected}  fresh ${result.fresh}  replayed ${result.replayed}\n` +
      `SUMMARY_JSON ${JSON.stringify(result)}\n`;
    return { stdout: text };
  };
}
