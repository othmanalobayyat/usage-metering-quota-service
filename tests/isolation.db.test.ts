import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

/**
 * Account B must not see or touch anything of account A's. Every case answers 404 (never 403),
 * so B can't even learn that A's resource exists.
 */
describe.skipIf(!(await dbAvailable()))('account isolation', () => {
  let testDb: TestDb;
  let app: Express;
  let a: { id: string; apiKey: string };
  let b: { id: string; apiKey: string };
  let aAccountPlan: string;
  let aUserPlan: string;

  beforeAll(() => {
    testDb = createTestDb();
    app = createTestApp(testDb);
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
    a = await signUp(app, 'A');
    b = await signUp(app, 'B');
    aAccountPlan = await createCustomPlan(app, a.apiKey, { name: 'A team', type: 'ACCOUNT' });
    aUserPlan = await createCustomPlan(app, a.apiKey, { name: 'A member', type: 'USER' });
    await request(app).post('/users').set('X-API-Key', a.apiKey).send({ externalUserId: 'alice', planId: aUserPlan });
    await request(app).post('/users').set('X-API-Key', b.apiKey).send({ externalUserId: 'bob' });
  });

  afterAll(async () => {
    await testDb.close();
  });

  const asB = () => ({
    get: (path: string) => request(app).get(path).set('X-API-Key', b.apiKey),
    put: (path: string, body: object) => request(app).put(path).set('X-API-Key', b.apiKey).send(body),
    post: (path: string, body: object) => request(app).post(path).set('X-API-Key', b.apiKey).send(body),
    patch: (path: string, body: object) => request(app).patch(path).set('X-API-Key', b.apiKey).send(body),
  });

  describe("A's users", () => {
    it('GET /users/:externalUserId → 404', async () => {
      expectError(await asB().get('/users/alice'), 404, 'NOT_FOUND');
    });

    it('PUT /users/:externalUserId/plan → 404, and alice is unchanged', async () => {
      expectError(await asB().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM }), 404, 'NOT_FOUND');
      const alice = await request(app).get('/users/alice').set('X-API-Key', a.apiKey);
      expect(alice.body.plan.id).toBe(aUserPlan);
    });

    it("GET /users doesn't list them", async () => {
      const res = await asB().get('/users');
      expect(res.body.data.map((u: { externalUserId: string }) => u.externalUserId)).toEqual(['bob']);
    });

    it('the same externalUserId can be registered in B independently', async () => {
      expect((await asB().post('/users', { externalUserId: 'alice' })).status).toBe(201);
      expect((await asB().get('/users/alice')).body.plan.name).toBe('Basic');
      expect((await request(app).get('/users/alice').set('X-API-Key', a.apiKey)).body.plan.id).toBe(aUserPlan);
    });
  });

  describe("A's custom plans", () => {
    it('GET /plans/:id → 404', async () => {
      expectError(await asB().get(`/plans/${aAccountPlan}`), 404, 'NOT_FOUND');
      expectError(await asB().get(`/plans/${aUserPlan}`), 404, 'NOT_FOUND');
    });

    it('PATCH /plans/:id → 404 (not 403), and the plan is unchanged', async () => {
      expectError(await asB().patch(`/plans/${aAccountPlan}`, { monthlyLimit: 1 }), 404, 'NOT_FOUND');
      const plan = await request(app).get(`/plans/${aAccountPlan}`).set('X-API-Key', a.apiKey);
      expect(plan.body.monthlyLimit).toBe(200);
    });

    it('PATCH /plans/:id with an invalid body is still 404 (existence is checked first)', async () => {
      for (const body of [{}, { type: 'USER' }, { monthlyLimit: -1 }]) {
        expectError(await asB().patch(`/plans/${aAccountPlan}`, body), 404, 'NOT_FOUND');
      }
    });

    it('PATCH /plans/:id renaming onto A\'s plan name is not a conflict for B', async () => {
      const own = await createCustomPlan(app, b.apiKey, { name: 'B team', type: 'ACCOUNT' });
      const res = await asB().patch(`/plans/${own}`, { name: 'A team' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('A team');
    });

    it("GET /plans doesn't list them", async () => {
      const res = await asB().get('/plans');
      const ids = res.body.data.map((p: { id: string }) => p.id);
      expect(ids).not.toContain(aAccountPlan);
      expect(ids).not.toContain(aUserPlan);
      expect(ids).toEqual(Object.values(PREDEFINED_PLAN_IDS));
    });

    it("PUT /account/plan with A's custom ACCOUNT plan → 404", async () => {
      expectError(await asB().put('/account/plan', { planId: aAccountPlan }), 404, 'NOT_FOUND');
      expect((await asB().get('/account')).body.plan.id).toBe(PREDEFINED_PLAN_IDS.STARTER);
    });

    it("PUT /users/:externalUserId/plan with A's custom USER plan → 404", async () => {
      expectError(await asB().put('/users/bob/plan', { planId: aUserPlan }), 404, 'NOT_FOUND');
      expect((await asB().get('/users/bob')).body.plan.id).toBe(PREDEFINED_PLAN_IDS.BASIC);
    });

    it("A's plan of the wrong type is still 404, not 400 (ownership is checked first)", async () => {
      expectError(await asB().put('/account/plan', { planId: aUserPlan }), 404, 'NOT_FOUND');
      expectError(await asB().put('/users/bob/plan', { planId: aAccountPlan }), 404, 'NOT_FOUND');
    });

    it("POST /users with A's custom USER plan → 404", async () => {
      expectError(await asB().post('/users', { externalUserId: 'carol', planId: aUserPlan }), 404, 'NOT_FOUND');
    });

    it('B may reuse the same plan name', async () => {
      expect((await asB().post('/plans', { name: 'A team', type: 'ACCOUNT', monthlyLimit: 1, perRequestLimit: 1 })).status).toBe(201);
    });
  });

  it("GET /account returns only the caller's own account", async () => {
    expect((await asB().get('/account')).body).toMatchObject({ id: b.id, name: 'B' });
  });
});
