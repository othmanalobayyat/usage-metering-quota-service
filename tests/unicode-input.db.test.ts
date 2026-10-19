import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, accountUsage, plans, requests, users, userUsage } from '../src/db/schema.js';
import { PREDEFINED_PLAN_IDS } from '../src/db/seed.js';
import { createCustomPlan, createTestApp, expectError, signUp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

// F10 (docs/QA_REPORT.md): lone UTF-16 surrogates in caller-supplied strings reach node-postgres,
// which encodes them as U+FFFD, so distinct IDs collide. Test IDs are from docs/TEST_PLAN.md §4.
// Ill-formed UTF-16 is rejected like NUL (400 in a body or query, 404 in a path; decision D1), and
// so is a body that isn't valid UTF-8 (400; D2). The F10 cases failed before the fix (QA_REPORT
// rev 3); the valid-Unicode cases guard against a fix that also rejects well-formed text.

const FFFD = '\ufffd';

/** Set S (TEST_PLAN §2): every shape of lone surrogate. */
const ILL_FORMED: [label: string, value: string][] = [
  ['lone high \\ud800', '\ud800'],
  ['lone low \\udfff', '\udfff'],
  ['lone low \\udc00', '\udc00'],
  ['embedded high a\\udbffb', 'a\udbffb'],
  ['reversed pair \\ude00\\ud83d', '\ude00\ud83d'],
  ['pair then lone high 👍\\ud83d', '👍\ud83d'],
];

/** A JSON body as raw bytes, so invalid UTF-8 reaches express.json() as-is. */
function rawJson(...parts: (string | number[])[]): Buffer {
  return Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part))));
}

/** The parts of a /consume response that tell a fresh decision, a replay and an error apart. */
function outcome(res: request.Response) {
  return { status: res.status, code: res.body.error?.code, replayed: res.body.replayed };
}

const REJECTED_AS_INVALID = { status: 400, code: 'VALIDATION_ERROR', replayed: undefined };

