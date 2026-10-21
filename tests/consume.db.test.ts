import { and, eq } from 'drizzle-orm';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { accountUsage, requests, users, userUsage } from '../src/db/schema.js';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { MAX_INT32 } from '../src/lib/schemas.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, TEST_DATABASE_URL, type TestDb } from './helpers/db.js';

describe.skipIf(!(await dbAvailable()))('POST /consume', () => {
  let testDb: TestDb;
  let app: Express;
  let current: Date;
  let account: { id: string; apiKey: string };

  beforeAll(() => {
    testDb = createTestDb();
    app = createTestApp(testDb, () => current);
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
    current = new Date('2026-10-15T12:00:00Z');
    account = await signUp(app);
  });

  afterAll(async () => {
    await testDb.close();
  });

  const as = (apiKey = account.apiKey) => ({
    get: (path: string) => request(app).get(path).set('X-API-Key', apiKey),
    post: (path: string, body: object) => request(app).post(path).set('X-API-Key', apiKey).send(body),
    put: (path: string, body: object) => request(app).put(path).set('X-API-Key', apiKey).send(body),
    patch: (path: string, body: object) => request(app).patch(path).set('X-API-Key', apiKey).send(body),
  });

  let seq = 0;
  const consume = (externalUserId: string, units: number, requestId = `req-${++seq}`, apiKey = account.apiKey) =>
    as(apiKey).post('/consume', { externalUserId, units, requestId });

  async function addUser(externalUserId: string, planId?: string, apiKey = account.apiKey) {
    const res = await as(apiKey).post('/users', { externalUserId, ...(planId ? { planId } : {}) });
    expect(res.status).toBe(201);
  }

  /** Assigns a fresh custom ACCOUNT plan to the test account. */
  async function setAccountPlan(monthlyLimit: number, perRequestLimit: number) {
    const planId = await createCustomPlan(app, account.apiKey, { name: `acct-${++seq}`, type: 'ACCOUNT', monthlyLimit, perRequestLimit });
    expect((await as().put('/account/plan', { planId })).status).toBe(200);
    return planId;
  }

  async function userIdOf(externalUserId: string, accountId = account.id) {
    const [row] = await testDb.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.accountId, accountId), eq(users.externalUserId, externalUserId)));
    return row!.id;
  }

  async function accountUnits(month = '2026-10-01', accountId = account.id) {
    const [row] = await testDb.db
      .select({ unitsUsed: accountUsage.unitsUsed })
      .from(accountUsage)
      .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.month, month)));
    return row?.unitsUsed ?? 0;
  }

  async function userUnits(externalUserId: string, month = '2026-10-01') {
    const userId = await userIdOf(externalUserId);
    const [row] = await testDb.db
      .select({ unitsUsed: userUsage.unitsUsed })
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.month, month)));
    return row?.unitsUsed ?? 0;
  }

  /** The invariant: for every (account, month), account usage = sum of its users' usage. */
  async function expectInvariant() {
    const { rows } = await testDb.pool.query<{ account_units: number; user_units: number }>(`
      select a.units_used as account_units, coalesce(sum(u.units_used), 0)::int as user_units
      from account_usage a
      left join user_usage u on u.account_id = a.account_id and u.month = a.month
      group by a.account_id, a.month, a.units_used`);
    for (const row of rows) expect(row.user_units).toBe(row.account_units);
  }

  describe('decisions', () => {
    beforeEach(async () => {
      await addUser('alice'); // Basic: 1,000/mo · 20/req; account on Starter: 10,000/mo · 100/req
    });

    it('accepted request adds N to both totals and reports remaining after the decision', async () => {
      const res = await consume('alice', 7, 'req-a');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        requestId: 'req-a',
        status: 'ACCEPTED',
        reasonCode: null,
        rejectedBy: null,
        limit: null,
        remaining: { account: 10_000 - 7, user: 1_000 - 7 },
        replayed: false,
      });
      expect(await accountUnits()).toBe(7);
      expect(await userUnits('alice')).toBe(7);

      await consume('alice', 3);
      expect(await accountUnits()).toBe(10);
      expect(await userUnits('alice')).toBe(10);
      expect((await as().get('/users/alice')).body.usage).toEqual({ month: '2026-10', consumed: 10, remaining: 990 });
      expect((await as().get('/account')).body.usage).toEqual({ month: '2026-10', consumed: 10, remaining: 9_990 });
    });

    it('25 units on Basic → REJECTED by USER, PER_REQUEST_LIMIT_EXCEEDED', async () => {
      const res = await consume('alice', 25, 'req-b');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        requestId: 'req-b',
        status: 'REJECTED',
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 20,
        remaining: { account: 10_000, user: 1_000 },
        replayed: false,
      });
    });

    it('10 units with 5 left on the account → REJECTED by ACCOUNT, MONTHLY_LIMIT_EXCEEDED', async () => {
      await setAccountPlan(30, 50);
      expect((await consume('alice', 20)).body.status).toBe('ACCEPTED');
      expect((await consume('alice', 5)).body.status).toBe('ACCEPTED');

      const res = await consume('alice', 10);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 30,
        remaining: { account: 5, user: 1_000 - 25 },
      });
      expect(await accountUnits()).toBe(25);
      expect(await userUnits('alice')).toBe(25);
      // Exactly reaching the limit is still accepted.
      expect((await consume('alice', 5)).body).toMatchObject({ status: 'ACCEPTED', remaining: { account: 0 } });
    });

    it("a larger user allowance doesn't raise the account's", async () => {
      await addUser('bob', PREDEFINED_PLAN_IDS.PREMIUM); // 5,000/mo · 100/req
      await setAccountPlan(250, 100); // account monthly limit well below bob's
      expect((await consume('bob', 100)).body.status).toBe('ACCEPTED');
      expect((await consume('bob', 100)).body.status).toBe('ACCEPTED');

      const res = await consume('bob', 100);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 250,
        remaining: { account: 50, user: 5_000 - 200 },
      });
      expect(await accountUnits()).toBe(200);
      expect(await userUnits('bob')).toBe(200);
    });

    it('a rejection changes no usage but is recorded', async () => {
      await consume('alice', 10);
      const before = { account: await accountUnits(), user: await userUnits('alice') };

      expect((await consume('alice', 25, 'rejected')).body.status).toBe('REJECTED');

      expect({ account: await accountUnits(), user: await userUnits('alice') }).toEqual(before);
      const [row] = await testDb.db.select().from(requests).where(eq(requests.requestId, 'rejected'));
      expect(row).toMatchObject({
        status: 'REJECTED',
        units: 25,
        reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limitValue: 20,
        accountPlanId: PREDEFINED_PLAN_IDS.STARTER,
        userPlanId: PREDEFINED_PLAN_IDS.BASIC,
        month: '2026-10-01',
      });
    });

    it('the request row stores the plan and remaining snapshot', async () => {
      await consume('alice', 4, 'snap');
      const [row] = await testDb.db.select().from(requests).where(eq(requests.requestId, 'snap'));
      expect(row).toMatchObject({
        accountId: account.id,
        userId: await userIdOf('alice'),
        units: 4,
        status: 'ACCEPTED',
        reasonCode: null,
        rejectedBy: null,
        limitValue: null,
        accountPlanId: PREDEFINED_PLAN_IDS.STARTER,
        userPlanId: PREDEFINED_PLAN_IDS.BASIC,
        remainingAccount: 9_996,
        remainingUser: 996,
        createdAt: current,
      });
    });
  });

  describe('idempotency', () => {
    beforeEach(async () => {
      await addUser('alice');
      await addUser('bob');
    });

    it('retry returns the identical response with replayed: true and consumes nothing more', async () => {
      const first = await consume('alice', 5, 'retry-me');
      // Usage moves on in between; the replay still shows the original snapshot.
      await consume('alice', 10);
      const again = await consume('alice', 5, 'retry-me');

      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ...first.body, replayed: true });
      expect(await userUnits('alice')).toBe(15);
      expect(await testDb.db.$count(requests, eq(requests.requestId, 'retry-me'))).toBe(1);
    });

    it('a retry in the next month replays the original decision and counts nothing in the new month', async () => {
      current = new Date('2026-10-31T23:59:59.999Z');
      const first = await consume('alice', 5, 'late');
      current = new Date('2026-11-01T00:00:00.000Z');
      const again = await consume('alice', 5, 'late');

      expect(again.body).toEqual({ ...first.body, replayed: true });
      expect(await accountUnits('2026-11-01')).toBe(0);
      expect(await userUnits('alice', '2026-11-01')).toBe(0);
      expect(await testDb.db.$count(requests)).toBe(1);
    });

    it('a rejected decision replays as a rejection', async () => {
      const first = await consume('alice', 25, 'rej');
      // Even after an upgrade that would now accept it: the requestId is spent.
      await as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM });
      const again = await consume('alice', 25, 'rej');
      expect(again.body).toEqual({ ...first.body, replayed: true });
      expect(again.body.status).toBe('REJECTED');
    });

    it('same requestId with different units or a different user → 409 IDEMPOTENCY_CONFLICT', async () => {
      await consume('alice', 5, 'dup');
      expectError(await consume('alice', 6, 'dup'), 409, 'IDEMPOTENCY_CONFLICT');
      expectError(await consume('bob', 5, 'dup'), 409, 'IDEMPOTENCY_CONFLICT');
      expect(await accountUnits()).toBe(5);
      expect(await userUnits('bob')).toBe(0);
    });

    it('requestId is scoped per account', async () => {
      const other = await signUp(app, 'other');
      await addUser('alice', undefined, other.apiKey);
      expect((await consume('alice', 5, 'shared-id')).body.replayed).toBe(false);
      const res = await consume('alice', 7, 'shared-id', other.apiKey);
      expect(res.body).toMatchObject({ status: 'ACCEPTED', replayed: false });
      expect(await accountUnits('2026-10-01', other.id)).toBe(7);
    });

    it('20 parallel requests with the same requestId: one increment, identical responses except replayed', async () => {
      const responses = await Promise.all(Array.from({ length: 20 }, () => consume('alice', 3, 'storm')));

      for (const res of responses) expect(res.status).toBe(200);
      expect(responses.filter((r) => r.body.replayed === false)).toHaveLength(1);
      const original = responses.find((r) => r.body.replayed === false)!.body;
      for (const res of responses) expect({ ...res.body, replayed: false }).toEqual(original);

      expect(await accountUnits()).toBe(3);
      expect(await userUnits('alice')).toBe(3);
      expect(await testDb.db.$count(requests)).toBe(1);
      await expectInvariant();
    });

    describe('unique-violation safety net (step 12)', () => {
      let blocker: pg.Client;

      beforeEach(async () => {
        blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
        await blocker.connect();
      });

      afterEach(async () => {
        await blocker.end();
      });

      /**
       * Another transaction inserts the requestId and holds it uncommitted, so consume passes
       * both the fast path and the recheck and then blocks on the unique index. Once the
       * blocker commits, consume hits 23505 and must answer from the committed row.
       */
      async function raceAgainstUncommitted(units: number) {
        await blocker.query('begin');
        await blocker.query(
          `insert into requests (account_id, user_id, request_id, units, month, status,
             account_plan_id, user_plan_id, remaining_account, remaining_user, created_at)
           values ($1, $2, 'race', 5, '2026-10-01', 'ACCEPTED', $3, $4, 9995, 995, $5)`,
          [account.id, await userIdOf('alice'), PREDEFINED_PLAN_IDS.STARTER, PREDEFINED_PLAN_IDS.BASIC, current],
        );
        // .then() sends the request now instead of when awaited.
        const pending = consume('alice', units, 'race').then((res) => res);
        await waitForLockWait();
        await blocker.query('commit');
        return pending;
      }

      async function waitForLockWait() {
        for (let i = 0; i < 200; i++) {
          const { rowCount } = await testDb.pool.query(
            `select 1 from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock' and query ilike 'insert into "requests"%'`,
          );
          if (rowCount) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('consume never blocked on the requests unique index');
      }

      it('same input → the stored decision, replayed, and the losing attempt is rolled back', async () => {
        const res = await raceAgainstUncommitted(5);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          requestId: 'race',
          status: 'ACCEPTED',
          reasonCode: null,
          rejectedBy: null,
          limit: null,
          remaining: { account: 9_995, user: 995 },
          replayed: true,
        });
        // The blocker inserted no usage and consume's increments were rolled back.
        expect(await accountUnits()).toBe(0);
        expect(await userUnits('alice')).toBe(0);
      });

      it('different input → 409', async () => {
        expectError(await raceAgainstUncommitted(6), 409, 'IDEMPOTENCY_CONFLICT');
        expect(await accountUnits()).toBe(0);
      });
    });
  });

  describe('plan changes', () => {
    it('plan switch keeps usage; allowance lowered below usage → remaining 0 and rejected', async () => {
      await addUser('alice', PREDEFINED_PLAN_IDS.PREMIUM); // 5,000/mo · 100/req
      for (let i = 0; i < 11; i++) expect((await consume('alice', 100)).body.status).toBe('ACCEPTED');

      // Switch to Basic (1,000/mo): the 1,100 already used carries over.
      const switched = await as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.BASIC });
      expect(switched.body.usage).toEqual({ month: '2026-10', consumed: 1_100, remaining: 0 });

      expect((await consume('alice', 1)).body).toMatchObject({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'USER',
        limit: 1_000,
        remaining: { account: 10_000 - 1_100, user: 0 },
      });
      expect(await userUnits('alice')).toBe(1_100);
    });

    it('lowering a custom plan below current usage takes effect on the next consume', async () => {
      const planId = await setAccountPlan(100, 50);
      await addUser('alice');
      await consume('alice', 20);
      await consume('alice', 20);
      expect((await as().patch(`/plans/${planId}`, { monthlyLimit: 30 })).status).toBe(200);

      expect((await consume('alice', 1)).body).toMatchObject({
        status: 'REJECTED',
        reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
        rejectedBy: 'ACCOUNT',
        limit: 30,
        remaining: { account: 0 },
      });
    });

    it('an upgrade turns the same request from rejected to accepted', async () => {
      await addUser('alice');
      expect((await consume('alice', 25)).body.rejectedBy).toBe('USER');
      await as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM });
      expect((await consume('alice', 25)).body.status).toBe('ACCEPTED');
    });

    it('updating a custom user plan affects every user assigned to it', async () => {
      const planId = await createCustomPlan(app, account.apiKey, { name: 'shared', type: 'USER', monthlyLimit: 1_000, perRequestLimit: 50 });
      await addUser('alice', planId);
      await addUser('bob', planId);
      expect((await consume('alice', 30)).body.status).toBe('ACCEPTED');
      expect((await consume('bob', 30)).body.status).toBe('ACCEPTED');

      expect((await as().patch(`/plans/${planId}`, { perRequestLimit: 10 })).status).toBe(200);

      for (const user of ['alice', 'bob']) {
        const res = await consume(user, 30);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          status: 'REJECTED',
          reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
          rejectedBy: 'USER',
          limit: 10,
          remaining: { account: 10_000 - 60, user: 1_000 - 30 },
        });
        expect(await userUnits(user)).toBe(30);
      }
      expect(await accountUnits()).toBe(60);
    });

    it('plan changes preserve past request history', async () => {
      const userPlanId = await createCustomPlan(app, account.apiKey, { name: 'custom-user', type: 'USER', monthlyLimit: 200, perRequestLimit: 50 });
      await addUser('alice', userPlanId);
      current = new Date('2026-10-15T12:00:00Z');
      expect((await consume('alice', 20, 'accepted-before')).body.status).toBe('ACCEPTED');
      current = new Date('2026-10-15T12:00:01Z');
      expect((await consume('alice', 60, 'rejected-before')).body.rejectedBy).toBe('USER');

      // Edit the plan the earlier requests were decided under, then move both the user and the account off their plans.
      expect((await as().patch(`/plans/${userPlanId}`, { monthlyLimit: 100, perRequestLimit: 10 })).status).toBe(200);
      expect((await as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM })).status).toBe(200);
      const accountPlanId = await setAccountPlan(500, 40);
      current = new Date('2026-10-15T12:00:02Z');
      expect((await consume('alice', 30, 'after')).body.status).toBe('ACCEPTED');

      const res = await as().get('/requests');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({
          requestId: 'after',
          status: 'ACCEPTED',
          limit: null,
          remaining: { account: 500 - 50, user: 5_000 - 50 },
          accountPlanId,
          userPlanId: PREDEFINED_PLAN_IDS.PREMIUM,
        }),
        expect.objectContaining({
          requestId: 'rejected-before',
          units: 60,
          status: 'REJECTED',
          reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
          rejectedBy: 'USER',
          limit: 50,
          remaining: { account: 10_000 - 20, user: 200 - 20 },
          accountPlanId: PREDEFINED_PLAN_IDS.STARTER,
          userPlanId,
        }),
        expect.objectContaining({
          requestId: 'accepted-before',
          units: 20,
          status: 'ACCEPTED',
          limit: null,
          remaining: { account: 10_000 - 20, user: 200 - 20 },
          accountPlanId: PREDEFINED_PLAN_IDS.STARTER,
          userPlanId,
        }),
      ]);
    });
  });

  describe('months', () => {
    it('new month starts at zero; old month is untouched and still queryable', async () => {
      await addUser('alice');
      current = new Date('2026-10-31T23:59:59.999Z');
      await consume('alice', 15);

      current = new Date('2026-11-01T00:00:00.000Z');
      expect((await as().get('/usage')).body).toEqual({ month: '2026-11', consumed: 0, remaining: 10_000 });
      expect((await as().get('/users/alice/usage')).body).toMatchObject({ month: '2026-11', consumed: 0, remaining: 1_000 });
      const res = await consume('alice', 4);
      expect(res.body.remaining).toEqual({ account: 10_000 - 4, user: 1_000 - 4 });

      expect((await as().get('/usage?month=2026-10')).body).toEqual({ month: '2026-10', consumed: 15, remaining: 10_000 - 15 });
      expect((await as().get('/users/alice/usage?month=2026-10')).body).toMatchObject({ month: '2026-10', consumed: 15 });
      expect((await as().get('/usage?month=2026-11')).body).toEqual({ month: '2026-11', consumed: 4, remaining: 10_000 - 4 });
      expect((await as().get('/users/alice/usage?month=2026-11')).body).toMatchObject({ month: '2026-11', consumed: 4 });
      const history = await as().get('/requests');
      expect(history.body.data.map((r: { month: string }) => r.month)).toEqual(['2026-11', '2026-10']);
      await expectInvariant();
    });
  });

  describe('concurrency', () => {
    it('50 parallel consumes never exceed the allowance; account usage = sum of user usage', async () => {
      // Account allows 100/mo; 50 requests × 3 units across 5 users ask for 150.
      await setAccountPlan(100, 50);
      const names = ['u0', 'u1', 'u2', 'u3', 'u4'];
      for (const name of names) await addUser(name, PREDEFINED_PLAN_IDS.PREMIUM);

      const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => consume(names[i % names.length]!, 3)));

      for (const res of responses) expect(res.status).toBe(200);
      const accepted = responses.filter((r) => r.body.status === 'ACCEPTED');
      expect(accepted).toHaveLength(33); // floor(100 / 3)
      for (const res of responses.filter((r) => r.body.status === 'REJECTED')) {
        expect(res.body).toMatchObject({ reasonCode: 'MONTHLY_LIMIT_EXCEEDED', rejectedBy: 'ACCOUNT', limit: 100 });
      }
      expect(await accountUnits()).toBe(99);
      // Remaining values are all distinct: each accepted decision saw the previous one's write.
      expect(new Set(accepted.map((r) => r.body.remaining.account)).size).toBe(33);
      await expectInvariant();
      expect(await testDb.db.$count(requests)).toBe(50);
    });

    it('50 parallel consumes by one user never exceed the user allowance', async () => {
      await addUser('alice'); // Basic 1,000/mo · 20/req
      const responses = await Promise.all(Array.from({ length: 50 }, () => consume('alice', 20)));
      for (const res of responses) expect(res.status).toBe(200);
      expect(responses.filter((r) => r.body.status === 'ACCEPTED')).toHaveLength(50);
      expect(await userUnits('alice')).toBe(1_000);

      const more = await Promise.all(Array.from({ length: 10 }, () => consume('alice', 1)));
      for (const res of more) expect(res.body).toMatchObject({ status: 'REJECTED', rejectedBy: 'USER' });
      expect(await userUnits('alice')).toBe(1_000);
      await expectInvariant();
    });

    it('a plan update racing parallel consumes: every decision matches the old or new plan; invariant holds', async () => {
      const planId = await setAccountPlan(1_000, 50);
      const names = ['u0', 'u1', 'u2'];
      for (const name of names) await addUser(name, PREDEFINED_PLAN_IDS.PREMIUM);
      // Use 60 of 1,000 so the lowered limit (100) leaves room for some but not all.
      for (let i = 0; i < 3; i++) await consume(names[i]!, 20);

      const [responses, patched] = await Promise.all([
        Promise.all(Array.from({ length: 30 }, (_, i) => consume(names[i % names.length]!, 5))),
        as().patch(`/plans/${planId}`, { monthlyLimit: 100 }),
      ]);

      expect(patched.status).toBe(200);
      for (const res of responses) {
        expect(res.status).toBe(200);
        if (res.body.status === 'REJECTED') {
          // Only the lowered plan can reject 5 units here (the old one had 940 left).
          expect(res.body).toMatchObject({ reasonCode: 'MONTHLY_LIMIT_EXCEEDED', rejectedBy: 'ACCOUNT', limit: 100 });
        }
      }
      const accepted = responses.filter((r) => r.body.status === 'ACCEPTED').length;
      expect(await accountUnits()).toBe(60 + accepted * 5);
      // Whichever order they serialize in, at least the 40 units the new limit leaves are granted.
      expect(accepted).toBeGreaterThanOrEqual(8); // (100 - 60) / 5
      await expectInvariant();
    });

    it('60 parallel consumes race at the user monthly limit: exactly 50 accepted, 10 rejected by USER', async () => {
      // Basic: 1,000/mo · 20/req. The account (Starter, 10,000/mo · 100/req) never binds here.
      await addUser('alice');
      const ids = Array.from({ length: 60 }, (_, i) => `user-race-${i}`);
      const responses = await Promise.all(ids.map((id) => consume('alice', 20, id)));

      for (const res of responses) expect(res.status).toBe(200);
      const accepted = responses.filter((r) => r.body.status === 'ACCEPTED');
      const rejected = responses.filter((r) => r.body.status === 'REJECTED');
      expect(accepted).toHaveLength(50);
      expect(rejected).toHaveLength(10);
      // Each acceptance saw the previous one's write: remaining 980, 960, …, 0, once each.
      const remainingUser = accepted.map((r) => r.body.remaining.user as number).sort((a, b) => a - b);
      expect(remainingUser).toEqual(Array.from({ length: 50 }, (_, i) => i * 20));
      // 20 more only fails once the user is at exactly 1,000, so every rejection's snapshot is the same.
      for (const res of rejected) {
        expect(res.body).toEqual({
          requestId: expect.any(String),
          status: 'REJECTED',
          reasonCode: 'MONTHLY_LIMIT_EXCEEDED',
          rejectedBy: 'USER',
          limit: 1_000,
          remaining: { account: 9_000, user: 0 },
          replayed: false,
        });
      }
      expect(await userUnits('alice')).toBe(1_000);
      expect(await accountUnits()).toBe(1_000);

      // The stored history agrees with every response.
      const rows = await testDb.db.select().from(requests).where(eq(requests.accountId, account.id));
      expect(rows).toHaveLength(60);
      const byRequestId = new Map(rows.map((row) => [row.requestId, row]));
      for (const res of responses) {
        const row = byRequestId.get(res.body.requestId)!;
        expect({
          status: row.status,
          reasonCode: row.reasonCode,
          rejectedBy: row.rejectedBy,
          limit: row.limitValue,
          remaining: { account: row.remainingAccount, user: row.remainingUser },
        }).toEqual({
          status: res.body.status,
          reasonCode: res.body.reasonCode,
          rejectedBy: res.body.rejectedBy,
          limit: res.body.limit,
          remaining: res.body.remaining,
        });
      }
      expect(rows.filter((row) => row.status === 'ACCEPTED').reduce((sum, row) => sum + row.units, 0)).toBe(1_000);
      await expectInvariant();
    });

    it('a user plan switch racing parallel consumes: each decision follows the plan it recorded, in lock order', async () => {
      // 30 units fit Premium's 100 per request but not Basic's 20, so each decision shows which plan it read.
      await addUser('alice', PREDEFINED_PLAN_IDS.PREMIUM);
      const [responses, switched] = await Promise.all([
        Promise.all(Array.from({ length: 30 }, (_, i) => consume('alice', 30, `switch-race-${i}`))),
        as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.BASIC }),
      ]);
      expect(switched.status).toBe(200);

      const rows = await testDb.db.select().from(requests).where(eq(requests.accountId, account.id));
      const byRequestId = new Map(rows.map((row) => [row.requestId, row]));
      const accepted = responses.filter((r) => r.body.status === 'ACCEPTED').length;
      for (const res of responses) {
        expect(res.status).toBe(200);
        const row = byRequestId.get(res.body.requestId)!;
        if (row.userPlanId === PREDEFINED_PLAN_IDS.PREMIUM) {
          expect(res.body.status).toBe('ACCEPTED');
        } else {
          expect(row.userPlanId).toBe(PREDEFINED_PLAN_IDS.BASIC);
          // Plans are read after the lock, so every decision on Basic comes after every decision on
          // Premium and sees all of their units. Whichever way the race goes, this holds.
          expect(res.body).toMatchObject({
            status: 'REJECTED',
            reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
            rejectedBy: 'USER',
            limit: 20,
            remaining: { account: 10_000 - 30 * accepted, user: Math.max(0, 1_000 - 30 * accepted) },
          });
        }
      }
      expect(await userUnits('alice')).toBe(30 * accepted);
      expect(await accountUnits()).toBe(30 * accepted);
      // Once the switch has committed, the same request is rejected.
      expect((await consume('alice', 30)).body).toMatchObject({ status: 'REJECTED', rejectedBy: 'USER', limit: 20 });
      await expectInvariant();
    });

    describe('a plan change that commits while consumes wait on the account row', () => {
      // A test session holds the account usage row, so the consumes queue at step 5; the plan change
      // commits while they wait. Plans are read after the lock (step 7), so every queued consume must
      // be decided by the new plan, although it arrived before the change. 8 queued consumes stay
      // under the pool's 10 connections, and the lock is released well within lock_timeout (3s).
      const QUEUED = 8;
      let blocker: pg.Client;

      beforeEach(async () => {
        blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
        await blocker.connect();
      });

      afterEach(async () => {
        await blocker.query('rollback').catch(() => {});
        await blocker.end();
      });

      /** Sends `send()` QUEUED times while the account row is held, runs `change`, then releases the row. */
      async function queueBehindAccountLock(send: (i: number) => Promise<request.Response>, change: () => Promise<request.Response>) {
        await blocker.query('begin');
        const { rowCount } = await blocker.query(
          `select 1 from account_usage where account_id = $1 and month = '2026-10-01' for update`,
          [account.id],
        );
        expect(rowCount).toBe(1);
        // .then() sends each request now instead of when awaited.
        const pending = Array.from({ length: QUEUED }, (_, i) => send(i).then((res) => res));
        for (let tries = 0; ; tries++) {
          const { rows } = await testDb.pool.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from "account_usage"%for update'`,
          );
          if (rows[0]!.n === QUEUED) break;
          if (tries > 200) throw new Error(`only ${rows[0]!.n} of ${QUEUED} consumes queued on the account row`);
          await new Promise((r) => setTimeout(r, 10));
        }
        const changed = await change();
        expect(changed.status).toBe(200);
        await blocker.query('commit');
        return Promise.all(pending);
      }

      it('an account plan switch: every queued consume is decided by the new account plan', async () => {
        // 20 units fit Pro's 1,000 per request but not Tight's 10.
        const tight = await createCustomPlan(app, account.apiKey, { name: 'tight', type: 'ACCOUNT', monthlyLimit: 100_000, perRequestLimit: 10 });
        expect((await as().put('/account/plan', { planId: PREDEFINED_PLAN_IDS.PRO })).status).toBe(200);
        await addUser('alice', PREDEFINED_PLAN_IDS.PREMIUM); // 5,000/mo · 100/req
        for (let i = 0; i < 3; i++) expect((await consume('alice', 20, `before-${i}`)).body.status).toBe('ACCEPTED');

        const responses = await queueBehindAccountLock(
          (i) => consume('alice', 20, `queued-${i}`),
          () => as().put('/account/plan', { planId: tight }),
        );

        for (const res of responses) {
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({
            status: 'REJECTED',
            reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
            rejectedBy: 'ACCOUNT',
            limit: 10,
            remaining: { account: 100_000 - 60, user: 5_000 - 60 },
          });
        }
        const rows = await testDb.db.select().from(requests).where(eq(requests.accountId, account.id));
        expect(rows.filter((row) => row.requestId.startsWith('queued-')).map((row) => row.accountPlanId)).toEqual(Array(QUEUED).fill(tight));
        expect(rows.filter((row) => row.requestId.startsWith('before-')).map((row) => row.accountPlanId)).toEqual(Array(3).fill(PREDEFINED_PLAN_IDS.PRO));
        expect(await accountUnits()).toBe(60);
        await expectInvariant();
      });

      it('a custom user plan PATCH: every queued consume is decided by the patched limits', async () => {
        const member = await createCustomPlan(app, account.apiKey, { name: 'member', type: 'USER', monthlyLimit: 5_000, perRequestLimit: 50 });
        await addUser('alice', member);
        for (let i = 0; i < 3; i++) expect((await consume('alice', 30, `before-${i}`)).body.status).toBe('ACCEPTED');

        const responses = await queueBehindAccountLock(
          (i) => consume('alice', 30, `queued-${i}`),
          () => as().patch(`/plans/${member}`, { perRequestLimit: 20 }),
        );

        for (const res of responses) {
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({
            status: 'REJECTED',
            reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
            rejectedBy: 'USER',
            limit: 20,
            remaining: { account: 10_000 - 90, user: 5_000 - 90 },
          });
        }
        expect(await userUnits('alice')).toBe(90);
        await expectInvariant();
      });
    });
  });

  describe('lock timeout', () => {
    let blocker: pg.Client;

    beforeEach(async () => {
      await addUser('alice');
      blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await blocker.connect();
    });

    afterEach(async () => {
      await blocker.end();
    });

    /** Commits this month's account usage row, then holds FOR UPDATE on it in an open transaction. */
    async function holdAccountRowLock() {
      await blocker.query(
        `insert into account_usage (account_id, month, units_used, updated_at) values ($1, '2026-10-01', 0, $2)`,
        [account.id, current],
      );
      await blocker.query('begin');
      const { rowCount } = await blocker.query(
        `select 1 from account_usage where account_id = $1 and month = '2026-10-01' for update`,
        [account.id],
      );
      expect(rowCount).toBe(1);
    }

    it(
      'a consume blocked on the account row fails with 503 within ~3s, writes nothing, and can be retried',
      async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        await holdAccountRowLock();

        const started = Date.now();
        const res = await consume('alice', 5, 'blocked');
        const elapsed = Date.now() - started;

        // lock_timeout (55P03) is overload, not a bug: 503 with Retry-After, safe to retry.
        expectError(res, 503, 'SERVICE_UNAVAILABLE');
        expect(res.headers['retry-after']).toBe('1');
        expect(res.body.error.message).toMatch(/same requestId/);
        // lock_timeout (3s), not the 5s client-side query_timeout.
        expect(elapsed).toBeGreaterThanOrEqual(2_500);
        expect(elapsed).toBeLessThan(4_500);
        expect(consoleError).toHaveBeenCalled();

        // Rolled back: no request row, no increment, no user usage row from the upsert.
        expect(await testDb.db.$count(requests)).toBe(0);
        expect(await accountUnits()).toBe(0);
        expect(await testDb.db.$count(userUsage)).toBe(0);

        // The pool is still healthy: a consume that needs no blocked lock succeeds.
        const other = await signUp(app, 'other');
        await addUser('bob', undefined, other.apiKey);
        expect((await consume('bob', 2, 'after-timeout', other.apiKey)).body).toMatchObject({
          status: 'ACCEPTED',
          replayed: false,
        });
        // No session was left inside an aborted or open transaction holding locks.
        const { rows } = await testDb.pool.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and state in ('idle in transaction', 'idle in transaction (aborted)')
             and pid <> $1`,
          [(blocker as unknown as { processID: number }).processID],
        );
        expect(rows[0]!.n).toBe(0);

        // Once the lock is released, the same requestId is decided fresh (it was never stored).
        await blocker.query('rollback');
        const retry = await consume('alice', 5, 'blocked');
        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({ requestId: 'blocked', status: 'ACCEPTED', replayed: false });
        expect(await accountUnits()).toBe(5);
        expect(await userUnits('alice')).toBe(5);
        await expectInvariant();
      },
      15_000,
    );
  });

  describe('pool timeout', () => {
    it('a request that waits too long for a pooled connection gets 503, and the same requestId succeeds later', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await addUser('alice');
      // A one-connection pool with a short wait, so holding its only client starves every request.
      const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 200 });
      const starvedApp = createApp({ db: createDb(pool), pingDb: async () => {}, now: () => current });
      const held = await pool.connect();
      const body = { externalUserId: 'alice', units: 5, requestId: 'starved' };
      try {
        try {
          const res = await request(starvedApp).post('/consume').set('X-API-Key', account.apiKey).send(body);
          expectError(res, 503, 'SERVICE_UNAVAILABLE');
          expect(res.headers['retry-after']).toBe('1');
          expect(await testDb.db.$count(requests)).toBe(0);
        } finally {
          // Released even if an assertion fails, so pool.end() below can't hang on it.
          held.release();
        }

        const retry = await request(starvedApp).post('/consume').set('X-API-Key', account.apiKey).send(body);
        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({ requestId: 'starved', status: 'ACCEPTED', replayed: false });
        expect(await accountUnits()).toBe(5);
      } finally {
        await pool.end();
      }
    });
  });

  describe('validation and access', () => {
    beforeEach(async () => {
      await addUser('alice');
    });

    it('unknown externalUserId → 404', async () => {
      expectError(await consume('nobody', 1), 404, 'NOT_FOUND');
      expect(await testDb.db.$count(requests)).toBe(0);
      expect(await testDb.db.$count(accountUsage)).toBe(0);
    });

    it("another account's user → 404", async () => {
      const other = await signUp(app, 'other');
      expectError(await consume('alice', 1, 'x', other.apiKey), 404, 'NOT_FOUND');
    });

    it('missing or invalid API key → 401', async () => {
      const body = { externalUserId: 'alice', units: 1, requestId: 'r' };
      expectError(await request(app).post('/consume').send(body), 401, 'UNAUTHORIZED');
      expectError(await request(app).post('/consume').set('X-API-Key', 'mk_nope').send(body), 401, 'UNAUTHORIZED');
    });

    it.each([
      ['units 0', { units: 0 }],
      ['negative units', { units: -1 }],
      ['fractional units', { units: 1.5 }],
      ['units as a string', { units: '5' }],
      ['units above int32', { units: MAX_INT32 + 1 }],
      ['empty requestId', { requestId: '' }],
      ['requestId over 128 chars', { requestId: 'r'.repeat(129) }],
      ['empty externalUserId', { externalUserId: '' }],
      ['externalUserId over 128 chars', { externalUserId: 'a'.repeat(129) }],
      ['null units', { units: null }],
      ['missing units', { units: undefined }],
      ['missing requestId', { requestId: undefined }],
      ['missing externalUserId', { externalUserId: undefined }],
      ['unknown field', { extra: true }],
      ['externalUserId with a leading space', { externalUserId: ' alice' }],
      ['externalUserId with a trailing space', { externalUserId: 'alice ' }],
      ['externalUserId with a trailing newline', { externalUserId: 'alice\n' }],
      ['whitespace-only externalUserId', { externalUserId: '   ' }],
      ['requestId with a leading space', { requestId: ' r' }],
      ['requestId with a trailing tab', { requestId: 'r\t' }],
    ])('%s → 400 and nothing written', async (_name, override) => {
      const body = { externalUserId: 'alice', units: 1, requestId: 'r', ...override };
      expectError(await as().post('/consume', body), 400, 'VALIDATION_ERROR');
      await expectNothingWritten();
    });

    it.each([
      ['empty object', {}],
      ['array body', [{ externalUserId: 'alice', units: 1, requestId: 'r' }]],
    ])('%s → 400 and nothing written', async (_name, body) => {
      expectError(await as().post('/consume', body), 400, 'VALIDATION_ERROR');
      await expectNothingWritten();
    });

    it('malformed JSON → 400 and nothing written', async () => {
      const res = await request(app)
        .post('/consume')
        .set('X-API-Key', account.apiKey)
        .set('Content-Type', 'application/json')
        .send('{"externalUserId": "alice",');
      expectError(res, 400, 'VALIDATION_ERROR');
      await expectNothingWritten();
    });

    async function expectNothingWritten() {
      expect(await testDb.db.$count(requests)).toBe(0);
      expect(await testDb.db.$count(accountUsage)).toBe(0);
      expect(await testDb.db.$count(userUsage)).toBe(0);
    }

    it('boundary values are accepted by validation', async () => {
      const res = await as().post('/consume', { externalUserId: 'alice', units: MAX_INT32, requestId: 'r'.repeat(128) });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'REJECTED', reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED', rejectedBy: 'USER' });
    });
  });
});
