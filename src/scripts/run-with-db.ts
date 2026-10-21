import { loadConfig } from '../config.js';
import { createDb, createMaintenancePool, type Db } from '../db/client.js';

/**
 * Runs a one-off DB task against DATABASE_URL, then closes the pool. Exits 1 on any failure.
 * Uses the maintenance pool, not the request pool, so a long migration isn't cancelled at 4s.
 */
export async function runWithDb(name: string, task: (db: Db) => Promise<void>): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const pool = createMaintenancePool(config.DATABASE_URL);
  try {
    await task(createDb(pool));
  } catch (err) {
    console.error(`${name} failed`, err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
