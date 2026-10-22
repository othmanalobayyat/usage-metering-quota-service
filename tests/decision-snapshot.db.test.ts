import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createMaintenancePool } from '../src/db/client.js';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { requests, users } from '../src/db/schema.js';
import { DEFAULT_ACCOUNT_PLAN_ID, DEFAULT_USER_PLAN_ID, PREDEFINED_PLAN_IDS, seedPlans } from '../src/db/seed.js';
import { systemClock } from '../src/lib/clock.js';
import { pgErrorOf } from '../src/lib/pg-error.js';
import { evaluate } from '../src/services/rules.js';
import { createCustomPlan, createTestApp, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, TEST_DATABASE_URL, type TestDb } from './helpers/db.js';

// Migration 0001: every request row stores the limits evaluate() was given and the usage before the
// request, so a decision can be re-derived after its plan is edited or switched.

interface Snapshot {
  account: { monthlyLimit: number; perRequestLimit: number; unitsUsedBefore: number };
  user: { monthlyLimit: number; perRequestLimit: number; unitsUsedBefore: number };
}

interface HistoryEntry {
  requestId: string;
  units: number;
  status: string;
  reasonCode: string | null;
  rejectedBy: string | null;
  limit: number | null;
  remaining: { account: number; user: number };
  snapshot: Snapshot | null;
}

/** evaluate() run again on the stored inputs. */
function reEvaluate(entry: HistoryEntry & { snapshot: Snapshot }) {
  const { account, user } = entry.snapshot;
  return evaluate({
    accountPlan: { monthlyLimit: account.monthlyLimit, perRequestLimit: account.perRequestLimit },
    userPlan: { monthlyLimit: user.monthlyLimit, perRequestLimit: user.perRequestLimit },
    accountUsed: account.unitsUsedBefore,
    userUsed: user.unitsUsedBefore,
    units: entry.units,
  });
}

/** The stored decision in evaluate()'s shape. */
const storedDecision = (entry: HistoryEntry) => ({
  status: entry.status,
  reasonCode: entry.reasonCode,
  rejectedBy: entry.rejectedBy,
  limit: entry.limit,
  remaining: entry.remaining,
});