describe.skipIf(!(await dbAvailable()))('F10: Unicode in identifiers and names', () => {
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
    // Identity serializer: with a JSON Content-Type, superagent would otherwise JSON.stringify a
    // Buffer into {"type":"Buffer","data":[…]} instead of sending its bytes.
    raw: (path: string, body: Buffer | string) =>
      request(app)
        .post(path)
        .set('X-API-Key', apiKey)
        .set('Content-Type', 'application/json')
        .serialize((data) => data)
        .send(body),
  });

  const consume = (externalUserId: string, units: number, requestId: string) =>
    as().post('/consume', { externalUserId, units, requestId });

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

  async function accountConsumed(): Promise<number> {
    return (await as().get('/usage')).body.consumed;
  }

  async function userConsumed(externalUserId: string): Promise<number> {
    const res = await as().get(`/users/${encodeURIComponent(externalUserId)}/usage`);
    expect(res.status).toBe(200);
    return res.body.consumed;
  }

  describe('§4.2 lone surrogates in a JSON body', () => {
    it.each(ILL_FORMED)('TP-ENC-01: POST /consume requestId %s → 400 and nothing written', async (_label, value) => {
      const before = await counts();
      const res = await consume('alice', 1, value);
      expect(outcome(res)).toEqual(REJECTED_AS_INVALID);
      expect(res.body.error.message).toMatch(/^requestId:/);
      expect(await counts()).toEqual(before);
      expectNoUnhandledError();
    });

    it.each(ILL_FORMED)(
      'TP-ENC-02: POST /consume externalUserId %s → 400, not charged to a registered "\\ufffd" user',
      async (_label, value) => {
        expect((await as().post('/users', { externalUserId: FFFD })).status).toBe(201);
        const before = await counts();
        const res = await consume(value, 1, 'r');
        expect(outcome(res)).toEqual(REJECTED_AS_INVALID);
        expect(res.body.error.message).toMatch(/^externalUserId:/);
        expect(await userConsumed(FFFD)).toBe(0);
        expect(await counts()).toEqual(before);
        expectNoUnhandledError();
      },
    );

    it.each(ILL_FORMED)('TP-ENC-03: POST /users externalUserId %s → 400 and no user created', async (_label, value) => {
      const before = await counts();
      const res = await as().post('/users', { externalUserId: value });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/^externalUserId:/);
      expect(await counts()).toEqual(before);
      expectNoUnhandledError();
    });

    describe.each(ILL_FORMED)('TP-ENC-04: name %s', (_label, value) => {
      it.each([
        ['POST /accounts (no key)', () => request(app).post('/accounts').send({ name: value })],
        ['POST /plans', () => as().post('/plans', { name: value, type: 'USER', monthlyLimit: 1, perRequestLimit: 1 })],
        ['PATCH /plans/:id', () => as().patch(`/plans/${customPlanId}`, { name: value })],
        ['POST /users', () => as().post('/users', { externalUserId: 'bob', name: value })],
      ])('%s → 400 and nothing written', async (_route, send) => {
        const before = await counts();
        const res = await send();
        expectError(res, 400, 'VALIDATION_ERROR');
        expect(res.body.error.message).toMatch(/^name:/);
        expect(await counts()).toEqual(before);
        expect((await as().get(`/plans/${customPlanId}`)).body.name).toBe('Custom');
        expectNoUnhandledError();
      });
    });

    it('TP-ERR-03: auth still runs first: lone-surrogate requestId with no key → 401', async () => {
      const res = await request(app).post('/consume').send({ externalUserId: 'alice', units: 1, requestId: '\ud800' });
      expectError(res, 401, 'UNAUTHORIZED');
    });
  });

  describe('§4.4 distinct malformed IDs are never an idempotent replay', () => {
    it('TP-IDEM-01: requestId "\\ud800" then "\\udfff" (same units) → both 400, nothing consumed', async () => {
      const first = await consume('alice', 1, '\ud800');
      const second = await consume('alice', 1, '\udfff');
      expect([outcome(first), outcome(second)]).toEqual([REJECTED_AS_INVALID, REJECTED_AS_INVALID]);
      expect(await accountConsumed()).toBe(0);
      expect(await userConsumed('alice')).toBe(0);
      expect(await testDb.db.$count(requests)).toBe(0);
      expectNoUnhandledError();
    });

    it('TP-IDEM-02: requestId "\\ud800" (1 unit) then "\\udc00" (2 units) → both 400, never 409', async () => {
      const first = await consume('alice', 1, '\ud800');
      const second = await consume('alice', 2, '\udc00');
      expect([outcome(first), outcome(second)]).toEqual([REJECTED_AS_INVALID, REJECTED_AS_INVALID]);
      expect(await testDb.db.$count(requests)).toBe(0);
      expectNoUnhandledError();
    });

    it('TP-IDEM-03: a legitimate "r\\ufffd" key is not shadowed by "r\\ud800"', async () => {
      const first = await consume('alice', 1, `r${FFFD}`);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ requestId: `r${FFFD}`, status: 'ACCEPTED', replayed: false });

      const malformed = await consume('alice', 1, 'r\ud800');
      expect(outcome(malformed)).toEqual(REJECTED_AS_INVALID);

      const retry = await consume('alice', 1, `r${FFFD}`);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ ...first.body, replayed: true });

      expect(await accountConsumed()).toBe(1);
      expect(await userConsumed('alice')).toBe(1);
      expectNoUnhandledError();
    });

    it('TP-IDEM-04: user "\\ud800" is not refused as a duplicate of "\\ufffd", and "\\udbff" is not charged to it', async () => {
      expect((await as().post('/users', { externalUserId: FFFD })).status).toBe(201);

      const register = await as().post('/users', { externalUserId: '\ud800' });
      expect({ status: register.status, code: register.body.error?.code }).toEqual({
        status: 400,
        code: 'VALIDATION_ERROR',
      });

      const charge = await consume('\udbff', 1, 'u1');
      expect(outcome(charge)).toEqual(REJECTED_AS_INVALID);
      expect(await userConsumed(FFFD)).toBe(0);
      expect(await accountConsumed()).toBe(0);
      expectNoUnhandledError();
    });
  });

  describe('§4.2 TP-ENC-08: raw invalid UTF-8 bytes in a JSON body', () => {
    // express.json() decodes with iconv-lite, which turns each invalid sequence into U+FFFD, so distinct
    // byte strings would arrive as the same well-formed string (TEST_PLAN P4). The raw bytes are checked first.
    const ffBody = rawJson('{"externalUserId":"alice","units":1,"requestId":"r', [0xff], '"}');
    const feBody = rawJson('{"externalUserId":"alice","units":1,"requestId":"r', [0xfe], '"}');

    it('requestId "r"+FF then "r"+FE → both 400, never a replay', async () => {
      const first = await as().raw('/consume', ffBody);
      const second = await as().raw('/consume', feBody);
      expect([outcome(first), outcome(second)]).toEqual([REJECTED_AS_INVALID, REJECTED_AS_INVALID]);
      expect(await accountConsumed()).toBe(0);
      expect(await testDb.db.$count(requests)).toBe(0);
      expectNoUnhandledError();
    });

    it('an encoded surrogate (CESU-8 ED A0 80 vs ED B0 80) in requestId → both 400, never a replay', async () => {
      const high = rawJson('{"externalUserId":"alice","units":1,"requestId":"r', [0xed, 0xa0, 0x80], '"}');
      const low = rawJson('{"externalUserId":"alice","units":1,"requestId":"r', [0xed, 0xb0, 0x80], '"}');
      const first = await as().raw('/consume', high);
      const second = await as().raw('/consume', low);
      expect([outcome(first), outcome(second)]).toEqual([REJECTED_AS_INVALID, REJECTED_AS_INVALID]);
      expect(await accountConsumed()).toBe(0);
      expectNoUnhandledError();
    });

    it('"r"+FF does not replay a legitimate "r\\ufffd" request (sent as valid UTF-8 EF BF BD)', async () => {
      // Also the positive control for as().raw(): valid bytes must arrive and be accepted.
      const legit = await as().raw('/consume', rawJson('{"externalUserId":"alice","units":1,"requestId":"r', [0xef, 0xbf, 0xbd], '"}'));
      expect(legit.status).toBe(200);
      expect(legit.body).toMatchObject({ requestId: `r${FFFD}`, status: 'ACCEPTED', replayed: false });

      const res = await as().raw('/consume', ffBody);
      expect(outcome(res)).toEqual(REJECTED_AS_INVALID);
      expect(await accountConsumed()).toBe(1);
      expectNoUnhandledError();
    });

    it('a legitimate "r\\ufffd" request is not answered as a replay of an earlier "r"+FF', async () => {
      await as().raw('/consume', ffBody);
      const legit = await consume('alice', 1, `r${FFFD}`);
      expect(legit.status).toBe(200);
      expect(legit.body).toMatchObject({ requestId: `r${FFFD}`, status: 'ACCEPTED', replayed: false });
      expect(await accountConsumed()).toBe(1);
      expectNoUnhandledError();
    });

    it('externalUserId FF is neither registered as nor charged to a "\\ufffd" user', async () => {
      expect((await as().post('/users', { externalUserId: FFFD })).status).toBe(201);
      const before = await counts();

      const register = await as().raw('/users', rawJson('{"externalUserId":"', [0xff], '"}'));
      expect({ status: register.status, code: register.body.error?.code }).toEqual({
        status: 400,
        code: 'VALIDATION_ERROR',
      });

      const charge = await as().raw('/consume', rawJson('{"externalUserId":"', [0xfe], '","units":1,"requestId":"x"}'));
      expect(outcome(charge)).toEqual(REJECTED_AS_INVALID);
      expect(await userConsumed(FFFD)).toBe(0);
      expect(await counts()).toEqual(before);
      expectNoUnhandledError();
    });
  });

  describe('§4.2 query and path inputs (they can never carry a lone surrogate)', () => {
    it('TP-ENC-06: invalid UTF-8 escapes in a query value', async () => {
      // node:querystring decodes them leniently to U+FFFD: an unknown user, or not a month.
      for (const path of ['/requests?externalUserId=%ED%A0%80', '/requests?externalUserId=%FF']) {
        const res = await as().get(path);
        expectError(res, 404, 'NOT_FOUND');
        expect(res.body.error.message).toBe('User not found');
      }
      expectError(await as().get('/usage?month=%ED%A0%80'), 400, 'VALIDATION_ERROR');
      expectNoUnhandledError();
    });

    it('TP-ENC-06 (characterization, D4): with a "\\ufffd" user, ?externalUserId=%FF reads that user', async () => {
      expect((await as().post('/users', { externalUserId: FFFD })).status).toBe(201);
      expect((await consume(FFFD, 1, 'q1')).body.status).toBe('ACCEPTED');
      const res = await as().get('/requests?externalUserId=%FF');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ requestId: 'q1', externalUserId: FFFD });
    });

    it('TP-ENC-07: cursors made of invalid escapes → 400 invalid cursor', async () => {
      for (const path of ['/requests?cursor=%ED%A0%80', '/users?cursor=%FF']) {
        const res = await as().get(path);
        expectError(res, 400, 'VALIDATION_ERROR');
        expect(res.body.error.message).toBe('cursor: invalid cursor');
      }
      expectNoUnhandledError();
    });

    it('TP-REG-03 (F10 subset): an encoded lone surrogate in a path → 404 User not found', async () => {
      for (const param of ['%ED%A0%80', '%ED%B0%80']) {
        for (const res of [
          await as().get(`/users/${param}`),
          await as().get(`/users/${param}/usage`),
          await as().put(`/users/${param}/plan`, { planId: PREDEFINED_PLAN_IDS.PREMIUM }),
        ]) {
          expectError(res, 404, 'NOT_FOUND');
          expect(res.body.error.message).toBe('User not found');
        }
      }
      expectNoUnhandledError();
    });
  });

  describe('§4.4–§4.5 valid Unicode and surrogate pairs keep working', () => {
    it('TP-UTF-01: a 👍 user round-trips through register, get, usage, plan change and list', async () => {
      const path = `/users/${encodeURIComponent('👍')}`;
      expect(path).toBe('/users/%F0%9F%91%8D');

      const created = await as().post('/users', { externalUserId: '👍', name: 'Thumbs 👍' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ externalUserId: '👍', name: 'Thumbs 👍' });

      const got = await as().get(path);
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({ externalUserId: '👍', name: 'Thumbs 👍' });

      const usage = await as().get(`${path}/usage`);
      expect(usage.status).toBe(200);
      expect(usage.body.externalUserId).toBe('👍');

      const plan = await as().put(`${path}/plan`, { planId: PREDEFINED_PLAN_IDS.PREMIUM });
      expect(plan.status).toBe(200);
      expect(plan.body).toMatchObject({ externalUserId: '👍', plan: { id: PREDEFINED_PLAN_IDS.PREMIUM } });

      const list = await as().get('/users');
      expect(list.body.data.map((u: { externalUserId: string }) => u.externalUserId)).toContain('👍');
    });

    it('TP-UTF-02: consume for 👍 with requestId "📄-1" is recorded and listed unchanged', async () => {
      expect((await as().post('/users', { externalUserId: '👍' })).status).toBe(201);

      const res = await consume('👍', 10, '📄-1');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ requestId: '📄-1', status: 'ACCEPTED', replayed: false });

      const history = await as().get('/requests?externalUserId=%F0%9F%91%8D');
      expect(history.status).toBe(200);
      expect(history.body.data).toHaveLength(1);
      expect(history.body.data[0]).toMatchObject({ requestId: '📄-1', externalUserId: '👍', units: 10 });
      expect(await userConsumed('👍')).toBe(10);
      expect(await accountConsumed()).toBe(10);
    });

    it('TP-IDEM-05: valid pairs sharing a high surrogate (😀, 😁) are distinct keys and users', async () => {
      const grin = '\ud83d\ude00';
      const beam = '\ud83d\ude01';

      expect((await consume('alice', 1, grin)).body).toMatchObject({ requestId: grin, replayed: false });
      expect((await consume('alice', 1, beam)).body).toMatchObject({ requestId: beam, replayed: false });
      expect(await accountConsumed()).toBe(2);
      expect(await testDb.db.$count(requests)).toBe(2);

      expect((await as().post('/users', { externalUserId: grin })).status).toBe(201);
      expect((await as().post('/users', { externalUserId: beam })).status).toBe(201);
      expect((await as().get(`/users/${encodeURIComponent(beam)}`)).body.externalUserId).toBe(beam);
    });

    it('TP-IDEM-06: the same key as raw UTF-8 and as a JSON \\u escape is a true retry', async () => {
      const first = await as().raw('/consume', '{"externalUserId":"alice","units":1,"requestId":"😀"}');
      expect(first.body).toMatchObject({ requestId: '😀', status: 'ACCEPTED', replayed: false });

      const escaped = await as().raw('/consume', String.raw`{"externalUserId":"alice","units":1,"requestId":"\ud83d\ude00"}`);
      expect(escaped.status).toBe(200);
      expect(escaped.body).toEqual({ ...first.body, replayed: true });
      expect(await accountConsumed()).toBe(1);
    });

    it('TP-IDEM-07: no Unicode normalization: "é" (U+00E9) and "e\\u0301" are distinct keys and users', async () => {
      const precomposed = '\u00e9';
      const combining = 'e\u0301';

      expect((await consume('alice', 1, precomposed)).body.replayed).toBe(false);
      expect((await consume('alice', 1, combining)).body.replayed).toBe(false);
      expect(await accountConsumed()).toBe(2);

      expect((await as().post('/users', { externalUserId: precomposed })).status).toBe(201);
      expect((await as().post('/users', { externalUserId: combining })).status).toBe(201);
    });
  });

  it('TP-IDEM-09 (canary): node-postgres sends distinct lone surrogates as the same U+FFFD text', async () => {
    // Root cause of F10: why the guard has to be in the app. Changes only if node-postgres changes.
    const { rows } = await testDb.pool.query<{ same: boolean; hex: string }>(
      `select $1::text = $2::text as same, encode(convert_to($1::text, 'UTF8'), 'hex') as hex`,
      ['\ud800', '\udfff'],
    );
    expect(rows[0]).toEqual({ same: true, hex: 'efbfbd' });
  });
});
