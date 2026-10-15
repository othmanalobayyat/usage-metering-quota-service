/** The PostgreSQL error behind a failed query, if any. Drizzle wraps the pg error in `cause`. */
export function pgErrorOf(err: unknown): { code: string; constraint?: string } | undefined {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return e as unknown as { code: string; constraint?: string };
  }
  return undefined;
}

/** True if `err` is a unique violation (23505) on the named constraint. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = pgErrorOf(err);
  return pg?.code === '23505' && pg.constraint === constraint;
}