describe.skipIf(!(await dbAvailable()))('decision snapshot (requests)', () => {
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
    get: (p: string) => request(app).get(p).set('X-API-Key', account.apiKey),
    post: (p: string, body: object) => request(app).post(p).set('X-API-Key', account.apiKey).send(body),
    put: (p: string, body: object) => request(app).put(p).set('X-API-Key', account.apiKey).send(body),
    patch: (p: string, body: object) => request(app).patch(p).set('X-API-Key', account.apiKey).send(body),
  });

  async function consume(externalUserId: string, units: number, requestId: string) {
    current = new Date(current.getTime() + 1_000);
    const res = await as().post('/consume', { externalUserId, units, requestId });
    expect(res.status).toBe(200);
    return res.body;
  }

  async function history(): Promise<Map<string, HistoryEntry>> {
    const res = await as().get('/requests?limit=100');
    expect(res.status).toBe(200);
    return new Map((res.body.data as HistoryEntry[]).map((e) => [e.requestId, e]));
  }

  it('every decision stays explainable after its plans are edited and switched', async () => {
    const accountPlan = await createCustomPlan(app, account.apiKey, { name: 'team', type: 'ACCOUNT', monthlyLimit: 100, perRequestLimit: 50 });
    const userPlan = await createCustomPlan(app, account.apiKey, { name: 'member', type: 'USER', monthlyLimit: 60, perRequestLimit: 30 });
    expect((await as().put('/account/plan', { planId: accountPlan })).status).toBe(200);
    expect((await as().post('/users', { externalUserId: 'alice', planId: userPlan })).status).toBe(201);
    expect((await as().post('/users', { externalUserId: 'bob' })).status).toBe(201); // Basic: 1,000 · 20

    expect((await consume('alice', 20, 'r1')).status).toBe('ACCEPTED');
    expect(await consume('alice', 35, 'r2')).toMatchObject({ rejectedBy: 'USER', reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED', limit: 30 });

    // Live edit of the user plan: the same 35 now fails on the lowered monthly limit instead.
    expect((await as().patch(`/plans/${userPlan}`, { monthlyLimit: 50, perRequestLimit: 40 })).status).toBe(200);
    expect(await consume('alice', 35, 'r3')).toMatchObject({ rejectedBy: 'USER', reasonCode: 'MONTHLY_LIMIT_EXCEEDED', limit: 50 });

    expect((await consume('bob', 15, 'r4')).status).toBe('ACCEPTED');

    // Account allowance lowered below its usage (35): remaining 0, the next request is rejected.
    expect((await as().patch(`/plans/${accountPlan}`, { monthlyLimit: 30 })).status).toBe(200);
    expect(await consume('bob', 1, 'r5')).toMatchObject({ rejectedBy: 'ACCOUNT', reasonCode: 'MONTHLY_LIMIT_EXCEEDED', limit: 30 });

    // Switch alice back to a predefined plan; her 20 units stay counted.
    expect((await as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM })).status).toBe(200);
    expect(await consume('alice', 5, 'r6')).toMatchObject({ rejectedBy: 'ACCOUNT', reasonCode: 'MONTHLY_LIMIT_EXCEEDED' });

    const entries = await history();
    expect(entries.size).toBe(6);

    // The plans as they are now are not what r1–r4 were decided with.
    expect((await as().get(`/plans/${userPlan}`)).body).toMatchObject({ monthlyLimit: 50, perRequestLimit: 40 });
    expect((await as().get(`/plans/${accountPlan}`)).body).toMatchObject({ monthlyLimit: 30, perRequestLimit: 50 });

    expect(entries.get('r1')!.snapshot).toEqual({
      account: { monthlyLimit: 100, perRequestLimit: 50, unitsUsedBefore: 0 },
      user: { monthlyLimit: 60, perRequestLimit: 30, unitsUsedBefore: 0 },
    });
    expect(entries.get('r2')!.snapshot).toEqual({
      account: { monthlyLimit: 100, perRequestLimit: 50, unitsUsedBefore: 20 },
      user: { monthlyLimit: 60, perRequestLimit: 30, unitsUsedBefore: 20 },
    });
    expect(entries.get('r3')!.snapshot).toEqual({
      account: { monthlyLimit: 100, perRequestLimit: 50, unitsUsedBefore: 20 },
      user: { monthlyLimit: 50, perRequestLimit: 40, unitsUsedBefore: 20 },
    });
    expect(entries.get('r4')!.snapshot).toEqual({
      account: { monthlyLimit: 100, perRequestLimit: 50, unitsUsedBefore: 20 },
      user: { monthlyLimit: 1_000, perRequestLimit: 20, unitsUsedBefore: 0 },
    });
    expect(entries.get('r5')!.snapshot).toEqual({
      account: { monthlyLimit: 30, perRequestLimit: 50, unitsUsedBefore: 35 },
      user: { monthlyLimit: 1_000, perRequestLimit: 20, unitsUsedBefore: 15 },
    });
    expect(entries.get('r6')!.snapshot).toEqual({
      account: { monthlyLimit: 30, perRequestLimit: 50, unitsUsedBefore: 35 },
      user: { monthlyLimit: 5_000, perRequestLimit: 100, unitsUsedBefore: 20 },
    });

    // Each stored decision is exactly what evaluate() gives on its stored inputs.
    for (const entry of entries.values()) {
      expect(reEvaluate(entry as HistoryEntry & { snapshot: Snapshot })).toEqual(storedDecision(entry));
    }
  });

  it('a replay returns the original decision; its snapshot stays the original one', async () => {
    expect((await as().post('/users', { externalUserId: 'alice' })).status).toBe(201);
    const first = await consume('alice', 10, 'once');
    expect((await as().put('/users/alice/plan', { planId: PREDEFINED_PLAN_IDS.PREMIUM })).status).toBe(200);
    const again = await consume('alice', 10, 'once');
    expect(again).toEqual({ ...first, replayed: true });

    const [row] = await testDb.db.select().from(requests).where(eq(requests.requestId, 'once'));
    expect(row).toMatchObject({
      userPlanId: DEFAULT_USER_PLAN_ID,
      userMonthlyLimit: 1_000,
      userPerRequestLimit: 20,
      userUsedBefore: 0,
      accountMonthlyLimit: 10_000,
      accountPerRequestLimit: 100,
      accountUsedBefore: 0,
    });
  });

  it('under concurrency, the accepted snapshots chain: each starts where the previous one ended', async () => {
    expect((await as().post('/users', { externalUserId: 'alice' })).status).toBe(201);
    expect((await as().post('/users', { externalUserId: 'bob' })).status).toBe(201);
    // 40 × 3 units against Basic's 1,000 per user and Starter's 10,000: all accepted.
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request(app)
          .post('/consume')
          .set('X-API-Key', account.apiKey)
          .send({ externalUserId: i % 2 ? 'alice' : 'bob', units: 3, requestId: `c-${i}` }),
      ),
    );
    expect(results.every((r) => r.status === 200 && r.body.status === 'ACCEPTED')).toBe(true);

    const rows = await testDb.db.select().from(requests);
    const accountBefore = rows.map((r) => r.accountUsedBefore!).sort((a, b) => a - b);
    // Serialized by the account row lock: 0, 3, 6, …, 117, with no two decisions seeing the same usage.
    expect(accountBefore).toEqual(Array.from({ length: 40 }, (_, i) => i * 3));
    for (const who of ['alice', 'bob']) {
      const [user] = await testDb.db.select().from(users).where(eq(users.externalUserId, who));
      const userBefore = rows.filter((r) => r.userId === user!.id).map((r) => r.userUsedBefore!).sort((a, b) => a - b);
      expect(userBefore).toEqual(Array.from({ length: 20 }, (_, i) => i * 3));
    }
  });

  it('a decision recorded before the snapshot existed shows snapshot: null, everything else unchanged', async () => {
    expect((await as().post('/users', { externalUserId: 'alice' })).status).toBe(201);
    const [alice] = await testDb.db.select().from(users).where(eq(users.externalUserId, 'alice'));
    // A row exactly as the 0000 schema wrote it: no snapshot columns.
    await testDb.db.insert(requests).values({
      accountId: account.id,
      userId: alice!.id,
      requestId: 'legacy',
      units: 10,
      month: '2026-09-01',
      status: 'ACCEPTED',
      accountPlanId: DEFAULT_ACCOUNT_PLAN_ID,
      userPlanId: DEFAULT_USER_PLAN_ID,
      remainingAccount: 9_990,
      remainingUser: 990,
      createdAt: new Date('2026-09-10T00:00:00Z'),
    });

    const res = await as().get('/requests');
    expect(res.body.data).toEqual([
      {
        requestId: 'legacy',
        externalUserId: 'alice',
        units: 10,
        month: '2026-09',
        status: 'ACCEPTED',
        reasonCode: null,
        rejectedBy: null,
        limit: null,
        remaining: { account: 9_990, user: 990 },
        accountPlanId: DEFAULT_ACCOUNT_PLAN_ID,
        userPlanId: DEFAULT_USER_PLAN_ID,
        snapshot: null,
        createdAt: '2026-09-10T00:00:00.000Z',
      },
    ]);
  });

  describe('requests_snapshot_check', () => {
    let alice: { id: string };

    beforeEach(async () => {
      expect((await as().post('/users', { externalUserId: 'alice' })).status).toBe(201);
      const [row] = await testDb.db.select({ id: users.id }).from(users).where(eq(users.externalUserId, 'alice'));
      alice = row!;
    });

    const row = (requestId: string, snapshot: Partial<typeof requests.$inferInsert>) => ({
      accountId: account.id,
      userId: alice.id,
      requestId,
      units: 10,
      month: '2026-10-01',
      status: 'ACCEPTED' as const,
      accountPlanId: DEFAULT_ACCOUNT_PLAN_ID,
      userPlanId: DEFAULT_USER_PLAN_ID,
      remainingAccount: 9_990,
      remainingUser: 990,
      createdAt: current,
      ...snapshot,
    });

    const full = {
      accountMonthlyLimit: 10_000,
      accountPerRequestLimit: 100,
      accountUsedBefore: 0,
      userMonthlyLimit: 1_000,
      userPerRequestLimit: 20,
      userUsedBefore: 0,
    };

    async function violation(snapshot: Partial<typeof requests.$inferInsert>): Promise<string | undefined> {
      try {
        await testDb.db.insert(requests).values(row('bad', snapshot));
      } catch (err) {
        const pgErr = pgErrorOf(err);
        return pgErr?.code === '23514' ? pgErr.constraint : `unexpected ${pgErr?.code}`;
      }
      return undefined;
    }

    it('accepts all six columns set, or none', async () => {
      await testDb.db.insert(requests).values(row('none', {}));
      await testDb.db.insert(requests).values(row('all', full));
    });

    it.each([
      ['only the account limits', { accountMonthlyLimit: 10_000, accountPerRequestLimit: 100 }],
      ['all but userUsedBefore', { ...full, userUsedBefore: null }],
      ['a negative usage', { ...full, accountUsedBefore: -1 }],
      ['a zero per-request limit', { ...full, userPerRequestLimit: 0 }],
      ['a negative monthly limit', { ...full, userMonthlyLimit: -1 }],
    ])('rejects %s', async (_name, snapshot) => {
      expect(await violation(snapshot)).toBe('requests_snapshot_check');
    });
  });
});

