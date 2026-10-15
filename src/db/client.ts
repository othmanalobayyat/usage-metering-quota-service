import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Fail fast instead of hanging when the DB is unreachable (keeps /healthz responsive).
    connectionTimeoutMillis: 2_000,
    // Client-side cap on any query, so a stalled DB can't hang a request (including /healthz).
    query_timeout: 5_000,
  });
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool);
}

export type Db = ReturnType<typeof createDb>;
