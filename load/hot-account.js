// Many users on ONE account: every consume locks the same account_usage row (the hot row).
import http from 'k6/http';
import { consumeRequest, createAccounts, options as baseOptions, record, RUN_ID, summary } from './lib.js';

const SCENARIO = 'hot_account';
const USERS = Number(__ENV.USERS || 200);

export const options = baseOptions(SCENARIO);

export function setup() {
  const [account] = createAccounts(SCENARIO, 1, USERS);
  return account;
}

export default function (account) {
  const user = account.users[Math.floor(Math.random() * account.users.length)];
  const units = 1 + Math.floor(Math.random() * 5);
  const requestId = `${RUN_ID}-${__VU}-${__ITER}`;
  record(http.request(...consumeRequest(account.apiKey, user, units, requestId)));
}

export const handleSummary = summary(SCENARIO);
