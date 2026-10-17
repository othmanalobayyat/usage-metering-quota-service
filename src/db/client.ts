import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Fail fast instead of hanging when the DB is unreachable (keeps /healthz responsive).
    connectionTimeoutMillis: 2_000,
    // Client-side cap on any query, so a stalled DB can't hang a request (including /healthz).
    query_timeout: 5_000,
    // Server-side timeouts below query_timeout, so Postgres cancels a slow statement and the
    // session stays usable (ROLLBACK works) before the client-side timer ever fires.
    lock_timeout: 3_000,
    statement_timeout: 4_000,
    // A transaction left open by a vanished client is ended and its row locks released.
    idle_in_transaction_session_timeout: 10_000,
  });
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool);
}

export type Db = ReturnType<typeof createDb>;
export type Tx = NodePgDatabase;

/**
 * BEGIN … COMMIT on one pooled client. Drizzle's db.transaction() always returns the client
 * to the pool, even when its ROLLBACK failed. With the client-side query_timeout a ROLLBACK
 * can time out unsent and leave the session inside the transaction; the next request on that
 * client would then commit our partial writes. So if ROLLBACK fails, or the connection
 * errors while checked out, the client is destroyed instead of reused.
 */
export async function inTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.$client.connect();
  let broken = false;
  // pg-pool only listens for errors on idle clients. Without this, a connection error
  // while checked out (e.g. the server terminates the backend) would crash the process.
  const onError = () => {
    broken = true;
  };
  client.on('error', onError);
  try {
    await client.query('begin');
    const result = await work(drizzle(client));
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

/** The /healthz DB check: one round trip that fails if the database is unreachable. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
