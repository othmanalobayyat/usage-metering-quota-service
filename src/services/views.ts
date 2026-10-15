import { toUtcMonth } from '../lib/month.js';
import type { Plan } from './plan-guard.js';

/** API shape of a plan. `predefined` is derived from account_id IS NULL. */
export function planView(plan: Plan) {
  return {
    id: plan.id,
    name: plan.name,
    type: plan.type,
    monthlyLimit: plan.monthlyLimit,
    perRequestLimit: plan.perRequestLimit,
    predefined: plan.accountId === null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

/**
 * Usage for one month against a plan's monthly allowance. `unitsUsed` is null when the month
 * has no usage row yet, which means nothing was consumed (reads never create rows).
 */
export function usageView(month: Date, plan: Plan, unitsUsed: number | null) {
  const consumed = unitsUsed ?? 0;
  return {
    month: toUtcMonth(month).slice(0, 7),
    consumed,
    remaining: Math.max(0, plan.monthlyLimit - consumed),
  };
}
