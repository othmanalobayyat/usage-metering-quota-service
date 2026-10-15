import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accounts, accountUsage } from '../src/db/schema.js';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { hashApiKey } from '../src/lib/api-key.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

const NOW = new Date('2026-10-15T12:00:00Z');

describe.skipIf(!(await dbAvailable()))('accounts and auth', () => {
  let testDb: TestDb;
  let app: Express;

  beforeAll(() => {
    testDb = createTestDb();
    app = createTestApp(testDb, () => NOW);
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
  });

  afterAll(async () => {
    await testDb.close();
  });

  describe('POST /accounts', () => {
    it('creates an account on Starter and returns the plaintext key once', async () => {
      const res = await request(app).post('/accounts').send({ name: 'Acme' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: expect.any(String),
        name: 'Acme',
        apiKey: expect.stringMatching(/^mk_/),
        plan: { id: PREDEFINED_PLAN_IDS.STARTER, name: 'Starter', type: 'ACCOUNT', predefined: true },
        usage: { month: '2026-10', consumed: 0, remaining: 10_000 },
        createdAt: NOW.toISOString(),
      });

      // Only the SHA-256 is stored, never the key itself.
      const [row] = await testDb.db.select().from(accounts).where(eq(accounts.id, res.body.id));
      expect(row!.apiKeyHash).toBe(hashApiKey(res.body.apiKey));
      expect(JSON.stringify(row)).not.toContain(res.body.apiKey);

      // The key is never returned again.
      const me = await request(app).get('/account').set('X-API-Key', res.body.apiKey);
      expect(me.status).toBe(200);
      expect(me.body).not.toHaveProperty('apiKey');
    });

    it.each([{}, { name: '' }, { name: '   ' }, { name: 42 }, { name: 'x'.repeat(201) }, { name: 'ok', extra: 1 }, []])(
      'rejects body %j with 400',
      async (body) => {
        expectError(await request(app).post('/accounts').send(body), 400, 'VALIDATION_ERROR');
      },
    );

    it.each([
      ['Pro', { planId: PREDEFINED_PLAN_IDS.PRO }],
      ['Starter', { planId: PREDEFINED_PLAN_IDS.STARTER }],
      ['a user plan', { planId: PREDEFINED_PLAN_IDS.BASIC }],
      ['null', { planId: null }],
    ])('planId (%s) → 400, and no account is created', async (_label, extra) => {
      const res = await request(app).post('/accounts').send({ name: 'Acme', ...extra });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(await testDb.db.$count(accounts)).toBe(0);
    });

    it('a new account is always on Starter, whatever plans other accounts are on', async () => {
      const first = await signUp(app, 'first');
      await request(app).put('/account/plan').set('X-API-Key', first.apiKey).send({ planId: PREDEFINED_PLAN_IDS.PRO });
      const custom = await createCustomPlan(app, first.apiKey, { name: 'Team', type: 'ACCOUNT' });
      await request(app).put('/account/plan').set('X-API-Key', first.apiKey).send({ planId: custom });

      for (const name of ['second', 'third']) {
        const res = await request(app).post('/accounts').send({ name });
        expect(res.status).toBe(201);
        expect(res.body.plan).toMatchObject({ id: PREDEFINED_PLAN_IDS.STARTER, name: 'Starter' });
        const [row] = await testDb.db.select().from(accounts).where(eq(accounts.id, res.body.id));
        expect(row!.planId).toBe(PREDEFINED_PLAN_IDS.STARTER);
        const me = await request(app).get('/account').set('X-API-Key', res.body.apiKey);
        expect(me.body.plan.id).toBe(PREDEFINED_PLAN_IDS.STARTER);
      }
    });

    it('issues a different key to every account', async () => {
      const a = await signUp(app, 'a');
      const b = await signUp(app, 'b');
      expect(a.apiKey).not.toBe(b.apiKey);
    });
  });

  describe('auth', () => {
    it('the key from POST /accounts works on GET /account', async () => {
      const { id, apiKey } = await signUp(app, 'Acme');
      const res = await request(app).get('/account').set('X-API-Key', apiKey);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, name: 'Acme' });
    });

    it('missing key → 401', async () => {
      expectError(await request(app).get('/account'), 401, 'UNAUTHORIZED');
    });

    it('invalid key → 401', async () => {
      const { apiKey } = await signUp(app);
      expectError(await request(app).get('/account').set('X-API-Key', 'mk_not-a-real-key'), 401, 'UNAUTHORIZED');
      expectError(await request(app).get('/account').set('X-API-Key', `${apiKey}x`), 401, 'UNAUTHORIZED');
      expectError(await request(app).get('/account').set('X-API-Key', apiKey.toUpperCase()), 401, 'UNAUTHORIZED');
    });

    it('identifies each account by its own key', async () => {
      const a = await signUp(app, 'a');
      const b = await signUp(app, 'b');
      expect((await request(app).get('/account').set('X-API-Key', a.apiKey)).body.id).toBe(a.id);
      expect((await request(app).get('/account').set('X-API-Key', b.apiKey)).body.id).toBe(b.id);
    });
  });

  describe('GET /account', () => {
    it("reports this month's usage from the usage row", async () => {
      const { id, apiKey } = await signUp(app);
      await testDb.db.insert(accountUsage).values([
        { accountId: id, month: '2026-10-01', unitsUsed: 2_500, updatedAt: NOW },
        { accountId: id, month: '2026-09-01', unitsUsed: 9_999, updatedAt: NOW },
      ]);
      const res = await request(app).get('/account').set('X-API-Key', apiKey);
      expect(res.body.usage).toEqual({ month: '2026-10', consumed: 2_500, remaining: 7_500 });
      expect(res.body.plan).toMatchObject({ monthlyLimit: 10_000, perRequestLimit: 100 });
    });

    it('treats a missing usage row as 0 and does not create one', async () => {
      const { apiKey } = await signUp(app);
      const res = await request(app).get('/account').set('X-API-Key', apiKey);
      expect(res.body.usage).toEqual({ month: '2026-10', consumed: 0, remaining: 10_000 });
      expect(await testDb.db.$count(accountUsage)).toBe(0);
    });

    it('never reports negative remaining', async () => {
      const { id, apiKey } = await signUp(app);
      await testDb.db.insert(accountUsage).values({ accountId: id, month: '2026-10-01', unitsUsed: 12_000, updatedAt: NOW });
      const res = await request(app).get('/account').set('X-API-Key', apiKey);
      expect(res.body.usage).toEqual({ month: '2026-10', consumed: 12_000, remaining: 0 });
    });
  });

  describe('PUT /account/plan', () => {
    it('switches to a predefined account plan and keeps usage', async () => {
      const { id, apiKey } = await signUp(app);
      await testDb.db.insert(accountUsage).values({ accountId: id, month: '2026-10-01', unitsUsed: 300, updatedAt: NOW });
      const res = await request(app).put('/account/plan').set('X-API-Key', apiKey).send({ planId: PREDEFINED_PLAN_IDS.PRO });
      expect(res.status).toBe(200);
      expect(res.body.plan).toMatchObject({ id: PREDEFINED_PLAN_IDS.PRO, monthlyLimit: 100_000 });
      expect(res.body.usage).toEqual({ month: '2026-10', consumed: 300, remaining: 99_700 });
    });

    it("switches to the account's own custom ACCOUNT plan", async () => {
      const { apiKey } = await signUp(app);
      const planId = await createCustomPlan(app, apiKey, { name: 'Tiny', type: 'ACCOUNT', monthlyLimit: 200, perRequestLimit: 50 });
      const res = await request(app).put('/account/plan').set('X-API-Key', apiKey).send({ planId });
      expect(res.status).toBe(200);
      expect(res.body.plan).toMatchObject({ id: planId, name: 'Tiny', predefined: false });
    });

    it('wrong plan type → 400, predefined or custom', async () => {
      const { apiKey } = await signUp(app);
      const userPlan = await createCustomPlan(app, apiKey, { name: 'U', type: 'USER' });
      for (const planId of [PREDEFINED_PLAN_IDS.BASIC, userPlan]) {
        const res = await request(app).put('/account/plan').set('X-API-Key', apiKey).send({ planId });
        expectError(res, 400, 'VALIDATION_ERROR');
      }
      expect((await request(app).get('/account').set('X-API-Key', apiKey)).body.plan.name).toBe('Starter');
    });

    it('missing or malformed planId → 400', async () => {
      const { apiKey } = await signUp(app);
      for (const body of [{}, { planId: null }, { planId: 'starter' }]) {
        expectError(await request(app).put('/account/plan').set('X-API-Key', apiKey).send(body), 400, 'VALIDATION_ERROR');
      }
    });

    it('unknown planId → 404', async () => {
      const { apiKey } = await signUp(app);
      const res = await request(app)
        .put('/account/plan')
        .set('X-API-Key', apiKey)
        .send({ planId: '11111111-1111-4111-8111-111111111111' });
      expectError(res, 404, 'NOT_FOUND');
    });
  });
});
