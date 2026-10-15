import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { accounts, accountUsage, plans } from '../db/schema.js';
import { DEFAULT_ACCOUNT_PLAN_ID } from '../db/seed.js';
import { notFound } from '../errors/app-error.js';
import { generateApiKey, hashApiKey } from '../lib/api-key.js';
import { toUtcMonth } from '../lib/month.js';
import type { ServiceDeps } from './deps.js';
import { resolveAssignablePlan } from './plan-guard.js';
import { planView, usageView } from './views.js';

export interface CreateAccountInput {
  name: string;
}

/**
 * Creates an account on Starter and returns its plaintext API key. The key is never stored
 * (only its SHA-256), so this is the only time it can be shown.
 */
export async function createAccount({ db, now }: ServiceDeps, input: CreateAccountInput) {
  // Always the fixed predefined Starter plan, so there is nothing for the plan guard to check.
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, DEFAULT_ACCOUNT_PLAN_ID), isNull(plans.accountId)));
  if (!plan) throw new Error('Default account plan is missing; has the seed run?');
  const apiKey = generateApiKey();
  const createdAt = now();
  const id = randomUUID();
  await db.insert(accounts).values({ id, name: input.name, apiKeyHash: hashApiKey(apiKey), planId: plan.id, createdAt });
  return {
    id,
    name: input.name,
    apiKey,
    plan: planView(plan),
    usage: usageView(createdAt, plan, null),
    createdAt,
  };
}

/** Account, its current plan, and this month's usage. Reading never creates a usage row. */
export async function getAccount({ db, now }: ServiceDeps, accountId: string) {
  const at = now();
  const [row] = await db
    .select({ account: accounts, plan: plans, unitsUsed: accountUsage.unitsUsed })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .leftJoin(
      accountUsage,
      and(eq(accountUsage.accountId, accounts.id), eq(accountUsage.month, toUtcMonth(at))),
    )
    .where(eq(accounts.id, accountId));
  if (!row) throw notFound('Account');
  return {
    id: row.account.id,
    name: row.account.name,
    plan: planView(row.plan),
    usage: usageView(at, row.plan, row.unitsUsed),
    createdAt: row.account.createdAt,
  };
}

/** Switches the account's plan. Usage is untouched: it belongs to the account, not the plan. */
export async function setAccountPlan(deps: ServiceDeps, accountId: string, planId: string) {
  const plan = await resolveAssignablePlan(deps.db, accountId, planId, 'ACCOUNT');
  await deps.db.update(accounts).set({ planId: plan.id }).where(eq(accounts.id, accountId));
  return getAccount(deps, accountId);
}
