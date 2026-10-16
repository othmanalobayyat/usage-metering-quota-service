import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateInput } from '../src/services/rules.js';

// Predefined limits (docs/PLAN.md Phase 1).
const starter = { monthlyLimit: 10_000, perRequestLimit: 100 };
const basic = { monthlyLimit: 1_000, perRequestLimit: 20 };

function input(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    accountPlan: starter,
    userPlan: basic,
    accountUsed: 0,
    userUsed: 0,
    units: 10,
    ...overrides,
  };
}

describe('evaluate', () => {
  describe('accepted', () => {
    it('accepts a request within every limit and counts its units in remaining', () => {
      // accountUsed is above the user's monthly limit, so checking the user rule against
      // accountUsed would reject.
      expect(evaluate(input({ accountUsed: 5_000, userUsed: 100, units: 10 }))).toEqual({
        status: 'ACCEPTED',
        reasonCode: null,
        rejectedBy: null,
        limit: null,
        remaining: { account: 4_990, user: 890 },
      });
    });
  });

  describe('each rule failing alone', () => {
    it('user per-request', () => {
      // 25 units on Basic (20/req); Starter allows 100/req and both months have room.
      expect(evaluate(input({ units: 25 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 20,
        remaining: { account: 10_000, user: 1_000 },
      });
    });

    it('account per-request', () => {
      const userPlan = { monthlyLimit: 5_000, perRequestLimit: 500 };
      expect(evaluate(input({ userPlan, units: 150 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 100,
        remaining: { account: 10_000, user: 5_000 },
      });
    });

    it('user monthly', () => {
      expect(evaluate(input({ accountUsed: 3_000, userUsed: 995, units: 10 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 1_000,
        remaining: { account: 7_000, user: 5 },
      });
    });

    it('account monthly', () => {
      // 10 units with 5 left on the account; the user has plenty.
      expect(evaluate(input({ accountUsed: 9_995, userUsed: 20, units: 10 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 10_000,
        remaining: { account: 5, user: 980 },
      });
    });
  });

  describe('monthly limit of 0 on a fresh month', () => {
    it('rejects the first unit for a user plan with monthlyLimit 0', () => {
      const userPlan = { monthlyLimit: 0, perRequestLimit: 20 };
      expect(evaluate(input({ userPlan, accountUsed: 0, userUsed: 0, units: 1 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 0,
        remaining: { account: 10_000, user: 0 },
      });
    });

    it('rejects the first unit for an account plan with monthlyLimit 0', () => {
      const accountPlan = { monthlyLimit: 0, perRequestLimit: 100 };
      expect(evaluate(input({ accountPlan, accountUsed: 0, userUsed: 0, units: 1 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 0,
        remaining: { account: 0, user: 1_000 },
      });
    });
  });

  describe('several rules failing: the first in order wins', () => {
    it('user per-request beats account per-request', () => {
      expect(evaluate(input({ units: 150 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 20,
        remaining: { account: 10_000, user: 1_000 },
      });
    });

    it('account per-request beats user monthly', () => {
      const userPlan = { monthlyLimit: 100, perRequestLimit: 500 };
      expect(evaluate(input({ userPlan, accountUsed: 300, userUsed: 90, units: 150 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 100,
        remaining: { account: 9_700, user: 10 },
      });
    });

    it('user monthly beats account monthly', () => {
      expect(evaluate(input({ accountUsed: 9_996, userUsed: 995, units: 10 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 1_000,
        remaining: { account: 4, user: 5 },
      });
    });

    it('per-request beats monthly', () => {
      expect(evaluate(input({ accountUsed: 9_996, userUsed: 995, units: 25 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 20,
        remaining: { account: 4, user: 5 },
      });
    });

    it('all four failing reports the user per-request rule', () => {
      expect(evaluate(input({ accountUsed: 10_000, userUsed: 1_000, units: 150 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 20,
        remaining: { account: 0, user: 0 },
      });
    });
  });

  describe('exact boundaries', () => {
    it('accepts units equal to the user per-request limit', () => {
      expect(evaluate(input({ units: 20 }))).toEqual({
        status: 'ACCEPTED',
        reasonCode: null,
        rejectedBy: null,
        limit: null,
        remaining: { account: 9_980, user: 980 },
      });
      expect(evaluate(input({ units: 21 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 20,
        remaining: { account: 10_000, user: 1_000 },
      });
    });

    it('accepts units equal to the account per-request limit', () => {
      const userPlan = { monthlyLimit: 5_000, perRequestLimit: 500 };
      expect(evaluate(input({ userPlan, units: 100 }))).toEqual({
        status: 'ACCEPTED',
        reasonCode: null,
        rejectedBy: null,
        limit: null,
        remaining: { account: 9_900, user: 4_900 },
      });
      expect(evaluate(input({ userPlan, units: 101 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 100,
        remaining: { account: 10_000, user: 5_000 },
      });
    });

    it('accepts a request that brings the user exactly to the monthly limit', () => {
      // accountUsed differs from userUsed: checking the user rule against accountUsed would
      // reject the first call.
      expect(evaluate(input({ accountUsed: 2_000, userUsed: 990, units: 10 }))).toEqual({
        status: 'ACCEPTED',
        reasonCode: null,
        rejectedBy: null,
        limit: null,
        remaining: { account: 7_990, user: 0 },
      });
      expect(evaluate(input({ accountUsed: 2_000, userUsed: 991, units: 10 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 1_000,
        remaining: { account: 8_000, user: 9 },
      });
    });

    it('accepts a request that brings the account exactly to the monthly limit', () => {
      expect(evaluate(input({ accountUsed: 9_990, userUsed: 5, units: 10 }))).toEqual({
        status: 'ACCEPTED',
        reasonCode: null,
        rejectedBy: null,
        limit: null,
        remaining: { account: 0, user: 985 },
      });
      expect(evaluate(input({ accountUsed: 9_991, userUsed: 5, units: 10 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 10_000,
        remaining: { account: 9, user: 995 },
      });
    });

    it('rejects any further units once a monthly limit is exactly used up', () => {
      expect(evaluate(input({ accountUsed: 3_000, userUsed: 1_000, units: 1 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 1_000,
        remaining: { account: 7_000, user: 0 },
      });
    });
  });

  describe('allowance already below usage', () => {
    it('rejects and clamps remaining to 0 when the user plan was lowered below usage', () => {
      const userPlan = { monthlyLimit: 500, perRequestLimit: 20 };
      expect(evaluate(input({ userPlan, accountUsed: 1_200, userUsed: 800, units: 1 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 500,
        remaining: { account: 8_800, user: 0 },
      });
    });

    it('rejects and clamps remaining to 0 when the account plan was lowered below usage', () => {
      const accountPlan = { monthlyLimit: 1_000, perRequestLimit: 100 };
      expect(evaluate(input({ accountPlan, accountUsed: 1_500, userUsed: 0, units: 1 }))).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 1_000,
        remaining: { account: 0, user: 1_000 },
      });
    });

    it('clamps both remaining values to 0 when both are over', () => {
      const accountPlan = { monthlyLimit: 0, perRequestLimit: 100 };
      const userPlan = { monthlyLimit: 0, perRequestLimit: 20 };
      expect(
        evaluate(input({ accountPlan, userPlan, accountUsed: 50, userUsed: 50, units: 1 })),
      ).toEqual({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 0,
        remaining: { account: 0, user: 0 },
      });
    });
  });

  it('does not mutate its input', () => {
    const args = input();
    const copy = structuredClone(args);
    evaluate(args);
    expect(args).toEqual(copy);
  });
});
