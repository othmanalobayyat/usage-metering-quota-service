import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDemo } from '../client/src/demo.js';
import { QuotaApi } from '../client/src/quota-api.js';
import { createTestApp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

// Runs the example client's Phase 5 demo over real HTTP, so a change that breaks it fails the suite.
describe.skipIf(!(await dbAvailable()))('example client demo', () => {
  let testDb: TestDb;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    testDb = createTestDb();
    await resetDatabase(testDb.pool);
    const app = createTestApp(testDb);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await testDb.close();
  });

  it('runs every step and each one passes', async () => {
    const run = await runDemo(new QuotaApi(baseUrl));

    expect(run.error).toBeNull();
    expect(run.account).not.toBeNull();
    expect(run.steps.length).toBeGreaterThan(0);
    // Listing the failures makes a broken step readable in the test output.
    expect(run.steps.filter((s) => !s.ok)).toEqual([]);
    expect(run.ok).toBe(true);
  });
});
