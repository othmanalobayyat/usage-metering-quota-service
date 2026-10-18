import { randomUUID } from 'node:crypto';
import { ApiError, type Decision, type Plan, type QuotaApi, type ReasonCode, type RuleOwner } from './quota-api.js';

/**
 * The exact decision Phase 5 expects from a consume, fixed in advance. A step passes only when
 * status, reasonCode, rejectedBy, limit and both remaining values all match.
 */
interface Expected {
  status: 'ACCEPTED' | 'REJECTED';
  reasonCode: ReasonCode | null;
  rejectedBy: RuleOwner | null;
  limit: number | null;
  remaining: { account: number; user: number };
}

export interface DemoStep {
  step: string;
  action: string;
  /** Present on consume steps only. */
  units?: number;
  decision?: Decision;
  expected: string;
  ok: boolean;
  note?: string;
}

export interface DemoRun {
  account: { id: string; name: string } | null;
  steps: DemoStep[];
  ok: boolean;
  error: string | null;
}

const CUSTOM_PLAN = { name: 'Demo 200', type: 'ACCOUNT', monthlyLimit: 200, perRequestLimit: 50 } as const;

const accepted = (account: number, user: number): Expected => ({
  status: 'ACCEPTED',
  reasonCode: null,
  rejectedBy: null,
  limit: null,
  remaining: { account, user },
});

const rejected = (rejectedBy: RuleOwner, reasonCode: ReasonCode, limit: number, account: number, user: number): Expected => ({
  status: 'REJECTED',
  reasonCode,
  rejectedBy,
  limit,
  remaining: { account, user },
});

/** Bob's fixed chunks: fills the account's last 165 units exactly, then one more 50 goes over. */
const BOB_STEPS: { units: number; expected: Expected }[] = [
  { units: 50, expected: accepted(115, 4950) },
  { units: 50, expected: accepted(65, 4900) },
  { units: 50, expected: accepted(15, 4850) },
  { units: 15, expected: accepted(0, 4835) },
  { units: 50, expected: rejected('ACCOUNT', 'MONTHLY_LIMIT_EXCEEDED', 200, 0, 4835) },
];

function describe(e: Expected): string {
  const rule = e.status === 'REJECTED' ? ` · ${e.rejectedBy} · ${e.reasonCode} · limit ${e.limit}` : '';
  return `${e.status}${rule} · remaining ${e.remaining.account} account, ${e.remaining.user} user`;
}

function matches(d: Decision, e: Expected): boolean {
  return (
    d.status === e.status &&
    d.reasonCode === e.reasonCode &&
    d.rejectedBy === e.rejectedBy &&
    d.limit === e.limit &&
    d.remaining.account === e.remaining.account &&
    d.remaining.user === e.remaining.user
  );
}

function byName(plans: Plan[], name: string): Plan {
  const plan = plans.find((p) => p.predefined && p.name === name);
  if (!plan) throw new Error(`Predefined plan "${name}" not found`);
  return plan;
}

/**
 * Runs the Phase 5 demo end to end on a fresh account and returns every step. An API failure
 * stops the run; the steps so far are still returned with the error.
 */
export async function runDemo(api: QuotaApi): Promise<DemoRun> {
  const run: DemoRun = { account: null, steps: [], ok: false, error: null };
  const setup = (action: string, expected: string, ok: boolean) => run.steps.push({ step: 'Setup', action, expected, ok });

  try {
    const account = await api.createAccount(`Demo ${new Date().toISOString()}`);
    run.account = { id: account.id, name: account.name };
    setup(`Create account "${account.name}" (starts on ${account.plan.name})`, 'Starts on Starter', account.plan.name === 'Starter');
    const client = api.withKey(account.apiKey);

    const plan = await client.createPlan(CUSTOM_PLAN);
    setup(
      `Create custom account plan "${plan.name}" (${plan.monthlyLimit}/month · ${plan.perRequestLimit}/request)`,
      '200/month · 50/request',
      plan.monthlyLimit === 200 && plan.perRequestLimit === 50,
    );
    const assigned = await client.setAccountPlan(plan.id);
    setup(`Assign "${plan.name}" to the account`, `Account on "${plan.name}"`, assigned.plan.id === plan.id);

    const userPlans = await client.listPlans('USER');
    const basic = byName(userPlans, 'Basic');
    const premium = byName(userPlans, 'Premium');
    const alice = await client.registerUser({ externalUserId: 'alice', name: 'Alice', planId: basic.id });
    setup(`Register Alice on ${alice.plan.name} (${alice.plan.perRequestLimit}/request)`, 'On Basic', alice.plan.id === basic.id);
    const bob = await client.registerUser({ externalUserId: 'bob', name: 'Bob', planId: premium.id });
    setup(`Register Bob on ${bob.plan.name} (${bob.plan.perRequestLimit}/request)`, 'On Premium', bob.plan.id === premium.id);

    // The one consume call the whole demo uses. Steps 2 and 4 send the same body through it;
    // only Alice's plan differs between them. Each request gets a fresh requestId.
    const consume = async (step: string, externalUserId: string, units: number, expected: Expected, note?: string) => {
      const decision = await client.consume({ externalUserId, units, requestId: `demo-${randomUUID()}` });
      const ok = matches(decision, expected);
      run.steps.push({ step, action: `${externalUserId} consumes ${units}`, units, decision, expected: describe(expected), ok, note });
    };

    await consume('1', 'alice', 10, accepted(190, 990));
    await consume('2', 'alice', 25, rejected('USER', 'PER_REQUEST_LIMIT_EXCEEDED', 20, 190, 990));

    const switched = await client.setUserPlan('alice', premium.id);
    run.steps.push({
      step: '3',
      action: `Switch Alice to ${switched.plan.name} (${switched.plan.perRequestLimit}/request)`,
      expected: 'On Premium',
      ok: switched.plan.id === premium.id,
    });

    await consume(
      '4',
      'alice',
      25,
      accepted(165, 4965),
      `Same call as step 2. Only Alice's plan changed: per-request ${basic.perRequestLimit} → ${premium.perRequestLimit}.`,
    );

    for (const [i, { units, expected }] of BOB_STEPS.entries()) {
      await consume(`5.${i + 1}`, 'bob', units, expected);
    }

    run.ok = run.steps.every((s) => s.ok);
  } catch (err) {
    run.error = err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err);
  }
  return run;
}
