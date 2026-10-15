import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, dbAvailable, UNREACHABLE_DATABASE_URL, type TestDb } from './helpers/db.js';

describe.skipIf(!(await dbAvailable()))('GET /healthz against the real database', () => {
  let testDb: TestDb;

  beforeAll(() => {
    testDb = createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('returns 200 when the database is up', async () => {
    const app = createApp({ pingDb: testDb.pingDb });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });
});

describe('GET /healthz with a real driver and no database', () => {
  let testDb: TestDb;

  beforeAll(() => {
    testDb = createTestDb(UNREACHABLE_DATABASE_URL);
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('returns 503 when the database refuses connections', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({ pingDb: testDb.pingDb });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', db: 'down' });
  });
});
