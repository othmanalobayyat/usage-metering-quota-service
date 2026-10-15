import { and, eq, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { plans } from '../db/schema.js';
import { AppError, notFound } from '../errors/app-error.js';

export type Plan = typeof plans.$inferSelect;
export type PlanType = Plan['type'];

/** Predefined plans plus this account's own: the only plans an account can see. */
export function visibleTo(accountId: string) {
  return or(isNull(plans.accountId), eq(plans.accountId, accountId));
}

/**
 * The shared plan-assignment guard. Every caller-chosen write of accounts.plan_id or
 * users.plan_id (user registration, both plan switches) goes through here.
 *
 * Rule 3 (the plan is predefined or owned by this account) is enforced HERE, not by a
 * foreign key: the FK only proves the plan exists. A code path that writes plan_id without
 * calling this guard could assign another account's plan, or a plan of the wrong type, silently.
 *
 * Checks, in order:
 *   1. The plan exists and is predefined or owned by `accountId` (rule 3), else 404
 *      (another account's plan looks exactly like a missing one).
 *   2. The plan's type matches the target (rules 1 and 2), else 400.
 *
 * No race between this check and the write: a plan's type and owner never change and plans
 * are never deleted.
 */
export async function resolveAssignablePlan(
  db: Db,
  accountId: string,
  planId: string,
  target: PlanType,
): Promise<Plan> {
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), visibleTo(accountId)));
  if (!plan) {
    throw notFound('Plan');
  }
  if (plan.type !== target) {
    throw new AppError('VALIDATION_ERROR', `planId: expected a plan of type ${target}, got ${plan.type}`);
  }
  return plan;
}
