import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

const MAX_INT32 = 2_147_483_647;

describe.skipIf(!(await dbAvailable()))('plans', () => {
  let testDb: TestDb;
  let app: Express;
  let current: Date;
  let apiKey: string;

  beforeAll(() => {
    testDb = createTestDb();
    app = createTestApp(testDb, () => current);
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
    current = new Date('2026-10-15T12:00:00Z');
    ({ apiKey } = await signUp(app));
  });

  afterAll(async () => {
    await testDb.close();
  });

  const as = () => ({
    get: (path: string) => request(app).get(path).set('X-API-Key', apiKey),
    post: (path: string, body: object) => request(app).post(path).set('X-API-Key', apiKey).send(body),
    patch: (path: string, body: object) => request(app).patch(path).set('X-API-Key', apiKey).send(body),
  });

  describe('POST /plans', () => {
    it('creates a custom plan owned by the account', async () => {
      const res = await as().post('/plans', { name: 'Team', type: 'ACCOUNT', monthlyLimit: 200, perRequestLimit: 50 });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        name: 'Team',
        type: 'ACCOUNT',
        monthlyLimit: 200,
        perRequestLimit: 50,
        predefined: false,
        createdAt: current.toISOString(),
        updatedAt: current.toISOString(),
      });
    });

    it('accepts the boundary values 0 and 2147483647', async () => {
      const res = await as().post('/plans', { name: 'Edge', type: 'USER', monthlyLimit: 0, perRequestLimit: MAX_INT32 });
      expect(res.status).toBe(201);
      const big = await as().post('/plans', { name: 'Big', type: 'USER', monthlyLimit: MAX_INT32, perRequestLimit: 1 });
      expect(big.status).toBe(201);
    });

    it.each([
      { name: 'x', type: 'ACCOUNT', monthlyLimit: MAX_INT32 + 1, perRequestLimit: 1 },
      { name: 'x', type: 'ACCOUNT', monthlyLimit: 10, perRequestLimit: MAX_INT32 + 1 },
      { name: 'x', type: 'ACCOUNT', monthlyLimit: -1, perRequestLimit: 1 },
      { name: 'x', type: 'ACCOUNT', monthlyLimit: 10, perRequestLimit: 0 },
      { name: 'x', type: 'ACCOUNT', monthlyLimit: 1.5, perRequestLimit: 1 },
      { name: 'x', type: 'ACCOUNT', monthlyLimit: '10', perRequestLimit: 1 },
      { name: 'x', type: 'BOTH', monthlyLimit: 10, perRequestLimit: 1 },
      { name: '', type: 'ACCOUNT', monthlyLimit: 10, perRequestLimit: 1 },
      { type: 'ACCOUNT', monthlyLimit: 10, perRequestLimit: 1 },
      { name: 'x', type: 'ACCOUNT', monthlyLimit: 10, perRequestLimit: 1, accountId: null },
    ])('rejects %j with 400', async (body) => {
      expectError(await as().post('/plans', body), 400, 'VALIDATION_ERROR');
    });

    it('duplicate name within the account → 409 ALREADY_EXISTS', async () => {
      await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
      const res = await as().post('/plans', { name: 'Team', type: 'USER', monthlyLimit: 1, perRequestLimit: 1 });
      expectError(res, 409, 'ALREADY_EXISTS');
    });

    it('the same name is fine in another account', async () => {
      await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
      const other = await signUp(app, 'other');
      await createCustomPlan(app, other.apiKey, { name: 'Team', type: 'ACCOUNT' });
    });
  });

  describe('GET /plans', () => {
    it('lists predefined plans first, then own custom plans', async () => {
      const team = await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
      const res = await as().get('/plans');
      expect(res.status).toBe(200);
      expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([
        PREDEFINED_PLAN_IDS.STARTER,
        PREDEFINED_PLAN_IDS.PRO,
        PREDEFINED_PLAN_IDS.BASIC,
        PREDEFINED_PLAN_IDS.PREMIUM,
        team,
      ]);
      expect(res.body.data[0]).toMatchObject({ name: 'Starter', monthlyLimit: 10_000, perRequestLimit: 100, predefined: true });
    });

    it('filters by ?type=', async () => {
      await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
      await createCustomPlan(app, apiKey, { name: 'Member', type: 'USER' });
      const users = await as().get('/plans?type=USER');
      expect(users.body.data.map((p: { name: string }) => p.name)).toEqual(['Basic', 'Premium', 'Member']);
      const accts = await as().get('/plans?type=ACCOUNT');
      expect(accts.body.data.map((p: { name: string }) => p.name)).toEqual(['Starter', 'Pro', 'Team']);
    });

    it('invalid ?type= → 400', async () => {
      expectError(await as().get('/plans?type=user'), 400, 'VALIDATION_ERROR');
      expectError(await as().get('/plans?type=USER&type=ACCOUNT'), 400, 'VALIDATION_ERROR');
    });
  });

  describe('GET /plans/:id', () => {
    it('returns a predefined plan and an own custom plan', async () => {
      expect((await as().get(`/plans/${PREDEFINED_PLAN_IDS.PREMIUM}`)).body).toMatchObject({
        name: 'Premium',
        type: 'USER',
        monthlyLimit: 5_000,
        perRequestLimit: 100,
      });
      const id = await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
      expect((await as().get(`/plans/${id}`)).body).toMatchObject({ id, name: 'Team' });
    });

    it('unknown or malformed id → 404', async () => {
      expectError(await as().get('/plans/11111111-1111-4111-8111-111111111111'), 404, 'NOT_FOUND');
      expectError(await as().get('/plans/not-a-uuid'), 404, 'NOT_FOUND');
    });
  });

  describe('PATCH /plans/:id', () => {
    it('updates an own custom plan and bumps updatedAt only', async () => {
      const id = await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT', monthlyLimit: 200, perRequestLimit: 50 });
      const created = current.toISOString();
      current = new Date('2026-10-16T08:00:00Z');

      const res = await as().patch(`/plans/${id}`, { monthlyLimit: 500 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        name: 'Team',
        type: 'ACCOUNT',
        monthlyLimit: 500,
        perRequestLimit: 50,
        createdAt: created,
        updatedAt: current.toISOString(),
      });
      expect((await as().get(`/plans/${id}`)).body.monthlyLimit).toBe(500);
    });

    it('renames, and a rename onto an existing name → 409', async () => {
      const id = await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
      await createCustomPlan(app, apiKey, { name: 'Other', type: 'ACCOUNT' });
      expect((await as().patch(`/plans/${id}`, { name: 'Renamed' })).body.name).toBe('Renamed');
      expectError(await as().patch(`/plans/${id}`, { name: 'Other' }), 409, 'ALREADY_EXISTS');
    });

    it('PATCH predefined plan → 403', async () => {
      for (const id of Object.values(PREDEFINED_PLAN_IDS)) {
        expectError(await as().patch(`/plans/${id}`, { monthlyLimit: 1 }), 403, 'FORBIDDEN');
      }
      expect((await as().get(`/plans/${PREDEFINED_PLAN_IDS.STARTER}`)).body.monthlyLimit).toBe(10_000);
    });

    it('type is not updatable → 400', async () => {
      const id = await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
      expectError(await as().patch(`/plans/${id}`, { type: 'USER' }), 400, 'VALIDATION_ERROR');
      expect((await as().get(`/plans/${id}`)).body.type).toBe('ACCOUNT');
    });

    it.each([{}, { monthlyLimit: -1 }, { perRequestLimit: 0 }, { monthlyLimit: MAX_INT32 + 1 }, { name: '' }])(
      'rejects %j with 400',
      async (body) => {
        const id = await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
        expectError(await as().patch(`/plans/${id}`, body), 400, 'VALIDATION_ERROR');
      },
    );

    it('unknown id → 404', async () => {
      expectError(await as().patch('/plans/11111111-1111-4111-8111-111111111111', { monthlyLimit: 1 }), 404, 'NOT_FOUND');
    });

    // The plan is looked up before the body is validated, so the body can't change the answer.
    const invalidBodies = [{}, { type: 'USER' }, { monthlyLimit: -1 }, { perRequestLimit: 0 }, { name: '' }, { bogus: true }];

    it.each(invalidBodies)('predefined plan with invalid body %j → 403', async (body) => {
      for (const id of Object.values(PREDEFINED_PLAN_IDS)) {
        expectError(await as().patch(`/plans/${id}`, body), 403, 'FORBIDDEN');
      }
      expect((await as().get(`/plans/${PREDEFINED_PLAN_IDS.STARTER}`)).body).toMatchObject({
        type: 'ACCOUNT',
        monthlyLimit: 10_000,
        perRequestLimit: 100,
      });
    });

    it.each(invalidBodies)('unknown plan with invalid body %j → 404', async (body) => {
      expectError(await as().patch('/plans/11111111-1111-4111-8111-111111111111', body), 404, 'NOT_FOUND');
      expectError(await as().patch('/plans/not-a-uuid', body), 404, 'NOT_FOUND');
    });

    it('predefined plan with a malformed JSON body → 400 (body parsing runs before the route)', async () => {
      const res = await request(app)
        .patch(`/plans/${PREDEFINED_PLAN_IDS.STARTER}`)
        .set('X-API-Key', apiKey)
        .set('Content-Type', 'application/json')
        .send('{"monthlyLimit": ');
      expectError(res, 400, 'VALIDATION_ERROR');
    });
  });

  describe('DELETE /plans/:id', () => {
    it('does not exist: custom and predefined plans → 404, and the plan remains', async () => {
      const id = await createCustomPlan(app, apiKey, { name: 'Team', type: 'ACCOUNT' });
      for (const target of [id, PREDEFINED_PLAN_IDS.STARTER]) {
        expectError(await request(app).delete(`/plans/${target}`).set('X-API-Key', apiKey), 404, 'NOT_FOUND');
        expect((await as().get(`/plans/${target}`)).status).toBe(200);
      }
    });
  });
});
