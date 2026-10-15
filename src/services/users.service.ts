import { and, asc, eq, sql } from 'drizzle-orm';
import { plans, users, userUsage } from '../db/schema.js';
import { DEFAULT_USER_PLAN_ID } from '../db/seed.js';
import { AppError, notFound } from '../errors/app-error.js';
import { encodeCursor, type Cursor } from '../lib/cursor.js';
import { toUtcMonth } from '../lib/month.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import type { ServiceDeps } from './deps.js';
import { resolveAssignablePlan, type Plan } from './plan-guard.js';
import { planView, usageView } from './views.js';

type User = typeof users.$inferSelect;

function userView(user: User, plan: Plan) {
  return {
    externalUserId: user.externalUserId,
    name: user.name,
    plan: planView(plan),
    createdAt: user.createdAt,
  };
}

export interface RegisterUserInput {
  externalUserId: string;
  name?: string;
  planId?: string;
}

/** Registers a user under the account. No planId means the default user plan (Basic). */
export async function registerUser({ db, now }: ServiceDeps, accountId: string, input: RegisterUserInput) {
  const plan = await resolveAssignablePlan(db, accountId, input.planId ?? DEFAULT_USER_PLAN_ID, 'USER');
  const createdAt = now();
  try {
    const [user] = await db
      .insert(users)
      .values({
        accountId,
        externalUserId: input.externalUserId,
        name: input.name ?? null,
        planId: plan.id,
        createdAt,
      })
      .returning();
    return { ...userView(user!, plan), usage: usageView(createdAt, plan, null) };
  } catch (err) {
    if (isUniqueViolation(err, 'users_account_id_external_user_id_unique')) {
      throw new AppError('ALREADY_EXISTS', `A user with externalUserId "${input.externalUserId}" already exists`);
    }
    throw err;
  }
}

/**
 * One page of the account's users, oldest first, keyed on (created_at, id). The id breaks
 * ties between users created in the same millisecond, so pages never skip or repeat a row.
 */
export async function listUsers({ db }: ServiceDeps, accountId: string, page: { limit: number; cursor?: Cursor }) {
  const after = page.cursor
    ? sql`(${users.createdAt}, ${users.id}) > (${page.cursor.createdAt.toISOString()}::timestamptz, ${page.cursor.id}::uuid)`
    : undefined;
  const rows = await db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.planId))
    .where(and(eq(users.accountId, accountId), after))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(page.limit + 1);

  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    data: items.map((r) => userView(r.user, r.plan)),
    nextCursor: rows.length > page.limit && last ? encodeCursor({ createdAt: last.user.createdAt, id: last.user.id }) : null,
  };
}

/** User, their current plan and this month's usage. Another account's user is a 404. */
export async function getUser({ db, now }: ServiceDeps, accountId: string, externalUserId: string) {
  const at = now();
  const [row] = await db
    .select({ user: users, plan: plans, unitsUsed: userUsage.unitsUsed })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.planId))
    .leftJoin(
      userUsage,
      and(
        eq(userUsage.accountId, users.accountId),
        eq(userUsage.userId, users.id),
        eq(userUsage.month, toUtcMonth(at)),
      ),
    )
    .where(and(eq(users.accountId, accountId), eq(users.externalUserId, externalUserId)));
  if (!row) throw notFound('User');
  return { ...userView(row.user, row.plan), usage: usageView(at, row.plan, row.unitsUsed) };
}

/** Switches a user's plan. Their usage this month carries over unchanged. */
export async function setUserPlan(deps: ServiceDeps, accountId: string, externalUserId: string, planId: string) {
  const byExternalId = and(eq(users.accountId, accountId), eq(users.externalUserId, externalUserId));
  const [user] = await deps.db.select({ id: users.id }).from(users).where(byExternalId);
  if (!user) throw notFound('User');
  const plan = await resolveAssignablePlan(deps.db, accountId, planId, 'USER');
  await deps.db.update(users).set({ planId: plan.id }).where(byExternalId);
  return getUser(deps, accountId, externalUserId);
}
