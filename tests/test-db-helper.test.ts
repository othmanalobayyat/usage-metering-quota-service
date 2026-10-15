import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';

describe.skipIf(!(await dbAvailable()))('test-database helper', () => {
  let testDb: TestDb;
  const table = `zz_helper_probe_${process.pid}`;

  beforeAll(() => {
    testDb = createTestDb();
  });

  afterAll(async () => {
    await testDb.pool.query(`drop table if exists "${table}"`);
    await testDb.close();
  });

  it('pingDb succeeds against the test database', async () => {
    await expect(testDb.pingDb()).resolves.toBeUndefined();
  });

  it('resetDatabase empties public tables and restarts identities', async () => {
    await testDb.pool.query(`create table "${table}" (id serial primary key, v text)`);
    await testDb.pool.query(`insert into "${table}" (v) values ('a'), ('b')`);

    await resetDatabase(testDb.pool);

    const count = await testDb.pool.query(`select count(*)::int as n from "${table}"`);
    expect(count.rows[0].n).toBe(0);
    const next = await testDb.pool.query(`insert into "${table}" (v) values ('c') returning id`);
    expect(next.rows[0].id).toBe(1);
  });
});
