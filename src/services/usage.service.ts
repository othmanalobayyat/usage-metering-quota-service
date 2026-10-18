import { and, eq } from 'drizzle-orm';
import { accounts, accountUsage, plans, users, userUsage } from '../db/schema.js';
import { notFound } from '../errors/app-error.js';
import { toUtcMonth } from '../lib/month.js';
import type { ServiceDeps } from './deps.js';
import { usageView } from './views.js';

/**
 * Account usage for a month (default: the current UTC month), against the account's current
 * plan. A month with no usage row reads as 0; reading never creates one.
 */
export async function getAccountUsage({ db, now }: ServiceDeps, accountId: string, month?: Date) {
  const at = month ?? now();
  const [row] = await db
    .select({ plan: plans, unitsUsed: accountUsage.unitsUsed })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .leftJoin(
      accountUsage,
      and(eq(accountUsage.accountId, accounts.id), eq(accountUsage.month, toUtcMonth(at))),
    )
    .where(eq(accounts.id, accountId));
  if (!row) throw notFound('Account');
  return usageView(at, row.plan, row.unitsUsed);
}

/** One user's usage for a month against the user's current plan. Another account's user is a 404. */
export async function getUserUsage({ db, now }: ServiceDeps, accountId: string, externalUserId: string, month?: Date) {
  const at = month ?? now();
  const [row] = await db
    .select({ externalUserId: users.externalUserId, plan: plans, unitsUsed: userUsage.unitsUsed })
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
  return { externalUserId: row.externalUserId, ...usageView(at, row.plan, row.unitsUsed) };
}
