import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, accountUsage, plans, requests, users, userUsage } from '../src/db/schema.js';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

const NUL = '\u0000';

// Inputs PostgreSQL or the router can't take must be a 4xx in the standard shape, never a 500.
describe.skipIf(!(await dbAvailable()))('input encoding', () => {
  let testDb: TestDb;
  let app: Express;
  let current: Date;
  let apiKey: string;
  let customPlanId: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    testDb = createTestDb();
    app = createTestApp(testDb, () => current);
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
    current = new Date('2026-10-15T12:00:00Z');
    ({ apiKey } = await signUp(app));
    customPlanId = await createCustomPlan(app, apiKey, { name: 'Custom', type: 'USER' });
    expect((await as().post('/users', { externalUserId: 'alice' })).status).toBe(201);
    consoleError = vi.spyOn(console, 'error');
  });

  afterAll(async () => {
    await testDb.close();
  });

  const as = () => ({
    get: (path: string) => request(app).get(path).set('X-API-Key', apiKey),
    post: (path: string, body: object) => request(app).post(path).set('X-API-Key', apiKey).send(body),
    put: (path: string, body: object) => request(app).put(path).set('X-API-Key', apiKey).send(body),
    patch: (path: string, body: object) => request(app).patch(path).set('X-API-Key', apiKey).send(body),
  });

  /** Nothing reached the 500 branch, which logs `unhandled error`. */
  function expectNoUnhandledError() {
    expect(consoleError).not.toHaveBeenCalled();
  }

  async function counts() {
    return {
      accounts: await testDb.db.$count(accounts),
      plans: await testDb.db.$count(plans),
      users: await testDb.db.$count(users),
      requests: await testDb.db.$count(requests),
      accountUsage: await testDb.db.$count(accountUsage),
      userUsage: await testDb.db.$count(userUsage),
    };
  }

  describe('malformed percent-encoding in a path parameter → 404', () => {
    const malformed = ['%E0%A4%A', '%ZZ', '%', 'alice%'];

    describe.each(malformed)('%s', (param) => {
      it('GET /users/:externalUserId, /usage and PUT /plan → 404 User not found', async () => {
        for (const res of [
          await as().get(`/users/${param}`),
          await as().get(`/users/${param}/usage`),
          await as().put(`/users/${param}/plan`, { planId: PREDEFINED_PLAN_IDS.PREMIUM }),
        ]) {
          expectError(res, 404, 'NOT_FOUND');
          expect(res.body.error.message).toBe('User not found');
        }
        expectNoUnhandledError();
      });

      it('GET and PATCH /plans/:id → 404 Plan not found, and the plan is unchanged', async () => {
        const before = await counts();
        for (const res of [await as().get(`/plans/${param}`), await as().patch(`/plans/${param}`, { name: 'Renamed' })]) {
          expectError(res, 404, 'NOT_FOUND');
          expect(res.body.error.message).toBe('Plan not found');
        }
        expect((await as().get(`/plans/${customPlanId}`)).body.name).toBe('Custom');
        expect(await counts()).toEqual(before);
        expectNoUnhandledError();
      });
    });

    it('auth still runs first: no key → 401', async () => {
      expectError(await request(app).get('/users/%E0%A4%A'), 401, 'UNAUTHORIZED');
      expectError(await request(app).get('/plans/%ZZ'), 401, 'UNAUTHORIZED');
    });

    it('well-formed encodings still resolve', async () => {
      await as().post('/users', { externalUserId: 'user/42 é' });
      const res = await as().get(`/users/${encodeURIComponent('user/42 é')}/usage`);
      expect(res.status).toBe(200);
      expect(res.body.externalUserId).toBe('user/42 é');
      expect((await as().get(`/plans/${customPlanId}`)).status).toBe(200);
    });
  });

  describe('a NUL character in string input', () => {
    it.each([
      ['POST /accounts name', () => request(app).post('/accounts').send({ name: `acme${NUL}` })],
      ['POST /plans name', () => as().post('/plans', { name: `p${NUL}`, type: 'USER', monthlyLimit: 1, perRequestLimit: 1 })],
      ['PATCH /plans/:id name', () => as().patch(`/plans/${customPlanId}`, { name: `p${NUL}` })],
      ['POST /users externalUserId', () => as().post('/users', { externalUserId: `bob${NUL}` })],
      ['POST /users name', () => as().post('/users', { externalUserId: 'bob', name: `Bob${NUL}` })],
      ['POST /consume externalUserId', () => as().post('/consume', { externalUserId: `alice${NUL}`, units: 1, requestId: 'r' })],
      ['POST /consume requestId', () => as().post('/consume', { externalUserId: 'alice', units: 1, requestId: `r${NUL}` })],
      ['POST /consume requestId, NUL only', () => as().post('/consume', { externalUserId: 'alice', units: 1, requestId: NUL })],
    ])('%s → 400 and nothing written', async (_name, send) => {
      const before = await counts();
      const res = await send();
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.message).toContain('must not contain NUL characters');
      expect(await counts()).toEqual(before);
      expect((await as().get(`/plans/${customPlanId}`)).body.name).toBe('Custom');
      expectNoUnhandledError();
    });

    it.each([
      '/requests?externalUserId=alice%00',
      '/requests?cursor=%00',
      '/requests?month=2026-10%00',
      '/usage?month=2026-10%00',
      '/users/alice/usage?month=2026-10%00',
      '/users?cursor=%00',
      '/plans?type=USER%00',
    ])('GET %s → 400', async (path) => {
      expectError(await as().get(path), 400, 'VALIDATION_ERROR');
      expectNoUnhandledError();
    });

    it('in an externalUserId path parameter → 404, like any ID that can never be registered', async () => {
      for (const res of [
        await as().get('/users/alice%00'),
        await as().get('/users/%00/usage'),
        await as().put('/users/alice%00/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM }),
      ]) {
        expectError(res, 404, 'NOT_FOUND');
      }
      expect((await as().get('/users/alice')).body.plan.id).toBe(PREDEFINED_PLAN_IDS.BASIC);
      expectNoUnhandledError();
    });

    it('in a plan ID path parameter → 404', async () => {
      expectError(await as().get(`/plans/${customPlanId}%00`), 404, 'NOT_FOUND');
      expectError(await as().patch(`/plans/${customPlanId}%00`, { name: 'Renamed' }), 404, 'NOT_FOUND');
      expectNoUnhandledError();
    });

    it('other control and non-ASCII characters are still accepted', async () => {
      expect((await request(app).post('/accounts').send({ name: 'Ünïcode ✓' })).status).toBe(201);
      expect((await as().post('/users', { externalUserId: 'bob\u0001é', name: 'Bob\tB' })).status).toBe(201);
      const res = await as().post('/consume', { externalUserId: 'bob\u0001é', units: 1, requestId: 'r\u0001' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACCEPTED');
      expect((await as().get(`/users/${encodeURIComponent('bob\u0001é')}/usage`)).body.consumed).toBe(1);
    });
  });
});
