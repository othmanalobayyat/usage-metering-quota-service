import { sql } from 'drizzle-orm';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const pool = createPool(config.DATABASE_URL);
// Idle clients can error when the DB restarts; log instead of crashing the process.
pool.on('error', (err) => console.error('pg pool error', err));
const db = createDb(pool);

const app = createApp({
  pingDb: async () => {
    await db.execute(sql`select 1`);
  },
});

const server = app.listen(config.PORT, () => {
  console.log(`quota-service listening on port ${config.PORT}`);
});

const SHUTDOWN_TIMEOUT_MS = 10_000;

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  // Don't let open connections block exit forever; unref so the timer itself doesn't keep the process alive.
  setTimeout(() => {
    console.error(`graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
