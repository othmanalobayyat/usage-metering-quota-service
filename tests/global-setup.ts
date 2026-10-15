import pg from 'pg';
import { createDb, createPool } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedPlans } from '../src/db/seed.js';
import { systemClock } from '../src/lib/clock.js';
import { dbAvailable, TEST_DATABASE_URL } from './helpers/db.js';

/**
 * Runs once before all test files: creates the test database if it's missing, then
 * migrates and seeds it. When the server is unreachable this does nothing and the
 * integration suites skip themselves (or fail, with REQUIRE_DB=1).
 */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  // Tests truncate every table; refuse anything that doesn't look like a throwaway database.
  if (!dbName.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must name a database ending in "_test", got "${dbName}"`);
  }

  if (!(await serverReachable(url))) {
    await dbAvailable(); // throws under REQUIRE_DB=1, otherwise warns
    return;
  }

  await createDatabaseIfMissing(url, dbName);

  const pool = createPool(TEST_DATABASE_URL);
  try {
    const db = createDb(pool);
    await runMigrations(db);
    await seedPlans(db, systemClock);
  } finally {
    await pool.end();
  }
}

/** A URL for the same server's `postgres` maintenance database. */
function maintenanceUrl(url: URL): string {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return admin.toString();
}

async function serverReachable(url: URL): Promise<boolean> {
  const client = new pg.Client({ connectionString: maintenanceUrl(url), connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function createDatabaseIfMissing(url: URL, dbName: string): Promise<void> {
  const client = new pg.Client({ connectionString: maintenanceUrl(url) });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (rowCount === 0) {
      await client.query(`create database "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}
