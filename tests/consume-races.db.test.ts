import { and, eq, sql } from 'drizzle-orm';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountUsage, requests, users, userUsage } from '../src/db/schema.js';
import { evaluate } from '../src/services/rules.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, TEST_DATABASE_URL, type TestDb } from './helpers/db.js';

// Concurrent consumes racing for the last units, duplicates, conflicting payloads and failures.
// Every test ends with checkLedger(): the account total, every user total and the request history
// must agree, and every stored decision must be what evaluate() gives on its stored inputs. Nothing
// here depends on how the transaction splits its work into statements.

const NOW = new Date('2026-10-15T12:00:00Z');
const MONTH = '2026-10-01';

describe.skipIf(!(await dbAvailable()))('consume races', () => {
  let testDb: TestDb;
  let app: Express;
  let account: { id: string; apiKey: string };

  beforeAll(() => {
    testDb = createTestDb();
    app = createTestApp(testDb, () => NOW);
  });

  beforeEach(async () => {
    await resetDatabase(testDb.pool);
    account = await signUp(app);
  });

  afterEach(async () => {
    await testDb.pool.query('drop trigger if exists race_fault on requests');
    await testDb.pool.query('drop trigger if exists race_fault on user_usage');
    await testDb.pool.query('drop function if exists race_fault()');
  });

  afterAll(async () => {
    await testDb.close();
  });

  const post = (path: string, body: object) => request(app).post(path).set('X-API-Key', account.apiKey).send(body);
  const consume = (externalUserId: string, units: number, requestId: string) =>
    post('/consume', { externalUserId, units, requestId });

  /** A custom ACCOUNT plan on the account, and USER plan `userLimits` for each named user. */
  async function setUp(accountLimits: [number, number], userLimits: [number, number], names: string[]) {
    const accountPlan = await createCustomPlan(app, account.apiKey, {
      name: 'acct', type: 'ACCOUNT', monthlyLimit: accountLimits[0], perRequestLimit: accountLimits[1],
    });
    const userPlan = await createCustomPlan(app, account.apiKey, {
      name: 'member', type: 'USER', monthlyLimit: userLimits[0], perRequestLimit: userLimits[1],
    });
    expect((await request(app).put('/account/plan').set('X-API-Key', account.apiKey).send({ planId: accountPlan })).status).toBe(200);
    for (const externalUserId of names) {
      expect((await post('/users', { externalUserId, planId: userPlan })).status).toBe(201);
    }
  }

  /** Consumes `total` units for `who`, one request at a time, all accepted. */
  async function prefill(who: string, total: number, chunk: number) {
    for (let used = 0, i = 0; used < total; i++) {
      const units = Math.min(chunk, total - used);
      expect((await consume(who, units, `pre-${who}-${i}`)).body.status).toBe('ACCEPTED');
      used += units;
    }
  }

  async function userTotals(): Promise<Record<string, number>> {
    const rows = await testDb.db
      .select({ who: users.externalUserId, n: userUsage.unitsUsed })
      .from(userUsage)
      .innerJoin(users, and(eq(users.accountId, userUsage.accountId), eq(users.id, userUsage.userId)))
      .where(eq(userUsage.accountId, account.id));
    return Object.fromEntries(rows.map((r) => [r.who, r.n]));
  }

  async function accountTotal(): Promise<number> {
    const [row] = await testDb.db
      .select({ n: accountUsage.unitsUsed })
      .from(accountUsage)
      .where(and(eq(accountUsage.accountId, account.id), eq(accountUsage.month, MONTH)));
    return row?.n ?? 0;
  }

  /**
   * Totals and history agree: account = sum of users = sum of accepted request units; every decision
   * equals evaluate() on its stored inputs; and the accepted decisions form one serial chain, each
   * starting at the account usage the previous one left.
   */
  async function checkLedger() {
    const rows = await testDb.db.select().from(requests).where(eq(requests.accountId, account.id));
    const accepted = rows.filter((r) => r.status === 'ACCEPTED');
    const acceptedUnits = accepted.reduce((sum, r) => sum + r.units, 0);
    const perUser = Object.values(await userTotals()).reduce((sum, n) => sum + n, 0);
    expect(await accountTotal()).toBe(acceptedUnits);
    expect(perUser).toBe(acceptedUnits);

    for (const r of rows) {
      expect(r.accountUsedBefore).not.toBeNull();
      expect(
        evaluate({
          accountPlan: { monthlyLimit: r.accountMonthlyLimit!, perRequestLimit: r.accountPerRequestLimit! },
          userPlan: { monthlyLimit: r.userMonthlyLimit!, perRequestLimit: r.userPerRequestLimit! },
          accountUsed: r.accountUsedBefore!,
          userUsed: r.userUsedBefore!,
          units: r.units,
        }),
      ).toEqual({
        status: r.status,
        reasonCode: r.reasonCode,
        rejectedBy: r.rejectedBy,
        limit: r.limitValue,
        remaining: { account: r.remainingAccount, user: r.remainingUser },
      });
    }

    const chain = [...accepted].sort((a, b) => a.accountUsedBefore! - b.accountUsedBefore!);
    let expected = 0;
    for (const r of chain) {
      expect(r.accountUsedBefore).toBe(expected);
      expected += r.units;
    }
    return rows;
  }

  it('30 requests race for the last 5 account units: exactly 5 accepted, the rest rejected by ACCOUNT', async () => {
    await setUp([100, 10], [1_000, 10], ['u0', 'u1', 'u2', 'u3']);
    await prefill('u0', 95, 10);

    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => consume(`u${i % 4}`, 1, `last-${i}`)));

    for (const res of results) expect(res.status).toBe(200);
    expect(results.filter((r) => r.body.status === 'ACCEPTED')).toHaveLength(5);
    for (const res of results.filter((r) => r.body.status === 'REJECTED')) {
      expect(res.body).toMatchObject({ reasonCode: 'MONTHLY_LIMIT_EXCEEDED', rejectedBy: 'ACCOUNT', limit: 100 });
      expect(res.body.remaining.account).toBe(0);
    }
    expect(await accountTotal()).toBe(100);
    expect((await checkLedger()).length).toBe(10 + 30);
  });

  it("30 requests race for one user's last 5 units while another user consumes freely", async () => {
    await setUp([10_000, 10], [50, 10], ['alice', 'bob']);
    await prefill('alice', 45, 10);

    const results = await Promise.all([
      ...Array.from({ length: 30 }, (_, i) => consume('alice', 1, `a-${i}`)),
      ...Array.from({ length: 10 }, (_, i) => consume('bob', 2, `b-${i}`)),
    ]);

    for (const res of results) expect(res.status).toBe(200);
    const alice = results.slice(0, 30);
    expect(alice.filter((r) => r.body.status === 'ACCEPTED')).toHaveLength(5);
    for (const res of alice.filter((r) => r.body.status === 'REJECTED')) {
      expect(res.body).toMatchObject({ reasonCode: 'MONTHLY_LIMIT_EXCEEDED', rejectedBy: 'USER', limit: 50, remaining: { user: 0 } });
    }
    expect(results.slice(30).every((r) => r.body.status === 'ACCEPTED')).toBe(true);
    expect(await userTotals()).toEqual({ alice: 50, bob: 20 });
    expect(await accountTotal()).toBe(70);
    await checkLedger();
  });

  it('account and user limits both nearly reached: the account cap holds exactly and the user cap is never passed', async () => {
    // Account: 6 left. Alice: 3 left. Bob: plenty. 10 + 10 one-unit requests.
    await setUp([100, 10], [53, 10], ['alice', 'bob']);
    await prefill('alice', 50, 10);
    await prefill('bob', 44, 10);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => consume(i % 2 ? 'alice' : 'bob', 1, `both-${i}`)),
    );

    for (const res of results) expect(res.status).toBe(200);
    expect(results.filter((r) => r.body.status === 'ACCEPTED')).toHaveLength(6);
    const totals = await userTotals();
    expect(totals.alice).toBeLessThanOrEqual(53);
    expect(totals.alice! + totals.bob!).toBe(100);
    for (const res of results.filter((r) => r.body.status === 'REJECTED')) {
      expect(res.body.reasonCode).toBe('MONTHLY_LIMIT_EXCEEDED');
      expect(['ACCOUNT', 'USER']).toContain(res.body.rejectedBy);
    }
    await checkLedger();
  });

  it('25 simultaneous copies of one requestId: decided once, every copy gets the same decision', async () => {
    await setUp([10_000, 10], [1_000, 10], ['alice']);

    const results = await Promise.all(Array.from({ length: 25 }, () => consume('alice', 4, 'dup')));

    for (const res of results) expect(res.status).toBe(200);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    const original = results.find((r) => r.body.replayed === false)!.body;
    for (const res of results) expect({ ...res.body, replayed: false }).toEqual(original);
    expect(await accountTotal()).toBe(4);
    expect((await checkLedger()).filter((r) => r.requestId === 'dup')).toHaveLength(1);
  });

  it('copies of one requestId racing other requests for the last 4 units: the requestId is still decided once', async () => {
    await setUp([100, 10], [1_000, 10], ['alice', 'bob']);
    await prefill('bob', 96, 10);

    const results = await Promise.all([
      ...Array.from({ length: 15 }, () => consume('alice', 4, 'contested')),
      ...Array.from({ length: 15 }, (_, i) => consume('bob', 4, `other-${i}`)),
    ]);

    for (const res of results) expect(res.status).toBe(200);
    const copies = results.slice(0, 15).map((r) => ({ ...r.body, replayed: false }));
    for (const copy of copies) expect(copy).toEqual(copies[0]);
    expect(results.filter((r) => r.body.status === 'ACCEPTED' && r.body.replayed === false)).toHaveLength(1);
    expect(await accountTotal()).toBe(100);
    const rows = await checkLedger();
    expect(rows.filter((r) => r.requestId === 'contested')).toHaveLength(1);
    expect(rows).toHaveLength(10 + 1 + 15);
  });

  it('one requestId sent concurrently with different payloads: one decision; matching copies replay, the rest get 409', async () => {
    await setUp([10_000, 10], [1_000, 10], ['alice', 'bob']);

    const sent = [
      ...Array.from({ length: 10 }, () => ({ who: 'alice', units: 3 })),
      ...Array.from({ length: 10 }, () => ({ who: 'alice', units: 5 })),
      ...Array.from({ length: 5 }, () => ({ who: 'bob', units: 3 })),
    ];
    const results = await Promise.all(sent.map((s) => consume(s.who, s.units, 'shared-id')));

    const rows = await checkLedger();
    expect(rows).toHaveLength(1);
    const [stored] = rows;
    const [winner] = await testDb.db.select({ who: users.externalUserId }).from(users).where(eq(users.id, stored!.userId));
    results.forEach((res, i) => {
      if (sent[i]!.who === winner!.who && sent[i]!.units === stored!.units) {
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ requestId: 'shared-id', status: 'ACCEPTED' });
      } else {
        expectError(res, 409, 'IDEMPOTENCY_CONFLICT');
      }
    });
    expect(results.filter((r) => r.status === 200 && r.body.replayed === false)).toHaveLength(1);
    expect(await accountTotal()).toBe(stored!.units);
  });

  it('8 users of one account consuming at once: every user total is exactly what it sent', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `u${i}`);
    await setUp([100_000, 10], [1_000, 10], names);
    const sent: Record<string, number> = {};
    const calls = names.flatMap((who, u) =>
      Array.from({ length: 12 }, (_, i) => {
        const units = 1 + ((u + i) % 5);
        sent[who] = (sent[who] ?? 0) + units;
        return consume(who, units, `${who}-${i}`);
      }),
    );

    const results = await Promise.all(calls);

    for (const res of results) expect(res.body.status).toBe('ACCEPTED');
    expect(await userTotals()).toEqual(sent);
    expect(await accountTotal()).toBe(Object.values(sent).reduce((a, b) => a + b, 0));
    expect((await checkLedger()).length).toBe(96);
  });

  it('requests that fail inside the transaction, mixed into a concurrent burst, leave no trace; retried, they are decided fresh', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await setUp([100_000, 10], [1_000, 10], ['alice', 'bob']);
    await testDb.pool.query(`
      create function race_fault() returns trigger language plpgsql as $$
      begin
        if new.request_id like 'fail-%' then raise exception 'injected failure'; end if;
        return new;
      end $$`);
    await testDb.pool.query('create trigger race_fault before insert on requests for each row execute function race_fault()');

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => consume(i % 2 ? 'alice' : 'bob', 2, i % 3 === 0 ? `fail-${i}` : `ok-${i}`)),
    );

    results.forEach((res, i) => expect(res.status).toBe(i % 3 === 0 ? 500 : 200));
    expect(await accountTotal()).toBe(20 * 2);
    expect((await checkLedger()).some((r) => r.requestId.startsWith('fail-'))).toBe(false);

    await testDb.pool.query('drop trigger race_fault on requests');
    for (let i = 0; i < 30; i += 3) {
      expect((await consume(i % 2 ? 'alice' : 'bob', 2, `fail-${i}`)).body).toMatchObject({ status: 'ACCEPTED', replayed: false });
    }
    expect(await accountTotal()).toBe(30 * 2);
    await checkLedger();
  });

  it('a failure while incrementing the user total rolls back the account increment too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await setUp([100_000, 10], [1_000, 10], ['alice', 'bob']);
    expect((await consume('bob', 3, 'before')).body.status).toBe('ACCEPTED');
    const [bob] = await testDb.db.select({ id: users.id }).from(users).where(eq(users.externalUserId, 'bob'));
    await testDb.pool.query(`
      create function race_fault() returns trigger language plpgsql as $$
      begin
        if new.user_id = '${bob!.id}' and new.units_used > old.units_used then raise exception 'injected failure'; end if;
        return new;
      end $$`);
    await testDb.pool.query('create trigger race_fault before update on user_usage for each row execute function race_fault()');

    expect((await consume('bob', 5, 'boom')).status).toBe(500);
    expect((await consume('alice', 5, 'fine')).body.status).toBe('ACCEPTED');

    expect(await accountTotal()).toBe(3 + 5);
    expect(await userTotals()).toEqual({ alice: 5, bob: 3 });
    expect((await checkLedger()).map((r) => r.requestId).sort()).toEqual(['before', 'fine']);
  });

  describe('a consume that waited on the account row decides on what the lock holder committed', () => {
    let blocker: pg.Client;

    beforeEach(async () => {
      blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await blocker.connect();
    });

    afterEach(async () => {
      await blocker.query('rollback').catch(() => {});
      await blocker.end();
    });

    /**
     * Another session locks the account row; `send()` starts and queues behind it at the row lock
     * (the only lock it can wait on: the usage rows already exist). Only then does the other session
     * add `units` for `who` to both totals, with a matching request row so the ledger stays
     * consistent, and commit. So the queued consume's locking statement began before those updates:
     * if it decided on the totals as of its own start instead of what was committed, it would overspend.
     */
    async function commitWhileWaiting(who: string, units: number, send: () => Promise<request.Response>) {
      const [user] = await testDb.db.select().from(users).where(and(eq(users.accountId, account.id), eq(users.externalUserId, who)));
      const [before] = (
        await testDb.db.execute<{ a: number; u: number }>(sql`
          select (select units_used from account_usage where account_id = ${account.id} and month = ${MONTH}) as a,
                 (select units_used from user_usage where user_id = ${user!.id} and month = ${MONTH}) as u`)
      ).rows;
      await blocker.query('begin');
      await blocker.query('select 1 from account_usage where account_id = $1 and month = $2 for update', [account.id, MONTH]);
      const pending = send().then((res) => res);
      for (let i = 0; ; i++) {
        const { rows } = await testDb.pool.query<{ query: string }>(
          `select query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> $1`,
          [(blocker as unknown as { processID: number }).processID],
        );
        if (rows[0]) {
          waitedIn.push(rows[0].query);
          break;
        }
        if (i > 300) throw new Error('the consume never waited on the account row');
        await new Promise((r) => setTimeout(r, 10));
      }
      await blocker.query('update account_usage set units_used = units_used + $3 where account_id = $1 and month = $2', [account.id, MONTH, units]);
      await blocker.query('update user_usage set units_used = units_used + $3 where user_id = $1 and month = $2', [user!.id, MONTH, units]);
      // The request row records the totals before this increment, as consume does.
      await blocker.query(
        `insert into requests (account_id, user_id, request_id, units, month, status, account_plan_id, user_plan_id,
           remaining_account, remaining_user, account_monthly_limit, account_per_request_limit, account_used_before,
           user_monthly_limit, user_per_request_limit, user_used_before, created_at)
         select $1, $2, 'blocker', $3, $4, 'ACCEPTED', a.plan_id, u.plan_id,
                greatest(0, ap.monthly_limit - $5::int - $3), greatest(0, up.monthly_limit - $6::int - $3),
                ap.monthly_limit, ap.per_request_limit, $5, up.monthly_limit, up.per_request_limit, $6, $7
         from accounts a join plans ap on ap.id = a.plan_id
         join users u on u.account_id = a.id and u.id = $2 join plans up on up.id = u.plan_id
         where a.id = $1`,
        [account.id, user!.id, units, MONTH, before!.a, before!.u, NOW],
      );
      await blocker.query('commit');
      return pending;
    }

    /** The statement each queued consume was waiting in, for the report: it must be the row lock. */
    const waitedIn: string[] = [];
    afterAll(() => {
      for (const q of waitedIn) expect(q.toLowerCase()).toMatch(/for update/);
    });

    it("the user's own total, updated while it waited: rejected by USER on the committed total", async () => {
      await setUp([10_000, 10], [10, 10], ['alice']);
      expect((await consume('alice', 1, 'warm')).body.status).toBe('ACCEPTED'); // creates both rows

      const res = await commitWhileWaiting('alice', 6, () => consume('alice', 5, 'after-wait'));

      // 1 + 6 committed while it waited; 7 + 5 > 10. Deciding on the stale 1 would accept and overspend.
      expect(res.body).toMatchObject({ status: 'REJECTED', reasonCode: 'MONTHLY_LIMIT_EXCEEDED', rejectedBy: 'USER', limit: 10 });
      const [row] = await testDb.db.select().from(requests).where(eq(requests.requestId, 'after-wait'));
      expect(row).toMatchObject({ userUsedBefore: 7, accountUsedBefore: 7 });
      expect(await userTotals()).toEqual({ alice: 7 });
      await checkLedger();
    });

    it('the account total, updated by another user while it waited: rejected by ACCOUNT on the committed total', async () => {
      await setUp([20, 10], [1_000, 10], ['alice', 'bob']);
      expect((await consume('alice', 1, 'warm-a')).body.status).toBe('ACCEPTED');
      expect((await consume('bob', 1, 'warm-b')).body.status).toBe('ACCEPTED');

      const res = await commitWhileWaiting('bob', 10, () => consume('alice', 9, 'after-wait'));

      // 2 + 10 committed while it waited; 12 + 9 > 20.
      expect(res.body).toMatchObject({ status: 'REJECTED', reasonCode: 'MONTHLY_LIMIT_EXCEEDED', rejectedBy: 'ACCOUNT', limit: 20 });
      const [row] = await testDb.db.select().from(requests).where(eq(requests.requestId, 'after-wait'));
      expect(row).toMatchObject({ accountUsedBefore: 12, userUsedBefore: 1 });
      expect(await accountTotal()).toBe(12);
      await checkLedger();
    });
  });
});
