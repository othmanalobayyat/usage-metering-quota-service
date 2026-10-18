import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountUsage, userUsage } from '../src/db/schema.js';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

describe.skipIf(!(await dbAvailable()))('usage endpoints', () => {
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
    await as().post('/users', { externalUserId: 'alice' }); // Basic: 1,000/mo
  });

  afterAll(async () => {
    await testDb.close();
  });

  const as = (apiKey = account.apiKey) => ({
    get: (path: string) => request(app).get(path).set('X-API-Key', apiKey),
    post: (path: string, body: object) => request(app).post(path).set('X-API-Key', apiKey).send(body),
    put: (path: string, body: object) => request(app).put(path).set('X-API-Key', apiKey).send(body),
  });

  let seq = 0;
  async function consume(externalUserId: string, units: number) {
    const res = await as().post('/consume', { externalUserId, units, requestId: `req-${++seq}` });
    expect(res.status).toBe(200);
    return res;
  }

  async function usageRowCount() {
    const accountRows = await testDb.db.select().from(accountUsage);
    const userRows = await testDb.db.select().from(userUsage);
    return accountRows.length + userRows.length;
  }

  describe('GET /usage', () => {
    it("defaults to the current UTC month from the clock and reports the account's consumption", async () => {
      await consume('alice', 15);
      const res = await as().get('/usage');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ month: '2026-10', consumed: 15, remaining: 10_000 - 15 });
    });

    it('follows the clock across a month boundary', async () => {
      current = new Date('2026-10-31T23:59:59.999Z');
      await consume('alice', 15);
      current = new Date('2026-11-01T00:00:00.000Z');
      expect((await as().get('/usage')).body).toEqual({ month: '2026-11', consumed: 0, remaining: 10_000 });
    });

    it('a month with no usage row reads as 0 and creates no row', async () => {
      expect(await usageRowCount()).toBe(0);
      expect((await as().get('/usage')).body).toEqual({ month: '2026-10', consumed: 0, remaining: 10_000 });
      expect((await as().get('/usage?month=2025-01')).body).toEqual({ month: '2025-01', consumed: 0, remaining: 10_000 });
      expect((await as().get('/usage?month=2030-06')).body).toEqual({ month: '2030-06', consumed: 0, remaining: 10_000 });
      expect(await usageRowCount()).toBe(0);
    });

    it('a past month is measured against the current plan, and remaining never goes negative', async () => {
      await consume('alice', 15);
      current = new Date('2026-11-02T00:00:00Z');
      const tiny = await createCustomPlan(app, account.apiKey, { name: 'tiny', type: 'ACCOUNT', monthlyLimit: 10, perRequestLimit: 5 });
      expect((await as().put('/account/plan', { planId: tiny })).status).toBe(200);
      expect((await as().get('/usage?month=2026-10')).body).toEqual({ month: '2026-10', consumed: 15, remaining: 0 });
    });

    it.each(['2026-1', '2026-13', '2026-00', '2026-10-01', '10-2026', 'october', '', '0000-01'])('?month=%j → 400', async (month) => {
      expectError(await as().get(`/usage?month=${encodeURIComponent(month)}`), 400, 'VALIDATION_ERROR');
    });

    it('a repeated month param → 400', async () => {
      expectError(await as().get('/usage?month=2026-10&month=2026-11'), 400, 'VALIDATION_ERROR');
    });

    it('missing or invalid API key → 401', async () => {
      expectError(await request(app).get('/usage'), 401, 'UNAUTHORIZED');
      expectError(await request(app).get('/usage').set('X-API-Key', 'mk_nope'), 401, 'UNAUTHORIZED');
    });
  });

  describe('GET /users/:externalUserId/usage', () => {
    it("defaults to the current month and reports the user's consumption against the user's plan", async () => {
      await as().post('/users', { externalUserId: 'bob', planId: PREDEFINED_PLAN_IDS.PREMIUM });
      await consume('alice', 15);
      await consume('bob', 40);
      expect((await as().get('/users/alice/usage')).body).toEqual({
        externalUserId: 'alice',
        month: '2026-10',
        consumed: 15,
        remaining: 1_000 - 15,
      });
      expect((await as().get('/users/bob/usage')).body).toEqual({
        externalUserId: 'bob',
        month: '2026-10',
        consumed: 40,
        remaining: 5_000 - 40,
      });
      expect((await as().get('/usage')).body.consumed).toBe(55);
    });

    it('a month with no usage row reads as 0 and creates no row', async () => {
      expect((await as().get('/users/alice/usage?month=2026-09')).body).toEqual({
        externalUserId: 'alice',
        month: '2026-09',
        consumed: 0,
        remaining: 1_000,
      });
      expect(await usageRowCount()).toBe(0);
    });

    it('unknown or malformed externalUserId → 404', async () => {
      expectError(await as().get('/users/nobody/usage'), 404, 'NOT_FOUND');
      expectError(await as().get(`/users/${'x'.repeat(129)}/usage`), 404, 'NOT_FOUND');
    });

    it('invalid month for a known user → 400', async () => {
      expectError(await as().get('/users/alice/usage?month=2026-13'), 400, 'VALIDATION_ERROR');
    });

    it('URL-encoded externalUserIds round-trip', async () => {
      await as().post('/users', { externalUserId: 'a/b c' });
      await consume('a/b c', 3);
      expect((await as().get(`/users/${encodeURIComponent('a/b c')}/usage`)).body).toMatchObject({
        externalUserId: 'a/b c',
        consumed: 3,
      });
    });

    it('?month= reads that month\'s row, not the current one', async () => {
      current = new Date('2026-09-10T00:00:00Z');
      await consume('alice', 7);
      current = new Date('2026-10-15T12:00:00Z');
      await consume('alice', 2);
      expect((await as().get('/users/alice/usage?month=2026-09')).body).toEqual({
        externalUserId: 'alice',
        month: '2026-09',
        consumed: 7,
        remaining: 1_000 - 7,
      });
      expect((await as().get('/users/alice/usage')).body).toMatchObject({ month: '2026-10', consumed: 2 });
    });
  });

  describe('account isolation', () => {
    let other: { id: string; apiKey: string };

    beforeEach(async () => {
      await as().post('/users', { externalUserId: 'dave' });
      other = await signUp(app, 'other');
      // B has its own alice (same externalUserId as A's) and a user A doesn't have.
      await as(other.apiKey).post('/users', { externalUserId: 'alice', planId: PREDEFINED_PLAN_IDS.PREMIUM });
      await as(other.apiKey).post('/users', { externalUserId: 'bob' });
      current = new Date('2026-09-10T00:00:00Z');
      await consume('alice', 4);
      current = new Date('2026-10-15T12:00:00Z');
      await consume('alice', 15);
      await consume('dave', 5);
    });

    async function consumeAsOther(externalUserId: string, units: number) {
      const res = await as(other.apiKey).post('/consume', { externalUserId, units, requestId: `other-${++seq}` });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACCEPTED');
    }

    async function snapshotA() {
      return Promise.all(
        ['/usage', '/usage?month=2026-09', '/users/alice/usage', '/users/alice/usage?month=2026-09', '/users/dave/usage'].map(
          async (path) => {
            const res = await as().get(path);
            expect(res.status).toBe(200);
            return res.body;
          },
        ),
      );
    }

    it("B's consumes leave A's GET /usage and GET /users/:externalUserId/usage unchanged", async () => {
      const before = await snapshotA();
      expect(before).toEqual([
        { month: '2026-10', consumed: 20, remaining: 10_000 - 20 },
        { month: '2026-09', consumed: 4, remaining: 10_000 - 4 },
        { externalUserId: 'alice', month: '2026-10', consumed: 15, remaining: 1_000 - 15 },
        { externalUserId: 'alice', month: '2026-09', consumed: 4, remaining: 1_000 - 4 },
        { externalUserId: 'dave', month: '2026-10', consumed: 5, remaining: 1_000 - 5 },
      ]);

      // Same month, same externalUserId as A's alice, plus a past month.
      await consumeAsOther('alice', 90);
      await consumeAsOther('bob', 20);
      current = new Date('2026-09-20T00:00:00Z');
      await consumeAsOther('alice', 30);
      current = new Date('2026-10-15T12:00:00Z');

      expect(await snapshotA()).toEqual(before);
      expect((await as(other.apiKey).get('/usage')).body).toEqual({ month: '2026-10', consumed: 110, remaining: 10_000 - 110 });
      expect((await as(other.apiKey).get('/usage?month=2026-09')).body).toMatchObject({ consumed: 30 });
    });

    it("B's same-named user resolves within B's account", async () => {
      await consumeAsOther('alice', 90);
      expect((await as(other.apiKey).get('/users/alice/usage')).body).toEqual({
        externalUserId: 'alice',
        month: '2026-10',
        consumed: 90,
        remaining: 5_000 - 90,
      });
    });

    it("B gets 404 on A's users' usage, with or without ?month", async () => {
      expectError(await as(other.apiKey).get('/users/dave/usage'), 404, 'NOT_FOUND');
      expectError(await as(other.apiKey).get('/users/dave/usage?month=2026-10'), 404, 'NOT_FOUND');
      expectError(await as(other.apiKey).get('/users/dave/usage?month=2026-09'), 404, 'NOT_FOUND');
    });

    it("B consuming for A's user is a 404 and A's usage is unchanged", async () => {
      const before = await snapshotA();
      const res = await as(other.apiKey).post('/consume', { externalUserId: 'dave', units: 1, requestId: 'probe' });
      expectError(res, 404, 'NOT_FOUND');
      expect(await snapshotA()).toEqual(before);
    });
  });
});
