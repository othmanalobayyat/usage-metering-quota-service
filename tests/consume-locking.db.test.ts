import { eq, sql } from 'drizzle-orm';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountUsage, requests, userUsage } from '../src/db/schema.js';
import { pgErrorOf } from '../src/lib/pg-error.js';
import { createTestApp, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, TEST_DATABASE_URL, type TestDb } from './helpers/db.js';

// The consume transaction's lock order and its behavior when the database fails part-way. These
// tests make no assumption about how the transaction splits its work into statements, only about
// what another session can observe, so they hold for any implementation of PLAN.md §6 Phase 3.

const MONTH = '2026-10-01';

describe.skipIf(!(await dbAvailable()))('consume: lock order and failures inside the transaction', () => {
  let testDb: TestDb;
  let app: Express;
  let account: { id: string; apiKey: string };
  let blocker: pg.Client;
  let probe: pg.Client;

  beforeAll(() => {
    testDb = createTestDb();
    app = createTestApp(testDb, () => new Date('2026-10-15T12:00:00Z'));
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
    account = await signUp(app);
    for (const externalUserId of ['alice', 'bob']) {
      expect((await request(app).post('/users').set('X-API-Key', account.apiKey).send({ externalUserId })).status).toBe(201);
    }
    // Both usage rows exist, so the only waits below are on row locks.
    for (const [i, user] of ['alice', 'bob'].entries()) {
      expect((await consume(user, 1, `warm-${i}`)).body.status).toBe('ACCEPTED');
    }
    blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    probe = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await blocker.connect();
    await probe.connect();
  });

  afterEach(async () => {
    await blocker.query('rollback').catch(() => {});
    await blocker.end();
    await probe.end();
    await testDb.pool.query('drop trigger if exists consume_fault on requests');
    await testDb.pool.query('drop function if exists consume_fault()');
  });

  afterAll(async () => {
    await testDb.close();
  });

  const consume = (externalUserId: string, units: number, requestId: string) =>
    request(app).post('/consume').set('X-API-Key', account.apiKey).send({ externalUserId, units, requestId });

  async function units() {
    const [a] = await testDb.db.select({ n: accountUsage.unitsUsed }).from(accountUsage).where(eq(accountUsage.accountId, account.id));
    const users = await testDb.db.select({ n: userUsage.unitsUsed }).from(userUsage).where(eq(userUsage.accountId, account.id));
    return { account: a?.n ?? 0, users: users.reduce((sum, u) => sum + u.n, 0) };
  }

  /** Waits until a session other than the blocker and probe is blocked on a lock, and returns its pid. */
  async function waitForWaiter(kind: 'Lock' | 'PgSleep'): Promise<number> {
    const mine = [(blocker as unknown as { processID: number }).processID, (probe as unknown as { processID: number }).processID];
    for (let i = 0; i < 300; i++) {
      const { rows } = await testDb.pool.query<{ pid: number }>(
        `select pid from pg_stat_activity
         where datname = current_database() and pid <> all($1::int[])
           and (wait_event_type = $2 or wait_event = $2)`,
        [mine, kind],
      );
      if (rows[0]) return rows[0].pid;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no consume ended up waiting on ${kind}`);
  }

  it('takes the account row before the user row: blocked on the user row, it already holds the account row', async () => {
    await blocker.query('begin');
    await blocker.query(`select 1 from user_usage where account_id = $1 and month = $2 for update`, [account.id, MONTH]);

    const pending = consume('alice', 2, 'ordered').then((res) => res);
    await waitForWaiter('Lock');

    // If the user row were taken first, the account row would still be free here.
    await probe.query('begin');
    const err = await probe
      .query(`select 1 from account_usage where account_id = $1 and month = $2 for update nowait`, [account.id, MONTH])
      .then(() => null, (e: unknown) => e);
    await probe.query('rollback');
    expect(pgErrorOf(err)?.code).toBe('55P03');

    await blocker.query('rollback');
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACCEPTED');
    expect(await units()).toEqual({ account: 4, users: 4 });
  });

  it('two users of one account racing in opposite orders: no deadlock, every request decided once', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => consume(i % 2 ? 'alice' : 'bob', 1, `r-${i % 40}`)),
    );
    // r-0…r-39: 20 are sent twice (always by the same user, so a duplicate is a replay, not a 409).
    for (const res of results) expect(res.status).toBe(200);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(40);
    expect(await testDb.db.$count(requests, eq(requests.accountId, account.id))).toBe(42);
    expect(await units()).toEqual({ account: 42, users: 42 });
  });

  it('a failure while recording the decision rolls back the increments: nothing is counted, the retry is fresh', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await testDb.pool.query(`
      create function consume_fault() returns trigger language plpgsql as $$
      begin
        if new.request_id = 'boom' then raise exception 'injected failure'; end if;
        return new;
      end $$`);
    await testDb.pool.query(`create trigger consume_fault before insert on requests for each row execute function consume_fault()`);

    const res = await consume('alice', 5, 'boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(await units()).toEqual({ account: 2, users: 2 });
    expect(await testDb.db.$count(requests, eq(requests.requestId, 'boom'))).toBe(0);

    await testDb.pool.query('drop trigger consume_fault on requests');
    const retry = await consume('alice', 5, 'boom');
    expect(retry.body).toMatchObject({ status: 'ACCEPTED', replayed: false });
    expect(await units()).toEqual({ account: 7, users: 7 });
  });

  it('the connection dies mid-transaction: nothing is counted and the pool keeps serving', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The insert stalls inside the transaction, after the increments, until the backend is terminated.
    await testDb.pool.query(`
      create function consume_fault() returns trigger language plpgsql as $$
      begin
        if new.request_id = 'killed' then perform pg_sleep(3); end if;
        return new;
      end $$`);
    await testDb.pool.query(`create trigger consume_fault before insert on requests for each row execute function consume_fault()`);

    const pending = consume('alice', 5, 'killed').then((res) => res);
    const pid = await waitForWaiter('PgSleep');
    await testDb.db.execute(sql`select pg_terminate_backend(${pid})`);

    const res = await pending;
    expect(res.status).toBe(500);
    expect(await units()).toEqual({ account: 2, users: 2 });
    expect(await testDb.db.$count(requests, eq(requests.requestId, 'killed'))).toBe(0);

    await testDb.pool.query('drop trigger consume_fault on requests');
    for (let i = 0; i < 12; i++) {
      expect((await consume('bob', 1, `after-${i}`)).body.status).toBe('ACCEPTED');
    }
    expect(await units()).toEqual({ account: 14, users: 14 });
  });
});
