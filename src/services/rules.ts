import type { reasonCode, ruleOwner } from '../db/schema.js';
import type { Plan } from './plan-guard.js';

// Pure quota rules: no database, no clock, no I/O. consume.service.ts loads the plans and
// usage under lock and calls evaluate(); new rules (e.g. a daily cap) go here, not there.

export type PlanLimits = Pick<Plan, 'monthlyLimit' | 'perRequestLimit'>;
export type ReasonCode = (typeof reasonCode.enumValues)[number];
export type RuleOwner = (typeof ruleOwner.enumValues)[number];

export interface EvaluateInput {
  accountPlan: PlanLimits;
  userPlan: PlanLimits;
  /** Units already consumed this month, before this request. */
  accountUsed: number;
  userUsed: number;
  units: number;
}

/** Monthly allowance left after the decision, never negative. */
export interface Remaining {
  account: number;
  user: number;
}

export type Decision =
  | { status: 'ACCEPTED'; reasonCode: null; rejectedBy: null; limit: null; remaining: Remaining }
  | {
      status: 'REJECTED';
      reasonCode: ReasonCode;
      rejectedBy: RuleOwner;
      /** The limit of the rule that blocked the request. */
      limit: number;
      remaining: Remaining;
    };

interface Rule {
  reasonCode: ReasonCode;
  rejectedBy: RuleOwner;
  limit: number;
  passes: boolean;
}

/**
 * Decides one consume request. Checks run in this order and the first failure wins:
 * user per-request → account per-request → user monthly → account monthly.
 * A request that exactly reaches a limit is accepted.
 *
 * `remaining = max(0, allowance - used)`, computed after the decision: an accepted request
 * counts its units, a rejected one consumes nothing. The max(0, …) also covers a plan whose
 * allowance was lowered below what is already used.
 *
 * Precondition: `units` is a positive integer. The caller validates it; evaluate() does not
 * re-check, so 0, negative, or fractional units give meaningless decisions.
 */
export function evaluate({
  accountPlan,
  userPlan,
  accountUsed,
  userUsed,
  units,
}: EvaluateInput): Decision {
  const rules: Rule[] = [
    {
      reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
      rejectedBy: 'USER',
      limit: userPlan.perRequestLimit,
      passes: units <= userPlan.perRequestLimit,
    },
    {
      reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
      rejectedBy: 'ACCOUNT',
      limit: accountPlan.perRequestLimit,
      passes: units <= accountPlan.perRequestLimit,
    },
    {
      reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
      rejectedBy: 'USER',
      limit: userPlan.monthlyLimit,
      passes: userUsed + units <= userPlan.monthlyLimit,
    },
    {
      reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
      rejectedBy: 'ACCOUNT',
      limit: accountPlan.monthlyLimit,
      passes: accountUsed + units <= accountPlan.monthlyLimit,
    },
  ];

  const failed = rules.find((rule) => !rule.passes);
  const consumed = failed ? 0 : units;
  const remaining: Remaining = {
    account: Math.max(0, accountPlan.monthlyLimit - (accountUsed + consumed)),
    user: Math.max(0, userPlan.monthlyLimit - (userUsed + consumed)),
  };

  if (!failed) {
    return { status: 'ACCEPTED', reasonCode: null, rejectedBy: null, limit: null, remaining };
  }
  return {
    status: 'REJECTED',
    reasonCode: failed.reasonCode,
    rejectedBy: failed.rejectedBy,
    limit: failed.limit,
    remaining,
  };
}
