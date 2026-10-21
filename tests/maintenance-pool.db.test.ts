import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '../src/db/client.js';
import { pgErrorOf } from '../src/lib/pg-error.js';
import { runWithDb } from '../src/scripts/run-with-db.js';
import { dbAvailable, TEST_DATABASE_URL } from './helpers/db.js';

// The container migrates and seeds through runWithDb (src/scripts/{migrate,seed}.ts). A migration
// that runs longer than the request pool's 4s statement_timeout must still complete there.

/** One statement longer than createPool()'s statement_timeout (4s). */
const SLOW_SECONDS = 4.5;

describe.skipIf(!(await dbAvailable()))('maintenance pool (migrate and seed)', () => {
  let folder: string;
  // The probe's own journal schema, so quota_test's real drizzle.__drizzle_migrations is never touched.
  const schema = `migrate_probe_${process.pid}`;
  const migrationConfig = () => ({ migrationsFolder: folder, migrationsSchema: schema, migrationsTable: 'probe_migrations' });

  beforeAll(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'slow-migration-'));
    mkdirSync(path.join(folder, 'meta'));
    const journal = { version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', when: 1, tag: '0000_slow', breakpoints: true }] };
    writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    writeFileSync(path.join(folder, '0000_slow.sql'), `SELECT pg_sleep(${SLOW_SECONDS});`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const pool = createPool(TEST_DATABASE_URL);
    try {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    } finally {
      await pool.end();
    }
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** Runs `task` through runWithDb, as the entrypoint does, and reports whether it completed. */
  async function throughEntrypoint(task: (db: Db) => Promise<void>): Promise<boolean> {
    vi.stubEnv('DATABASE_URL', TEST_DATABASE_URL);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = process.exitCode;
    let completed = false;
    try {
      await runWithDb('probe', async (db) => {
        await task(db);
        completed = true;
      });
    } finally {
      // runWithDb sets exitCode 1 on failure; don't let that fail the test process.
      process.exitCode = exitCode;
    }
    return completed;
  }

  async function appliedProbeMigrations(): Promise<number> {
    const pool = createPool(TEST_DATABASE_URL);
    try {
      const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from "${schema}".probe_migrations`);
      return rows[0]!.n;
    } finally {
      await pool.end();
    }
  }

  it('runWithDb sessions get the maintenance timeouts, not the request ones', async () => {
    let settings: unknown;
    const completed = await throughEntrypoint(async (db) => {
      const result = await db.execute(
        sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock,
                   current_setting('idle_in_transaction_session_timeout') as idle`,
      );
      settings = result.rows[0];
    });
    expect(completed).toBe(true);
    expect(settings).toEqual({ statement: '15min', lock: '1min', idle: '1min' });

    // Control: the request pool is unchanged.
    const pool = createPool(TEST_DATABASE_URL);
    try {
      const { rows } = await pool.query(`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`);
      expect(rows[0]).toEqual({ statement: '4s', lock: '3s' });
    } finally {
      await pool.end();
    }
  });

  it(`control: the request pool cancels a ${SLOW_SECONDS}s migration, and the migration rolls back`, async () => {
    const pool = createPool(TEST_DATABASE_URL);
    let error: unknown;
    try {
      await migrate(createDb(pool), migrationConfig());
    } catch (err) {
      error = err;
    } finally {
      await pool.end();
    }
    expect(pgErrorOf(error)?.code).toBe('57014');
    expect(await appliedProbeMigrations()).toBe(0);
  }, 20_000);

  it(`a ${SLOW_SECONDS}s migration completes through runWithDb, the container's migrate path`, async () => {
    const completed = await throughEntrypoint((db) => migrate(db, migrationConfig()));
    expect(completed).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
    expect(await appliedProbeMigrations()).toBe(1);
  }, 20_000);
});
