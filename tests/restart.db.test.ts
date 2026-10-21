import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { createTestDb, dbAvailable, resetDatabase, TEST_DATABASE_URL, type TestDb } from './helpers/db.js';
import { freePort, startTs, stopAll } from './helpers/process.js';

// docs/TEST_PLAN.md TP-PERS-01: everything a caller wrote survives an API restart, because it is
// all in PostgreSQL. Two real server processes against quota_test, one after the other. A restart
// of PostgreSQL itself or of the Compose stack (TP-PERS-02) is not covered here.

async function startApi(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const server = startTs('src/server.ts', { DATABASE_URL: TEST_DATABASE_URL, PORT: String(port), WORKERS: '1' });
  await server.waitFor(new RegExp(`quota-service listening on port ${port}\\n`));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      server.child.kill('SIGTERM');
      expect(await server.exited).toEqual({ code: 0, signal: null });
    },
  };
}

afterEach(stopAll);

describe.skipIf(!(await dbAvailable()))('restart persistence (TP-PERS-01)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = createTestDb();
    await resetDatabase(testDb.pool);
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('a new server process sees every account, plan, user, usage row and decision, and replays', async () => {
    const first = await startApi();
    const call = async (url: string, method: string, path: string, key?: string, body?: unknown) => {
      const headers: Record<string, string> = {};
      if (key) headers['X-API-Key'] = key;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };

    const account = await call(first.url, 'POST', '/accounts', undefined, { name: 'Persist Co' });
    expect(account.status).toBe(201);
    const key = account.body.apiKey as string;
    const plan = await call(first.url, 'POST', '/plans', key, { name: 'Member', type: 'USER', monthlyLimit: 100, perRequestLimit: 20 });
    expect(plan.status).toBe(201);
    expect((await call(first.url, 'POST', '/users', key, { externalUserId: 'alice', planId: plan.body.id })).status).toBe(201);
    expect((await call(first.url, 'POST', '/users', key, { externalUserId: 'bob', planId: PREDEFINED_PLAN_IDS.PREMIUM })).status).toBe(201);
    expect((await call(first.url, 'PUT', '/account/plan', key, { planId: PREDEFINED_PLAN_IDS.PRO })).status).toBe(200);
    const p1 = await call(first.url, 'POST', '/consume', key, { externalUserId: 'alice', units: 10, requestId: 'p-1' });
    const p2 = await call(first.url, 'POST', '/consume', key, { externalUserId: 'alice', units: 25, requestId: 'p-2' });
    expect(p1.body).toMatchObject({ status: 'ACCEPTED', replayed: false });
    expect(p2.body).toMatchObject({ status: 'REJECTED', rejectedBy: 'USER', reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED', replayed: false });

    const reads = ['/account', '/users/alice', '/users/bob', '/plans', '/users', '/requests', '/usage', '/users/alice/usage'];
    const before = await Promise.all(reads.map((path) => call(first.url, 'GET', path, key)));
    for (const res of before) expect(res.status).toBe(200);

    await first.stop();
    const second = await startApi();

    // The same key still authenticates, and every read is identical.
    const after = await Promise.all(reads.map((path) => call(second.url, 'GET', path, key)));
    expect(after).toEqual(before);
    expect(after[0]!.body).toMatchObject({ plan: { id: PREDEFINED_PLAN_IDS.PRO }, usage: { consumed: 10 } });
    expect(after[1]!.body).toMatchObject({ plan: { id: plan.body.id }, usage: { consumed: 10, remaining: 90 } });
    expect(after[2]!.body).toMatchObject({ plan: { id: PREDEFINED_PLAN_IDS.PREMIUM } });
    expect(after[3]!.body.data.map((p: { id: string }) => p.id)).toContain(plan.body.id);
    expect(after[5]!.body.data.map((e: { requestId: string }) => e.requestId)).toEqual(['p-2', 'p-1']);

    // Retries after the restart are answered from the stored decisions.
    for (const [original, units, requestId] of [[p1, 10, 'p-1'], [p2, 25, 'p-2']] as const) {
      const replay = await call(second.url, 'POST', '/consume', key, { externalUserId: 'alice', units, requestId });
      expect(replay).toEqual({ status: 200, body: { ...original.body, replayed: true } });
    }

    const { rows } = await testDb.pool.query<{ violations: number }>(`
      with u as (select account_id, month, sum(units_used) as units from user_usage group by 1, 2)
      select count(*)::int as violations from account_usage a full join u using (account_id, month)
      where coalesce(a.units_used, 0) <> coalesce(u.units, 0)`);
    expect(rows[0]!.violations).toBe(0);
    await second.stop();
  }, 60_000);
});
