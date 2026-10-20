import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QuotaApi } from '../client/src/quota-api.js';
import { externalUserIdSchema, requestIdSchema } from '../src/lib/schemas.js';

// `.` and `..` as externalUserId: URL dot segments, which `new URL()` resolves away (`/users/../plan`
// becomes `/plan`), so they're rejected. API and database behavior: tests/dot-segment-ids.db.test.ts.

const DOT_SEGMENTS = ['.', '..'];

/** IDs that look similar but aren't dot segments, so they stay valid. */
const DOT_LOOKALIKES = ['...', '.alice', 'alice.', 'a.b', '..alice', '%2E', '%2E%2E'];

describe('externalUserIdSchema and dot segments', () => {
  it.each(DOT_SEGMENTS)('rejects %j with its own message', (value) => {
    const result = externalUserIdSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['must not be "." or ".."']);
  });

  it.each(DOT_LOOKALIKES)('accepts %j unchanged', (value) => {
    expect(externalUserIdSchema.parse(value)).toBe(value);
  });

  it('requestId never goes in a URL path, so "." and ".." stay valid there', () => {
    for (const value of DOT_SEGMENTS) expect(requestIdSchema.parse(value)).toBe(value);
  });

  it('the existing rules still apply first', () => {
    expect(externalUserIdSchema.safeParse('').success).toBe(false);
    expect(externalUserIdSchema.safeParse(' .').success).toBe(false);
    expect(externalUserIdSchema.safeParse('x'.repeat(129)).success).toBe(false);
  });
});

describe('client QuotaApi user URLs', () => {
  let server: Server;
  let api: QuotaApi;
  let seen: { method?: string; url?: string }[];

  beforeAll(async () => {
    // Records the request line exactly as it arrived, then answers like PUT /users/:id/plan.
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ externalUserId: 'x' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = new QuotaApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'mk_test');
  });

  beforeEach(() => {
    seen = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('control: new URL() resolves dot segments, even percent-encoded', () => {
    const base = 'http://api:3000';
    expect(new URL('/users/../plan', base).pathname).toBe('/plan');
    expect(new URL('/users/./plan', base).pathname).toBe('/users/plan');
    expect(new URL('/users/%2E%2E/plan', base).pathname).toBe('/plan');
  });

  it.each([
    ['alice', '/users/alice/plan'],
    ['user/42 é', '/users/user%2F42%20%C3%A9/plan'],
    ['...', '/users/.../plan'],
    ['a.b', '/users/a.b/plan'],
    ['.alice', '/users/.alice/plan'],
    ['%2E%2E', '/users/%252E%252E/plan'],
  ])('setUserPlan(%j) → PUT %s', async (externalUserId, path) => {
    await api.setUserPlan(externalUserId, 'plan-id');
    expect(seen).toEqual([{ method: 'PUT', url: path }]);
  });

  it.each(DOT_SEGMENTS)('setUserPlan(%j) rejects without sending a request', async (externalUserId) => {
    await expect(api.setUserPlan(externalUserId, 'plan-id')).rejects.toThrow(
      `externalUserId "${externalUserId}" can't be used in a URL path`,
    );
    expect(seen).toEqual([]);
  });
});
