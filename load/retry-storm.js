// Retry storm on one account: requestIds come from a fixed pool, and each iteration sends the same
// request BURST times at once, as a client with an aggressive retry/timeout policy would. The first
// arrival decides; concurrent copies replay from the post-lock recheck, later ones from the fast path.
// Each key always maps to the same user and units, so a correct service never answers 409.
import http from 'k6/http';
import { consumeRequest, createAccounts, options as baseOptions, record, summary } from './lib.js';

const SCENARIO = 'retry_storm';
const USERS = Number(__ENV.USERS || 50);
const KEYS = Number(__ENV.KEYS || 5000);
const BURST = Number(__ENV.BURST || 3);

export const options = baseOptions(SCENARIO);

export function setup() {
  const [account] = createAccounts(SCENARIO, 1, USERS);
  return account;
}

export default function (account) {
  const key = Math.floor(Math.random() * KEYS);
  const request = consumeRequest(account.apiKey, account.users[key % USERS], 1 + (key % 5), `storm-${key}`);
  for (const res of http.batch(Array.from({ length: BURST }, () => request))) record(res);
}

export const handleSummary = summary(SCENARIO);
