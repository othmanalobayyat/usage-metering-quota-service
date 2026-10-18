// Load spread over many accounts: consumes rarely contend for the same account_usage row.
import http from 'k6/http';
import { consumeRequest, createAccounts, options as baseOptions, record, RUN_ID, summary } from './lib.js';

const SCENARIO = 'many_accounts';
const ACCOUNTS = Number(__ENV.ACCOUNTS || 100);
const USERS = Number(__ENV.USERS || 5);

export const options = baseOptions(SCENARIO);

export function setup() {
  return { accounts: createAccounts(SCENARIO, ACCOUNTS, USERS) };
}

export default function ({ accounts }) {
  const account = accounts[Math.floor(Math.random() * accounts.length)];
  const user = account.users[Math.floor(Math.random() * account.users.length)];
  const units = 1 + Math.floor(Math.random() * 5);
  const requestId = `${RUN_ID}-${__VU}-${__ITER}`;
  record(http.request(...consumeRequest(account.apiKey, user, units, requestId)));
}

export const handleSummary = summary(SCENARIO);
