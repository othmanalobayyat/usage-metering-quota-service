import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_PLAN_ID,
  DEFAULT_USER_PLAN_ID,
  PREDEFINED_PLAN_IDS,
  seedPlans,
} from '../src/db/seed.js';
import { accounts, accountUsage, plans, requests, userUsage, users } from '../src/db/schema.js';
import { toUtcMonth } from '../src/lib/month.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const now = () => NOW;
const MONTH = toUtcMonth(NOW);

/** Awaits a promise expected to fail and returns the underlying pg error (Drizzle wraps it in `cause`). */
async function pgError(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { cause?: unknown };
    return (e.cause ?? err) as { code?: string; constraint?: string };
  }
  throw new Error('expected the query to fail, but it succeeded');
}

describe.skipIf(!(await dbAvailable()))('schema and seed (quota_test database)', () => {
  let testDb: TestDb;

  beforeAll(() => {
    testDb = createTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
  });

  afterAll(async () => {
    await testDb.close();
  });

  async function createAccount(name: string) {
    const [account] = await testDb.db
      .insert(accounts)
      .values({
        name,
        apiKeyHash: name.padEnd(64, '0').slice(0, 64),
        planId: DEFAULT_ACCOUNT_PLAN_ID,
        createdAt: NOW,
      })
      .returning();
    return account!;
  }

  async function createUser(accountId: string, externalUserId: string) {
    const [user] = await testDb.db
      .insert(users)
      .values({ accountId, externalUserId, planId: DEFAULT_USER_PLAN_ID, createdAt: NOW })
      .returning();
    return user!;
  }

  function requestRow(accountId: string, userId: string, requestId: string) {
    return {
      accountId,
      userId,
      requestId,
      units: 10,
      month: MONTH,
      accountPlanId: DEFAULT_ACCOUNT_PLAN_ID,
      userPlanId: DEFAULT_USER_PLAN_ID,
      remainingAccount: 9_990,
      remainingUser: 990,
      createdAt: NOW,
    };
  }

  describe('seed', () => {
    it('inserts the four predefined plans with the documented limits', async () => {
      const rows = await testDb.db
        .select({
          id: plans.id,
          name: plans.name,
          type: plans.type,
          monthlyLimit: plans.monthlyLimit,
          perRequestLimit: plans.perRequestLimit,
        })
        .from(plans)
        .where(isNull(plans.accountId))
        .orderBy(plans.id);

      expect(rows).toEqual([
        { id: PREDEFINED_PLAN_IDS.STARTER, name: 'Starter', type: 'ACCOUNT', monthlyLimit: 10_000, perRequestLimit: 100 },
        { id: PREDEFINED_PLAN_IDS.PRO, name: 'Pro', type: 'ACCOUNT', monthlyLimit: 100_000, perRequestLimit: 1_000 },
        { id: PREDEFINED_PLAN_IDS.BASIC, name: 'Basic', type: 'USER', monthlyLimit: 1_000, perRequestLimit: 20 },
        { id: PREDEFINED_PLAN_IDS.PREMIUM, name: 'Premium', type: 'USER', monthlyLimit: 5_000, perRequestLimit: 100 },
      ]);
    });

    it('is idempotent: running it again inserts nothing and duplicates nothing', async () => {
      // resetDatabase already seeded once.
      expect(await seedPlans(testDb.db, now)).toBe(0);
      expect(await seedPlans(testDb.db, now)).toBe(0);
      expect(await testDb.db.$count(plans)).toBe(4);
    });

    it('does not overwrite an existing predefined row', async () => {
      await testDb.db.update(plans).set({ monthlyLimit: 1 }).where(eq(plans.id, PREDEFINED_PLAN_IDS.STARTER));
      await seedPlans(testDb.db, now);
      const [starter] = await testDb.db.select().from(plans).where(eq(plans.id, PREDEFINED_PLAN_IDS.STARTER));
      expect(starter!.monthlyLimit).toBe(1);
    });
  });

  describe('requests status/decision CHECK', () => {
    it('accepts a well-formed ACCEPTED row and a well-formed REJECTED row', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      await testDb.db.insert(requests).values({ ...requestRow(account.id, user.id, 'ok-1'), status: 'ACCEPTED' });
      await testDb.db.insert(requests).values({
        ...requestRow(account.id, user.id, 'ok-2'),
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limitValue: 20,
      });
      expect(await testDb.db.$count(requests)).toBe(2);
    });

    it('rejects an ACCEPTED row that has a reason_code', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      const err = await pgError(
        testDb.db.insert(requests).values({
          ...requestRow(account.id, user.id, 'r-1'),
          status: 'ACCEPTED',
          reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('requests_status_decision_check');
    });

    it('rejects a REJECTED row without a reason_code', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      const err = await pgError(
        testDb.db.insert(requests).values({
          ...requestRow(account.id, user.id, 'r-2'),
          status: 'REJECTED',
          rejectedBy: 'ACCOUNT',
          limitValue: 10_000,
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('requests_status_decision_check');
    });

    it('rejects a REJECTED row without rejected_by or limit_value', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      const err = await pgError(
        testDb.db.insert(requests).values({
          ...requestRow(account.id, user.id, 'r-3'),
          status: 'REJECTED',
          reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        }),
      );
      expect(err.constraint).toBe('requests_status_decision_check');
    });
  });

  describe('composite FKs to users(account_id, id)', () => {
    it("rejects a user_usage row pointing at another account's user", async () => {
      const a = await createAccount('a');
      const b = await createAccount('b');
      const bob = await createUser(b.id, 'bob');

      const err = await pgError(
        testDb.db.insert(userUsage).values({ accountId: a.id, userId: bob.id, month: MONTH, updatedAt: NOW }),
      );
      expect(err.code).toBe('23503');
      expect(err.constraint).toBe('user_usage_account_id_user_id_users_fk');

      // The same row under the user's own account is fine.
      await testDb.db.insert(userUsage).values({ accountId: b.id, userId: bob.id, month: MONTH, updatedAt: NOW });
    });

    it("rejects a requests row pointing at another account's user", async () => {
      const a = await createAccount('a');
      const b = await createAccount('b');
      const bob = await createUser(b.id, 'bob');
      const err = await pgError(
        testDb.db.insert(requests).values({ ...requestRow(a.id, bob.id, 'x'), status: 'ACCEPTED' }),
      );
      expect(err.code).toBe('23503');
      expect(err.constraint).toBe('requests_account_id_user_id_users_fk');
    });
  });

  describe('other constraints', () => {
    it('rejects a usage month that is not the first day of a month', async () => {
      const account = await createAccount('a');
      const err = await pgError(
        testDb.db.insert(accountUsage).values({ accountId: account.id, month: '2026-10-15', updatedAt: NOW }),
      );
      expect(err.constraint).toBe('account_usage_month_check');
    });

    it('scopes requestId per account', async () => {
      const a = await createAccount('a');
      const b = await createAccount('b');
      const alice = await createUser(a.id, 'alice');
      const bob = await createUser(b.id, 'bob');
      await testDb.db.insert(requests).values({ ...requestRow(a.id, alice.id, 'same'), status: 'ACCEPTED' });
      await testDb.db.insert(requests).values({ ...requestRow(b.id, bob.id, 'same'), status: 'ACCEPTED' });

      const err = await pgError(
        testDb.db.insert(requests).values({ ...requestRow(a.id, alice.id, 'same'), status: 'ACCEPTED' }),
      );
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('requests_account_id_request_id_unique');
    });

    it('rejects a duplicate external_user_id within an account, allows it across accounts', async () => {
      const a = await createAccount('a');
      const b = await createAccount('b');
      await createUser(a.id, 'alice');

      const err = await pgError(createUser(a.id, 'alice'));
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('users_account_id_external_user_id_unique');

      await createUser(b.id, 'alice');
      await createUser(a.id, 'alice-2');
      expect(await testDb.db.$count(users)).toBe(3);
    });

    it('treats predefined plan names as unique among themselves (NULLS NOT DISTINCT)', async () => {
      const err = await pgError(
        testDb.db.insert(plans).values({
          accountId: null,
          name: 'Starter',
          type: 'ACCOUNT',
          monthlyLimit: 1,
          perRequestLimit: 1,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('plans_account_id_name_unique');
    });
  });

  // Each CHECK is probed at its boundary: the first invalid value is rejected, the edge value is accepted.
  describe('range CHECKs', () => {
    function planRow(accountId: string, name: string, limits: { monthlyLimit: number; perRequestLimit: number }) {
      return { accountId, name, type: 'ACCOUNT' as const, ...limits, createdAt: NOW, updatedAt: NOW };
    }

    it('plans.monthly_limit must be >= 0', async () => {
      const account = await createAccount('a');
      const err = await pgError(
        testDb.db.insert(plans).values(planRow(account.id, 'neg', { monthlyLimit: -1, perRequestLimit: 1 })),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('plans_monthly_limit_check');

      await testDb.db.insert(plans).values(planRow(account.id, 'zero', { monthlyLimit: 0, perRequestLimit: 1 }));
    });

    it('plans.per_request_limit must be > 0', async () => {
      const account = await createAccount('a');
      const err = await pgError(
        testDb.db.insert(plans).values(planRow(account.id, 'zero', { monthlyLimit: 10, perRequestLimit: 0 })),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('plans_per_request_limit_check');

      await testDb.db.insert(plans).values(planRow(account.id, 'one', { monthlyLimit: 10, perRequestLimit: 1 }));
    });

    it('account_usage.units_used must be >= 0', async () => {
      const account = await createAccount('a');
      const err = await pgError(
        testDb.db.insert(accountUsage).values({ accountId: account.id, month: MONTH, unitsUsed: -1, updatedAt: NOW }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('account_usage_units_used_check');

      await testDb.db.insert(accountUsage).values({ accountId: account.id, month: MONTH, unitsUsed: 0, updatedAt: NOW });
    });

    it('user_usage.units_used must be >= 0', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      const err = await pgError(
        testDb.db
          .insert(userUsage)
          .values({ accountId: account.id, userId: user.id, month: MONTH, unitsUsed: -1, updatedAt: NOW }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('user_usage_units_used_check');

      await testDb.db
        .insert(userUsage)
        .values({ accountId: account.id, userId: user.id, month: MONTH, unitsUsed: 0, updatedAt: NOW });
    });

    it('user_usage.month must be the first day of a month', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      const err = await pgError(
        testDb.db.insert(userUsage).values({ accountId: account.id, userId: user.id, month: '2026-10-15', updatedAt: NOW }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('user_usage_month_check');

      await testDb.db.insert(userUsage).values({ accountId: account.id, userId: user.id, month: '2026-10-01', updatedAt: NOW });
    });

    it('requests.units must be > 0', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      const err = await pgError(
        testDb.db.insert(requests).values({ ...requestRow(account.id, user.id, 'r-0'), units: 0, status: 'ACCEPTED' }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('requests_units_check');

      await testDb.db.insert(requests).values({ ...requestRow(account.id, user.id, 'r-1'), units: 1, status: 'ACCEPTED' });
    });

    it('requests.remaining_account must be >= 0', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      const err = await pgError(
        testDb.db
          .insert(requests)
          .values({ ...requestRow(account.id, user.id, 'r-neg'), remainingAccount: -1, status: 'ACCEPTED' }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('requests_remaining_account_check');

      await testDb.db
        .insert(requests)
        .values({ ...requestRow(account.id, user.id, 'r-zero'), remainingAccount: 0, status: 'ACCEPTED' });
    });

    it('requests.remaining_user must be >= 0', async () => {
      const account = await createAccount('a');
      const user = await createUser(account.id, 'alice');
      const err = await pgError(
        testDb.db
          .insert(requests)
          .values({ ...requestRow(account.id, user.id, 'r-neg'), remainingUser: -1, status: 'ACCEPTED' }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('requests_remaining_user_check');

      await testDb.db
        .insert(requests)
        .values({ ...requestRow(account.id, user.id, 'r-zero'), remainingUser: 0, status: 'ACCEPTED' });
    });
  });
});
