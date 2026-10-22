// Accepted and rejected decisions mixed on ONE account (the hot row), with a request mix that is the
// same for every build and every second of the run, so throughput can be compared between builds.
//   - 200 users. 40 of them have their monthly allowance (5 units) used up during setup; the other 160
//     have 1,000,000 units, far more than a 30s run can consume. Both plans allow 10 units per request.
//   - Each request's user and units come from a generator seeded by (VU, iteration): every build sends
//     the same sequence of requests, and its outcome depends only on the request, not on how fast the
//     quotas were drained. units 11–15 (1/3): USER per-request rejection. Otherwise an exhausted user
//     (2/3 × 1/5 = 13.3%): USER monthly rejection. Otherwise (53.3%): accepted.
// An earlier version gave every user 100 units, so a faster build used them up sooner and got more of
// the cheaper rejections (docs/LOAD_TEST.md §11); its runs are not comparable between builds.
import http from 'k6/http';
import { BASE_URL, consumeRequest, createAccounts, options as baseOptions, record, RUN_ID, summary } from './lib.js';

const SCENARIO = 'mixed';
const USERS = 200;
const EXHAUSTED = 40;
const EXHAUSTED_PLAN = { monthlyLimit: 5, perRequestLimit: 10 };

export const options = baseOptions(SCENARIO);

/** mulberry32: a small deterministic PRNG, so a (VU, iteration) pair always yields the same request. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setupCall(method, path, body, apiKey) {
  const res = http.request(method, `${BASE_URL}${path}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    tags: { name: 'setup' },
  });
  if (res.status < 200 || res.status > 299) throw new Error(`setup: ${method} ${path} failed with ${res.status}: ${res.body}`);
  return res.json();
}

export function setup() {
  const [account] = createAccounts(SCENARIO, 1, USERS, { userPlan: { monthlyLimit: 1_000_000, perRequestLimit: 10 } });
  const plan = setupCall('POST', '/plans', { name: 'load-exhausted', type: 'USER', ...EXHAUSTED_PLAN }, account.apiKey);
  for (let u = 0; u < EXHAUSTED; u++) {
    setupCall('PUT', `/users/u${u}/plan`, { planId: plan.id }, account.apiKey);
    const spent = setupCall('POST', '/consume', { externalUserId: `u${u}`, units: 5, requestId: `${RUN_ID}-setup-${u}` }, account.apiKey);
    if (spent.status !== 'ACCEPTED') throw new Error(`setup: could not use up u${u}'s allowance`);
  }
  return account;
}

export default function (account) {
  const next = generator(__VU * 1_000_003 + __ITER);
  const user = account.users[Math.floor(next() * account.users.length)];
  const units = 1 + Math.floor(next() * 15);
  const requestId = `${RUN_ID}-${__VU}-${__ITER}`;
  record(http.request(...consumeRequest(account.apiKey, user, units, requestId)));
}

export const handleSummary = summary(SCENARIO);
