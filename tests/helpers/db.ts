import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { DbPing } from '../../src/routes/health.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';

/**
 * Shared test-database helper for integration tests.
 *
 * Points at the Compose PostgreSQL by default (`docker compose up -d db`).
 * Override with TEST_DATABASE_URL. DATABASE_URL is deliberately not used, so a
 * test run can't truncate a dev database by accident.
 *
 * Integration suites skip when the DB is unreachable. Set REQUIRE_DB=1 (e.g. in CI)
 * to make an unreachable DB a hard failure instead of a skip.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://quota:quota@localhost:5433/quota';

/** A URL nothing listens on, for exercising the "DB is down" path with a real driver. */
export const UNREACHABLE_DATABASE_URL = 'postgres://quota:quota@127.0.0.1:1/quota';

export interface TestDb {
  pool: pg.Pool;
  db: Db;
  /** Same check server.ts wires into /healthz. */
  pingDb: DbPing;
  close: () => Promise<void>;
}

/** Builds a pool + Drizzle instance the same way the server does. Call `close()` in afterAll. */
export function createTestDb(databaseUrl: string = TEST_DATABASE_URL): TestDb {
  const pool = createPool(databaseUrl);
  // Mirror server.ts: an idle-client error must not crash the test process.
  pool.on('error', () => {});
  const db = createDb(pool);
  return {
    pool,
    db,
    pingDb: async () => {
      await db.execute(sql`select 1`);
    },
    close: () => pool.end(),
  };
}

let reachable: Promise<boolean> | undefined;

/** True if the test DB accepts connections. Probed once per test file. */
export function isDatabaseReachable(): Promise<boolean> {
  reachable ??= (async () => {
    const client = new pg.Client({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await client.connect();
      await client.query('select 1');
      return true;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => {});
    }
  })();
  return reachable;
}

/**
 * Resolves to true when integration tests should run; use with `describe.skipIf(!(await dbAvailable()))`.
 * Throws instead of skipping when REQUIRE_DB=1.
 */
export async function dbAvailable(): Promise<boolean> {
  const ok = await isDatabaseReachable();
  if (!ok && process.env.REQUIRE_DB === '1') {
    throw new Error(`REQUIRE_DB=1 but the test database is unreachable at ${TEST_DATABASE_URL}`);
  }
  if (!ok) {
    console.warn(
      `Skipping DB integration tests: ${TEST_DATABASE_URL} is unreachable (run \`docker compose up -d db\`).`,
    );
  }
  return ok;
}

/**
 * Empties every table in the public schema and resets identities, so each test starts clean.
 * Drizzle keeps its migration journal in the `drizzle` schema, so migrations survive this.
 * Note: with the default URL this wipes the Compose DB's data.
 */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ');
  await pool.query(`truncate table ${tables} restart identity cascade`);
}
