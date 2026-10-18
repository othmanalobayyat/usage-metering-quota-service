import { and, desc, eq, sql } from 'drizzle-orm';
import { requests, users } from '../db/schema.js';
import { notFound } from '../errors/app-error.js';
import { encodeCursor, type Cursor } from '../lib/cursor.js';
import { toUtcMonth } from '../lib/month.js';
import type { ServiceDeps } from './deps.js';

type RequestRow = typeof requests.$inferSelect;

/** One history entry: the stored decision and its snapshot, as it was when decided. */
function historyView(row: RequestRow, externalUserId: string) {
  return {
    requestId: row.requestId,
    externalUserId,
    units: row.units,
    month: row.month.slice(0, 7),
    status: row.status,
    reasonCode: row.reasonCode,
    rejectedBy: row.rejectedBy,
    limit: row.limitValue,
    remaining: { account: row.remainingAccount, user: row.remainingUser },
    accountPlanId: row.accountPlanId,
    userPlanId: row.userPlanId,
    createdAt: row.createdAt,
  };
}

export interface HistoryQuery {
  externalUserId?: string;
  /** Any instant in the month to filter on. */
  month?: Date;
  limit: number;
  cursor?: Cursor;
}

/**
 * One page of the account's decisions, newest first, keyed on (created_at, id) like GET /users.
 * No filter, `month` alone and `externalUserId` alone each have a history index (docs/PLAN.md §3)
 * read in index order: no Sort, and a page costs `limit` rows however deep it is. No index
 * covers externalUserId + month together: that uses the user index and filters month row by row.
 */
export async function listRequests({ db }: ServiceDeps, accountId: string, query: HistoryQuery) {
  let userId: string | undefined;
  if (query.externalUserId !== undefined) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.accountId, accountId), eq(users.externalUserId, query.externalUserId)));
    if (!user) throw notFound('User');
    userId = user.id;
  }

  const before = query.cursor
    ? sql`(${requests.createdAt}, ${requests.id}) < (${query.cursor.createdAt.toISOString()}::timestamptz, ${query.cursor.id}::uuid)`
    : undefined;
  const rows = await db
    .select({ request: requests, externalUserId: users.externalUserId })
    .from(requests)
    .innerJoin(users, and(eq(users.accountId, requests.accountId), eq(users.id, requests.userId)))
    .where(
      and(
        eq(requests.accountId, accountId),
        userId === undefined ? undefined : eq(requests.userId, userId),
        query.month === undefined ? undefined : eq(requests.month, toUtcMonth(query.month)),
        before,
      ),
    )
    .orderBy(desc(requests.createdAt), desc(requests.id))
    .limit(query.limit + 1);

  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    data: items.map((r) => historyView(r.request, r.externalUserId)),
    nextCursor:
      rows.length > query.limit && last ? encodeCursor({ createdAt: last.request.createdAt, id: last.request.id }) : null,
  };
}
