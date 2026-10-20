import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, accountUsage, plans, requests, users, userUsage } from '../src/db/schema.js';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

// `.` and `..` as externalUserId are rejected like any other invalid ID: 400 in a body or query,
// 404 in a URL path. Schema and client URL tests: tests/dot-segment-ids.test.ts.

const DOT_SEGMENTS = ['.', '..'];
const MESSAGE = 'externalUserId: must not be "." or ".."';

describe.skipIf(!(await dbAvailable()))('externalUserId "." and ".."', () => {
  let testDb: TestDb;
  let app: Express;
  let current: Date;
  let accountId: string;
  let apiKey: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    testDb = createTestDb();
    app = createTestApp(testDb, () => current);
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
    current = new Date('2026-10-15T12:00:00Z');
    ({ id: accountId, apiKey } = await signUp(app));
    expect((await as().post('/users', { externalUserId: 'alice' })).status).toBe(201);
    consoleError = vi.spyOn(console, 'error');
  });

  afterAll(async () => {
    await testDb.close();
  });

  // Supertest (superagent) sends dot segments as written, so these paths reach the router unresolved.
  const as = () => ({
    get: (path: string) => request(app).get(path).set('X-API-Key', apiKey),
    post: (path: string, body: object) => request(app).post(path).set('X-API-Key', apiKey).send(body),
    put: (path: string, body: object) => request(app).put(path).set('X-API-Key', apiKey).send(body),
  });

  /** Nothing reached the 500 branch, which logs `unhandled error`. */
  function expectNoUnhandledError() {
    expect(consoleError).not.toHaveBeenCalled();
  }

  /** A user row written directly, as one registered before the rule would be. The rule is only in validation. */
  async function insertLegacyUser(externalUserId: string) {
    await testDb.db
      .insert(users)
      .values({ accountId, externalUserId, planId: PREDEFINED_PLAN_IDS.BASIC, createdAt: current });
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

  describe.each(DOT_SEGMENTS)('%j', (id) => {
    it('POST /users → 400 and no user created', async () => {
      const before = await counts();
      const res = await as().post('/users', { externalUserId: id });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.message).toBe(MESSAGE);
      expect(await counts()).toEqual(before);
      expectNoUnhandledError();
    });

    it('POST /consume → 400 and nothing written', async () => {
      const before = await counts();
      const res = await as().post('/consume', { externalUserId: id, units: 1, requestId: 'r1' });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.message).toBe(MESSAGE);
      expect(await counts()).toEqual(before);
      expectNoUnhandledError();
    });

    it('GET /requests?externalUserId= → 400', async () => {
      const res = await as().get(`/requests?externalUserId=${id}`);
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.message).toBe(MESSAGE);
      expectNoUnhandledError();
    });

    // A user with this ID is stored first (as if registered before the rule), so a 404 comes from
    // the rule and not from a missing user. The message proves the user routes ran: a resolved path
    // would be "Route … not found", or, for /users/../usage, a 200 from GET /usage.
    it.each([id, id.replaceAll('.', '%2E'), id.replaceAll('.', '%2e')])(
      'path segment %s on GET /users/:id, /usage and PUT /plan → 404 User not found, even if stored',
      async (segment) => {
        await insertLegacyUser(id);
        for (const res of [
          await as().get(`/users/${segment}`),
          await as().get(`/users/${segment}/usage`),
          await as().put(`/users/${segment}/plan`, { planId: PREDEFINED_PLAN_IDS.PREMIUM }),
        ]) {
          expectError(res, 404, 'NOT_FOUND');
          expect(res.body.error.message).toBe('User not found');
        }
        const [stored] = await testDb.db.select().from(users).where(eq(users.externalUserId, id));
        expect(stored!.planId).toBe(PREDEFINED_PLAN_IDS.BASIC);
        expectNoUnhandledError();
      },
    );
  });

  it('look-alike IDs ("...", "a.b", ".alice", "%2E%2E") are still registered, addressed and charged', async () => {
    for (const id of ['...', 'a.b', '.alice', '%2E%2E']) {
      expect((await as().post('/users', { externalUserId: id })).status).toBe(201);
      const path = `/users/${encodeURIComponent(id)}`;
      expect((await as().get(path)).body.externalUserId).toBe(id);
      expect((await as().put(`${path}/plan`, { planId: PREDEFINED_PLAN_IDS.PREMIUM })).status).toBe(200);
      const consume = await as().post('/consume', { externalUserId: id, units: 2, requestId: `r-${id}` });
      expect(consume.body).toMatchObject({ status: 'ACCEPTED', replayed: false });
      expect((await as().get(`${path}/usage`)).body.consumed).toBe(2);
    }
    expect((await as().get('/usage')).body.consumed).toBe(8);
    expectNoUnhandledError();
  });

  it('a ".." user stored before the rule is listed but can no longer be addressed or charged', async () => {
    await insertLegacyUser('..');

    const list = await as().get('/users');
    expect(list.body.data.map((u: { externalUserId: string }) => u.externalUserId).sort()).toEqual(['..', 'alice']);

    expectError(await as().get('/users/..'), 404, 'NOT_FOUND');
    const consume = await as().post('/consume', { externalUserId: '..', units: 1, requestId: 'r1' });
    expectError(consume, 400, 'VALIDATION_ERROR');
    expect(await testDb.db.$count(users)).toBe(2);
    expect(await testDb.db.$count(requests)).toBe(0);
    expectNoUnhandledError();
  });
});
