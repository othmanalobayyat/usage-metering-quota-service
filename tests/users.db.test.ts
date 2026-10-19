import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users, userUsage } from '../src/db/schema.js';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { encodeCursor } from '../src/lib/cursor.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

describe.skipIf(!(await dbAvailable()))('users', () => {
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

  const as = () => ({
    get: (path: string) => request(app).get(path).set('X-API-Key', account.apiKey),
    post: (path: string, body: object) => request(app).post(path).set('X-API-Key', account.apiKey).send(body),
    put: (path: string, body: object) => request(app).put(path).set('X-API-Key', account.apiKey).send(body),
  });

  describe('POST /users', () => {
    it('registers a user on Basic by default', async () => {
      const res = await as().post('/users', { externalUserId: 'alice', name: 'Alice' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        externalUserId: 'alice',
        name: 'Alice',
        plan: expect.objectContaining({ id: PREDEFINED_PLAN_IDS.BASIC, name: 'Basic', monthlyLimit: 1_000, perRequestLimit: 20 }),
        usage: { month: '2026-10', consumed: 0, remaining: 1_000 },
        createdAt: current.toISOString(),
      });
      // Internal user UUIDs never appear in the API.
      expect(res.body).not.toHaveProperty('id');
    });

    it('accepts a predefined or own custom USER plan; name is optional', async () => {
      const premium = await as().post('/users', { externalUserId: 'bob', planId: PREDEFINED_PLAN_IDS.PREMIUM });
      expect(premium.status).toBe(201);
      expect(premium.body).toMatchObject({ name: null, plan: { name: 'Premium' } });

      const custom = await createCustomPlan(app, account.apiKey, { name: 'Member', type: 'USER' });
      const res = await as().post('/users', { externalUserId: 'carol', planId: custom });
      expect(res.body.plan).toMatchObject({ id: custom, predefined: false });
    });

    it('wrong plan type → 400', async () => {
      const customAccountPlan = await createCustomPlan(app, account.apiKey, { name: 'Team', type: 'ACCOUNT' });
      for (const planId of [PREDEFINED_PLAN_IDS.STARTER, customAccountPlan]) {
        expectError(await as().post('/users', { externalUserId: 'alice', planId }), 400, 'VALIDATION_ERROR');
      }
      expect(await testDb.db.$count(users)).toBe(0);
    });

    it('unknown planId → 404', async () => {
      const res = await as().post('/users', { externalUserId: 'alice', planId: '11111111-1111-4111-8111-111111111111' });
      expectError(res, 404, 'NOT_FOUND');
    });

    it('duplicate externalUserId → 409 ALREADY_EXISTS', async () => {
      await as().post('/users', { externalUserId: 'alice' });
      expectError(await as().post('/users', { externalUserId: 'alice' }), 409, 'ALREADY_EXISTS');
    });

    it.each([{}, { externalUserId: '' }, { externalUserId: 'x'.repeat(129) }, { externalUserId: 7 }, { externalUserId: 'a', planId: 'basic' }, { externalUserId: 'a', id: 'x' }, { externalUserId: ' alice' }, { externalUserId: 'alice ' }, { externalUserId: '\talice' }])(
      'rejects %j with 400',
      async (body) => {
        expectError(await as().post('/users', body), 400, 'VALIDATION_ERROR');
      },
    );
  });

  describe('GET /users/:externalUserId', () => {
    it("returns the user's plan and this month's usage without creating a row", async () => {
      await as().post('/users', { externalUserId: 'alice' });
      const fresh = await as().get('/users/alice');
      expect(fresh.status).toBe(200);
      expect(fresh.body.usage).toEqual({ month: '2026-10', consumed: 0, remaining: 1_000 });
      expect(await testDb.db.$count(userUsage)).toBe(0);

      const [alice] = await testDb.db.select().from(users).where(eq(users.externalUserId, 'alice'));
      await testDb.db.insert(userUsage).values([
        { userId: alice!.id, accountId: account.id, month: '2026-10-01', unitsUsed: 120, updatedAt: current },
        { userId: alice!.id, accountId: account.id, month: '2026-09-01', unitsUsed: 999, updatedAt: current },
      ]);
      expect((await as().get('/users/alice')).body.usage).toEqual({ month: '2026-10', consumed: 120, remaining: 880 });
    });

    it('handles externalUserIds that need URL encoding', async () => {
      await as().post('/users', { externalUserId: 'user/42 é' });
      const res = await as().get(`/users/${encodeURIComponent('user/42 é')}`);
      expect(res.status).toBe(200);
      expect(res.body.externalUserId).toBe('user/42 é');
    });

    it('unknown user → 404', async () => {
      expectError(await as().get('/users/nobody'), 404, 'NOT_FOUND');
      expectError(await as().get(`/users/${'x'.repeat(129)}`), 404, 'NOT_FOUND');
    });

    it('an externalUserId with surrounding whitespace in the path → 404 (it can never be registered)', async () => {
      await as().post('/users', { externalUserId: 'alice' });
      expectError(await as().get(`/users/${encodeURIComponent(' alice')}`), 404, 'NOT_FOUND');
      expectError(await as().get(`/users/${encodeURIComponent('alice ')}/usage`), 404, 'NOT_FOUND');
    });
  });

  describe('PUT /users/:externalUserId/plan', () => {
    it('switches the plan and keeps usage', async () => {
      await as().post('/users', { externalUserId: 'alice' });
      const [alice] = await testDb.db.select().from(users).where(eq(users.externalUserId, 'alice'));
      await testDb.db
        .insert(userUsage)
        .values({ userId: alice!.id, accountId: account.id, month: '2026-10-01', unitsUsed: 900, updatedAt: current });

      const res = await as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM });
      expect(res.status).toBe(200);
      expect(res.body.plan).toMatchObject({ name: 'Premium', perRequestLimit: 100 });
      expect(res.body.usage).toEqual({ month: '2026-10', consumed: 900, remaining: 4_100 });
    });

    it('wrong plan type → 400 and the plan is unchanged', async () => {
      await as().post('/users', { externalUserId: 'alice' });
      expectError(await as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.PRO }), 400, 'VALIDATION_ERROR');
      expect((await as().get('/users/alice')).body.plan.name).toBe('Basic');
    });

    it('missing planId → 400', async () => {
      await as().post('/users', { externalUserId: 'alice' });
      expectError(await as().put('/users/alice/plan', {}), 400, 'VALIDATION_ERROR');
    });

    it('unknown user or unknown plan → 404', async () => {
      expectError(await as().put('/users/nobody/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM }), 404, 'NOT_FOUND');
      await as().post('/users', { externalUserId: 'alice' });
      expectError(
        await as().put('/users/alice/plan', { planId: '11111111-1111-4111-8111-111111111111' }),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('GET /users pagination', () => {
    async function register(ids: string[], at: string) {
      current = new Date(at);
      for (const externalUserId of ids) {
        expect((await as().post('/users', { externalUserId })).status).toBe(201);
      }
    }

    /** Every page from the start, following nextCursor. */
    async function readAllPages(limit: number) {
      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const query: string = `/users?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await as().get(query);
        expect(res.status).toBe(200);
        pages.push(res.body.data.map((u: { externalUserId: string }) => u.externalUserId));
        cursor = res.body.nextCursor;
        expect(pages.length).toBeLessThan(100);
      } while (cursor);
      return pages;
    }

    /** The true order: (created_at, id) ascending, computed in JS from the stored rows. */
    async function expectedOrder() {
      const rows = await testDb.db.select().from(users).where(eq(users.accountId, account.id));
      return rows
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((u) => u.externalUserId);
    }

    it('returns pages in order with no duplicates or gaps, including ties on created_at', async () => {
      // Out of insertion order on purpose, and 10 users share one timestamp so only the id breaks ties.
      await register(['t2-a', 't2-b', 't2-c'], '2026-10-15T12:00:02Z');
      await register(Array.from({ length: 10 }, (_, i) => `t1-${i}`), '2026-10-15T12:00:01Z');
      await register(['t3-a', 't3-b'], '2026-10-15T12:00:03Z');
      await register(['t0-a', 't0-b'], '2026-10-15T12:00:00Z');

      for (const limit of [1, 4, 7, 17, 100]) {
        const pages = await readAllPages(limit);
        const all = pages.flat();
        expect(all).toEqual(await expectedOrder());
        expect(new Set(all).size).toBe(17);
        expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
      }
    });

    it('nextCursor is null on the last page, and an exact fit has no empty extra page', async () => {
      await register(['a', 'b', 'c', 'd'], '2026-10-15T12:00:00Z');
      const first = await as().get('/users?limit=2');
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await as().get(`/users?limit=2&cursor=${first.body.nextCursor}`);
      expect(second.body.data).toHaveLength(2);
      expect(second.body.nextCursor).toBeNull();
    });

    it('defaults to 20 per page', async () => {
      await register(Array.from({ length: 21 }, (_, i) => `u${i}`), '2026-10-15T12:00:00Z');
      const res = await as().get('/users');
      expect(res.body.data).toHaveLength(20);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it('a user created mid-walk shows up on a later page, nothing is repeated', async () => {
      await register(['a', 'b', 'c'], '2026-10-15T12:00:00Z');
      const first = await as().get('/users?limit=2');
      await register(['d'], '2026-10-15T12:00:05Z');
      const second = await as().get(`/users?limit=2&cursor=${first.body.nextCursor}`);
      const seen = [...first.body.data, ...second.body.data].map((u: { externalUserId: string }) => u.externalUserId);
      expect(seen.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('empty account → empty page', async () => {
      expect((await as().get('/users')).body).toEqual({ data: [], nextCursor: null });
    });

    it.each(['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'cursor=garbage', 'cursor='])('?%s → 400', async (q) => {
      expectError(await as().get(`/users?${q}`), 400, 'VALIDATION_ERROR');
    });

    it("never lists another account's users, even with a cursor positioned among them", async () => {
      await register(['mine-1', 'mine-2'], '2026-10-15T12:00:00Z');
      const other = await signUp(app, 'other');
      current = new Date('2026-10-15T12:00:01Z');
      await request(app).post('/users').set('X-API-Key', other.apiKey).send({ externalUserId: 'theirs' });
      const [theirs] = await testDb.db.select().from(users).where(eq(users.externalUserId, 'theirs'));

      const names = (await as().get('/users')).body.data.map((u: { externalUserId: string }) => u.externalUserId);
      expect(names.sort()).toEqual(['mine-1', 'mine-2']);

      const cursor = encodeCursor({ createdAt: new Date('2026-10-15T11:00:00Z'), id: theirs!.id });
      const page = await as().get(`/users?cursor=${cursor}`);
      expect(page.body.data.map((u: { externalUserId: string }) => u.externalUserId)).not.toContain('theirs');
    });
  });
});
