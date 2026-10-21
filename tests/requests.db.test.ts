import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requests, users } from '../src/db/schema.js';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { encodeCursor } from '../src/lib/cursor.js';
import { listRequests } from '../src/services/requests.service.js';
import { createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, TEST_DATABASE_URL, type TestDb } from './helpers/db.js';

interface Entry {
  requestId: string;
  externalUserId: string;
  month: string;
  createdAt: string;
}

describe.skipIf(!(await dbAvailable()))('GET /requests', () => {
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
    await as().post('/users', { externalUserId: 'alice' });
    await as().post('/users', { externalUserId: 'bob', planId: PREDEFINED_PLAN_IDS.PREMIUM });
  });

  afterAll(async () => {
    await testDb.close();
  });

  const as = (apiKey = account.apiKey) => ({
    get: (path: string) => request(app).get(path).set('X-API-Key', apiKey),
    post: (path: string, body: object) => request(app).post(path).set('X-API-Key', apiKey).send(body),
  });

  async function consume(externalUserId: string, units: number, requestId: string, apiKey = account.apiKey) {
    const res = await as(apiKey).post('/consume', { externalUserId, units, requestId });
    expect(res.status).toBe(200);
    return res.body;
  }

  /** Follows nextCursor to the end and returns every entry in page order. */
  async function readAll(query: string, limit: number, apiKey = account.apiKey): Promise<Entry[]> {
    const all: Entry[] = [];
    let cursor: string | null = null;
    do {
      const sep = query ? '&' : '';
      const res = await as(apiKey).get(`/requests?${query}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(limit);
      all.push(...res.body.data);
      cursor = res.body.nextCursor;
    } while (cursor);
    return all;
  }

  /** Six decisions over Oct and Nov, one minute apart: alice ×3, bob ×3. */
  async function seedHistory() {
    const plan: [string, string, string][] = [
      ['2026-10-20T10:00:00Z', 'alice', 'a1'],
      ['2026-10-20T10:01:00Z', 'bob', 'b1'],
      ['2026-10-31T23:59:59.999Z', 'alice', 'a2'],
      ['2026-11-01T00:00:00.000Z', 'bob', 'b2'],
      ['2026-11-03T09:00:00Z', 'alice', 'a3'],
      ['2026-11-03T09:01:00Z', 'bob', 'b3'],
    ];
    for (const [at, user, requestId] of plan) {
      current = new Date(at);
      await consume(user, 5, requestId);
    }
  }

  it('returns the stored decision snapshot, newest first', async () => {
    current = new Date('2026-10-15T12:00:00Z');
    await consume('alice', 10, 'first');
    current = new Date('2026-10-15T12:00:01Z');
    await consume('alice', 25, 'second'); // Basic per-request is 20 → rejected

    const res = await as().get('/requests');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          requestId: 'second',
          externalUserId: 'alice',
          units: 25,
          month: '2026-10',
          status: 'REJECTED',
          reasonCode: 'PER_REQUEST_LIMIT_EXCEEDED',
          rejectedBy: 'USER',
          limit: 20,
          remaining: { account: 10_000 - 10, user: 1_000 - 10 },
          accountPlanId: PREDEFINED_PLAN_IDS.STARTER,
          userPlanId: PREDEFINED_PLAN_IDS.BASIC,
          createdAt: '2026-10-15T12:00:01.000Z',
        },
        {
          requestId: 'first',
          externalUserId: 'alice',
          units: 10,
          month: '2026-10',
          status: 'ACCEPTED',
          reasonCode: null,
          rejectedBy: null,
          limit: null,
          remaining: { account: 10_000 - 10, user: 1_000 - 10 },
          accountPlanId: PREDEFINED_PLAN_IDS.STARTER,
          userPlanId: PREDEFINED_PLAN_IDS.BASIC,
          createdAt: '2026-10-15T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('an empty history is an empty page', async () => {
    expect((await as().get('/requests')).body).toEqual({ data: [], nextCursor: null });
  });

  it('a replay adds no history entry', async () => {
    await consume('alice', 10, 'r');
    await consume('alice', 10, 'r');
    expect((await as().get('/requests')).body.data).toHaveLength(1);
  });

  describe('pagination', () => {
    it('pages in (created_at, id) DESC order with no duplicates or gaps, including same-millisecond ties', async () => {
      // 13 decisions share one millisecond (only the id orders them), then 12 more spread out.
      for (let i = 0; i < 13; i++) await consume(i % 2 ? 'alice' : 'bob', 1, `tie-${i}`);
      for (let i = 0; i < 12; i++) {
        current = new Date(current.getTime() + 1);
        await consume('alice', 1, `spread-${i}`);
      }

      const stored = await testDb.db.select({ id: requests.id, requestId: requests.requestId, createdAt: requests.createdAt }).from(requests);
      const expected = stored
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0))
        .map((r) => r.requestId);

      for (const limit of [1, 4, 7, 25, 100]) {
        expect((await readAll('', limit)).map((e) => e.requestId)).toEqual(expected);
      }
    });

    it('the last full page has nextCursor null', async () => {
      for (let i = 0; i < 4; i++) await consume('alice', 1, `r${i}`);
      const first = await as().get('/requests?limit=2');
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await as().get(`/requests?limit=2&cursor=${first.body.nextCursor}`);
      expect(second.body.data).toHaveLength(2);
      expect(second.body.nextCursor).toBeNull();
    });

    it('a decision committed after page 1 is not repeated or skipped on page 2', async () => {
      for (let i = 0; i < 4; i++) {
        current = new Date(current.getTime() + 1_000);
        await consume('alice', 1, `r${i}`);
      }
      const first = await as().get('/requests?limit=2');
      current = new Date(current.getTime() + 1_000);
      await consume('alice', 1, 'late');
      const second = await as().get(`/requests?limit=2&cursor=${first.body.nextCursor}`);
      const ids = [...first.body.data, ...second.body.data].map((e: Entry) => e.requestId);
      expect(ids).toEqual(['r3', 'r2', 'r1', 'r0']);
    });

    it('defaults to 20 per page', async () => {
      for (let i = 0; i < 21; i++) await consume('alice', 1, `r${i}`);
      const res = await as().get('/requests');
      expect(res.body.data).toHaveLength(20);
      expect(res.body.nextCursor).toEqual(expect.any(String));
    });
  });

  // Characterization of a documented limitation (README "Known limitations"): created_at is read
  // once, before the request waits for a connection or a lock, so a decision that commits late is
  // listed behind newer ones that were already returned. Paging is unaffected; a reader that polls
  // the newest page and stops at the first entry it has seen misses it.
  describe('a decision that commits late', () => {
    let blocker: pg.Client;

    beforeEach(async () => {
      blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await blocker.connect();
    });

    afterEach(async () => {
      await blocker.end();
    });

    it('is listed behind entries already returned: a poller stopping at a seen entry, and a cursor past it, both miss it', async () => {
      current = new Date('2026-10-15T11:59:59Z');
      await consume('bob', 1, 'd'); // creates this month's account usage row
      current = new Date('2026-10-15T12:00:00Z');
      await consume('bob', 1, 'c');

      // Hold alice's (not yet existing) user usage row in an open transaction, so A waits at
      // consume step 4 after it has read the clock.
      const [alice] = await testDb.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.accountId, account.id), eq(users.externalUserId, 'alice')));
      await blocker.query('begin');
      await blocker.query(
        `insert into user_usage (user_id, account_id, month, units_used, updated_at) values ($1, $2, '2026-10-01', 0, $3)`,
        [alice!.id, account.id, current],
      );

      current = new Date('2026-10-15T12:00:01Z');
      // .then() sends the request now instead of when awaited.
      const late = as().post('/consume', { externalUserId: 'alice', units: 1, requestId: 'late' }).then((res) => res);
      await waitForLockWait(`insert into "user_usage"`);

      current = new Date('2026-10-15T12:00:02Z');
      await consume('bob', 1, 'b');
      const seen = (await as().get('/requests')).body.data.map((e: Entry) => e.requestId);
      expect(seen).toEqual(['b', 'c', 'd']);
      // A cursor traversal that has read its first page, positioned after 'c'.
      const page1 = (await as().get('/requests?limit=2')).body;
      expect(page1.data.map((e: Entry) => e.requestId)).toEqual(['b', 'c']);

      await blocker.query('rollback');
      expect((await late).body).toMatchObject({ status: 'ACCEPTED', replayed: false });

      const after = (await as().get('/requests')).body.data as (Entry & { remaining: { account: number } })[];
      expect(after.map((e) => e.requestId)).toEqual(['b', 'late', 'c', 'd']);
      // 'late' was decided after 'b' (it saw b's unit), yet it is listed after it.
      expect(after[1]!.remaining.account).toBeLessThan(after[0]!.remaining.account);
      // A poller that reads the newest page and stops at the first entry it has already seen ('b').
      const firstSeen = after.findIndex((e) => seen.includes(e.requestId));
      expect(after.slice(0, firstSeen).map((e) => e.requestId)).toEqual([]);
      // The traversal continues from its cursor: 'late' sits before it, so the traversal never sees it.
      const page2 = (await as().get(`/requests?limit=2&cursor=${page1.nextCursor}`)).body;
      expect(page2).toEqual({ data: [expect.objectContaining({ requestId: 'd' })], nextCursor: null });
    }, 15_000);

    async function waitForLockWait(queryPrefix: string) {
      for (let i = 0; i < 200; i++) {
        const { rowCount } = await testDb.pool.query(
          `select 1 from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock' and query ilike $1`,
          [`${queryPrefix}%`],
        );
        if (rowCount) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no session waited on a lock running ${queryPrefix}`);
    }
  });

  describe('filters', () => {
    beforeEach(seedHistory);

    it('month filter returns only that UTC month, across the boundary', async () => {
      expect((await readAll('month=2026-10', 2)).map((e) => e.requestId)).toEqual(['a2', 'b1', 'a1']);
      expect((await readAll('month=2026-11', 2)).map((e) => e.requestId)).toEqual(['b3', 'a3', 'b2']);
      expect(await readAll('month=2026-09', 2)).toEqual([]);
    });

    it('externalUserId filter returns only that user', async () => {
      expect((await readAll('externalUserId=alice', 2)).map((e) => e.requestId)).toEqual(['a3', 'a2', 'a1']);
      expect((await readAll('externalUserId=bob', 2)).map((e) => e.requestId)).toEqual(['b3', 'b2', 'b1']);
    });

    it('both filters combine', async () => {
      expect((await readAll('externalUserId=alice&month=2026-10', 1)).map((e) => e.requestId)).toEqual(['a2', 'a1']);
      expect((await readAll('externalUserId=bob&month=2026-11', 1)).map((e) => e.requestId)).toEqual(['b3', 'b2']);
    });

    it('no month means all months, not the current one', async () => {
      current = new Date('2026-11-15T00:00:00Z');
      expect(await readAll('', 100)).toHaveLength(6);
    });

    it('unknown externalUserId → 404', async () => {
      expectError(await as().get('/requests?externalUserId=nobody'), 404, 'NOT_FOUND');
      expectError(await as().get('/requests?externalUserId=nobody&month=2026-10'), 404, 'NOT_FOUND');
    });
  });

  describe('query plan', () => {
    beforeEach(seedHistory);

    /** Runs listRequests, captures its history SELECT, and EXPLAINs it with seq scans disabled. */
    async function planOf(query: Parameters<typeof listRequests>[2]) {
      const captured: { sql: string; params: unknown[] }[] = [];
      const db = drizzle(testDb.pool, { logger: { logQuery: (sql, params) => captured.push({ sql, params }) } });
      await listRequests({ db, now: () => current }, account.id, query);
      const select = captured.find((q) => /from "requests"/.test(q.sql));
      expect(select).toBeDefined();

      const client = await testDb.pool.connect();
      try {
        await client.query('analyze requests');
        // The table is tiny, so a Seq Scan would otherwise win on cost. This asks which
        // index the planner can use for this exact query, not whether it beats a scan.
        await client.query('set enable_seqscan = off');
        const { rows } = await client.query(`explain (format json) ${select!.sql}`, select!.params);
        return JSON.stringify(rows[0]['QUERY PLAN']);
      } finally {
        await client.query('reset enable_seqscan').catch(() => {});
        client.release();
      }
    }

    it('the month filter reads the (account_id, month, created_at DESC, id DESC) index with no Sort', async () => {
      const plan = await planOf({ month: new Date('2026-10-01T00:00:00Z'), limit: 2 });
      expect(plan).toContain('"Index Name":"requests_account_id_month_created_at_id_idx"');
      expect(plan).not.toContain('"Node Type":"Sort"');
    });

    it('a month-filtered page after a cursor still uses that index with no Sort', async () => {
      const [a2] = await testDb.db.select().from(requests).where(eq(requests.requestId, 'a2'));
      const cursor = { createdAt: a2!.createdAt, id: a2!.id };
      const plan = await planOf({ month: new Date('2026-10-01T00:00:00Z'), limit: 1, cursor });
      expect(plan).toContain('"Index Name":"requests_account_id_month_created_at_id_idx"');
      expect(plan).not.toContain('"Node Type":"Sort"');
    });
  });

  describe('validation', () => {
    it.each([
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=1.5',
      'cursor=garbage',
      'cursor=',
      'month=2026-13',
      'month=2026-1',
      'month=',
      'externalUserId=',
      `externalUserId=${'x'.repeat(129)}`,
      'externalUserId=%20alice',
      'externalUserId=alice%20',
      'month=2026-10&month=2026-11',
    ])('?%s → 400', async (q) => {
      expectError(await as().get(`/requests?${q}`), 400, 'VALIDATION_ERROR');
    });

    it('missing or invalid API key → 401', async () => {
      expectError(await request(app).get('/requests'), 401, 'UNAUTHORIZED');
      expectError(await request(app).get('/requests').set('X-API-Key', 'mk_nope'), 401, 'UNAUTHORIZED');
    });
  });

  describe('account isolation', () => {
    let other: { id: string; apiKey: string };

    beforeEach(async () => {
      other = await signUp(app, 'other');
      await as(other.apiKey).post('/users', { externalUserId: 'alice' });
      await as(other.apiKey).post('/users', { externalUserId: 'carol' });
      await consume('alice', 1, 'shared-id');
      await consume('alice', 2, 'shared-id', other.apiKey);
      // A distinct timestamp, so the expected order doesn't hinge on a random-UUID tiebreak.
      current = new Date(current.getTime() + 1_000);
      await consume('carol', 3, 'carol-1', other.apiKey);
    });

    it("lists only the caller's decisions", async () => {
      expect((await readAll('', 100)).map((e) => e.requestId)).toEqual(['shared-id']);
      expect((await readAll('', 100, other.apiKey)).map((e) => e.requestId)).toEqual(['carol-1', 'shared-id']);
    });

    it("another account's user → 404, and a same-named user resolves within the caller's account", async () => {
      expectError(await as().get('/requests?externalUserId=carol'), 404, 'NOT_FOUND');
      const mine = await as().get('/requests?externalUserId=alice');
      expect(mine.body.data.map((e: { units: number }) => e.units)).toEqual([1]);
    });

    it("a cursor positioned among another account's rows still returns only the caller's", async () => {
      const [theirs] = await testDb.db.select().from(requests).where(eq(requests.requestId, 'carol-1'));
      const cursor = encodeCursor({ createdAt: new Date(theirs!.createdAt.getTime() + 1), id: theirs!.id });
      const page = await as().get(`/requests?cursor=${cursor}`);
      expect(page.body.data.map((e: Entry) => e.requestId)).toEqual(['shared-id']);
    });
  });
});

