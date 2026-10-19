/** The PostgreSQL error behind a failed query, if any. Drizzle wraps the pg error in `cause`. */
export function pgErrorOf(err: unknown): { code: string; constraint?: string } | undefined {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return e as unknown as { code: string; constraint?: string };
  }
  return undefined;
}

/** lock_timeout (55P03) and a statement cancel such as statement_timeout (57014). */
const OVERLOAD_SQLSTATES = new Set(['55P03', '57014']);

/**
 * pg-pool's error when no pooled connection came free within connectionTimeoutMillis. Its
 * other timeout, "Connection terminated due to connection timeout", means a new connection
 * couldn't be opened at all; the database may be down, so that one stays a 500.
 */
const POOL_WAIT_TIMEOUT = 'timeout exceeded when trying to connect';

/**
 * True if `err` means the database is too busy right now, not that something is broken: a
 * wait for a free pooled connection that timed out, a lock_timeout or a statement cancel.
 * Such a request wrote nothing (its transaction rolled back), so retrying it is safe.
 * Drizzle may wrap the error.
 */
export function isOverloadError(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && OVERLOAD_SQLSTATES.has(code)) return true;
    if (e.message === POOL_WAIT_TIMEOUT) return true;
  }
  return false;
}

/** True if `err` is a unique violation (23505) on the named constraint. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = pgErrorOf(err);
  return pg?.code === '23505' && pg.constraint === constraint;
}