describe.skipIf(!(await dbAvailable()))('migration 0001 on a populated database', () => {
  const dbName = `quota_snapshot_migration_${process.pid}_test`;
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${dbName}`;
  let folder: string;

  async function admin(sql: string) {
    const client = new pg.Client({ connectionString: adminUrl.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await admin(`drop database if exists "${dbName}"`);
    await admin(`create database "${dbName}"`);
    // A migrations folder holding only 0000, with the real journal entry, so the real folder later
    // applies exactly 0001 on top of it, as the container entrypoint would on an existing volume.
    folder = mkdtempSync(path.join(tmpdir(), 'migration-0000-'));
    mkdirSync(path.join(folder, 'meta'));
    copyFileSync(path.join(MIGRATIONS_FOLDER, '0000_init.sql'), path.join(folder, '0000_init.sql'));
    const journal = (await import(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), { with: { type: 'json' } })).default as {
      entries: { tag: string }[];
    };
    writeFileSync(
      path.join(folder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.tag === '0000_init') }),
    );
  });

  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    await admin(`drop database if exists "${dbName}"`);
  });

  it('adds the snapshot columns without touching existing rows', async () => {
    const pool = createMaintenancePool(url.toString());
    try {
      const db = createDb(pool);
      await migrate(db, { migrationsFolder: folder });
      await seedPlans(db, systemClock);
      const at = '2026-09-10T00:00:00Z';
      await pool.query(
        `insert into accounts (id, name, api_key_hash, plan_id, created_at)
         values ('11111111-1111-4111-8111-111111111111', 'old', repeat('a', 64), $1, $2)`,
        [DEFAULT_ACCOUNT_PLAN_ID, at],
      );
      await pool.query(
        `insert into users (id, account_id, external_user_id, plan_id, created_at)
         values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'alice', $1, $2)`,
        [DEFAULT_USER_PLAN_ID, at],
      );
      await pool.query(
        `insert into requests (account_id, user_id, request_id, units, month, status, reason_code, rejected_by,
                               limit_value, account_plan_id, user_plan_id, remaining_account, remaining_user, created_at)
         values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'old-1', 10,
                 '2026-09-01', 'ACCEPTED', null, null, null, $1, $2, 9990, 990, $3),
                ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'old-2', 25,
                 '2026-09-01', 'REJECTED', 'PER_REQUEST_LIMIT_EXCEEDED', 'USER', 20, $1, $2, 9990, 990, $3)`,
        [DEFAULT_ACCOUNT_PLAN_ID, DEFAULT_USER_PLAN_ID, at],
      );
      const before = (await pool.query('select * from requests order by request_id')).rows;

      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const after = (await pool.query('select * from requests order by request_id')).rows;
      expect(after).toHaveLength(2);
      const snapshotColumns = [
        'account_monthly_limit',
        'account_per_request_limit',
        'account_used_before',
        'user_monthly_limit',
        'user_per_request_limit',
        'user_used_before',
      ];
      after.forEach((row, i) => {
        // Every old column is unchanged; the new ones are NULL: those plans may have been edited
        // since, so nothing is backfilled from their current limits.
        expect(Object.fromEntries(Object.entries(row).filter(([k]) => !snapshotColumns.includes(k)))).toEqual(before[i]);
        for (const column of snapshotColumns) expect(row[column]).toBeNull();
      });
    } finally {
      await pool.end();
    }
  });
});
