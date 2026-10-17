import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { inTransaction, type Db, type Tx } from '../db/client.js';
import { accounts, accountUsage, plans, requests, users, userUsage } from '../db/schema.js';
import { AppError, notFound } from '../errors/app-error.js';
import { toUtcMonth } from '../lib/month.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import type { ServiceDeps } from './deps.js';
import { evaluate } from './rules.js';

type RequestRow = typeof requests.$inferSelect;

export interface ConsumeInput {
  externalUserId: string;
  units: number;
  requestId: string;
}

/**
 * The API shape of a decision, always built from the stored request row, so a replay is
 * identical to the original response except for `replayed`.
 */
function decisionView(row: RequestRow, replayed: boolean) {
  return {
    requestId: row.requestId,
    status: row.status,
    reasonCode: row.reasonCode,
    rejectedBy: row.rejectedBy,
    limit: row.limitValue,
    remaining: { account: row.remainingAccount, user: row.remainingUser },
    replayed,
  };
}

export type ConsumeResponse = ReturnType<typeof decisionView>;

/** A stored decision for this requestId: replay it if the input matches, else 409. */
function replay(stored: RequestRow, userId: string, units: number): ConsumeResponse {
  if (stored.userId !== userId || stored.units !== units) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      `requestId "${stored.requestId}" was already used with a different externalUserId or units`,
    );
  }
  return decisionView(stored, true);
}

async function findRequest(db: Db | Tx, accountId: string, requestId: string): Promise<RequestRow | undefined> {
  const [row] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.accountId, accountId), eq(requests.requestId, requestId)));
  return row;
}

/**
 * Decides one consume request and records it. The step numbers are docs/PLAN.md §6
 * Phase 3; keep this order. A rejection is a normal decision (HTTP 200), not an error.
 */
export async function consume({ db, now }: ServiceDeps, accountId: string, input: ConsumeInput): Promise<ConsumeResponse> {
  const { externalUserId, units, requestId } = input;

  // 1. Input is validated by the route. Resolve the user within this account, else 404.
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.externalUserId, externalUserId)));
  if (!user) throw notFound('User');

  // 2. Fast path, outside the transaction: retries skip the account row lock. Only an
  //    optimization; step 6 is the real guarantee.
  const known = await findRequest(db, accountId, requestId);
  if (known) return replay(known, user.id, units);

  // One clock read per request: the month it counts against and every timestamp it writes.
  const at = now();
  const month = toUtcMonth(at);

  try {
    // 3. BEGIN … 11. COMMIT
    return await inTransaction(db, async (tx) => {
      // 4. Make sure this month's usage rows exist so there is something to lock: account, then user.
      await tx.insert(accountUsage).values({ accountId, month, unitsUsed: 0, updatedAt: at }).onConflictDoNothing();
      await tx
        .insert(userUsage)
        .values({ userId: user.id, accountId, month, unitsUsed: 0, updatedAt: at })
        .onConflictDoNothing();

      // 5. Lock the account usage row, THEN the user usage row. Every consume takes them in
      //    this order, so two consumes can never wait on each other in a cycle (deadlock).
      const [accountRow] = await tx
        .select({ unitsUsed: accountUsage.unitsUsed })
        .from(accountUsage)
        .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.month, month)))
        .for('update');
      const [userRow] = await tx
        .select({ unitsUsed: userUsage.unitsUsed })
        .from(userUsage)
        .where(and(eq(userUsage.accountId, accountId), eq(userUsage.userId, user.id), eq(userUsage.month, month)))
        .for('update');
      if (!accountRow || !userRow) throw new Error('consume: usage row missing after upsert');

      // 6. Recheck after locking. A concurrent consume with this requestId in the same month
      //    held the same account lock and has committed by now, so this read sees its row.
      const stored = await findRequest(tx, accountId, requestId);
      if (stored) return replay(stored, user.id, units);

      // 7. Both plans in one statement after the lock: one snapshot, no locks on plan rows,
      //    and any plan change committed before we got the lock is visible.
      const accountPlan = alias(plans, 'account_plan');
      const userPlan = alias(plans, 'user_plan');
      const [planRow] = await tx
        .select({ accountPlan, userPlan })
        .from(accounts)
        .innerJoin(accountPlan, eq(accountPlan.id, accounts.planId))
        .innerJoin(users, and(eq(users.accountId, accounts.id), eq(users.id, user.id)))
        .innerJoin(userPlan, eq(userPlan.id, users.planId))
        .where(eq(accounts.id, accountId));
      if (!planRow) throw new Error('consume: account or user plan missing');

      // 8. The pure decision.
      const decision = evaluate({
        accountPlan: planRow.accountPlan,
        userPlan: planRow.userPlan,
        accountUsed: accountRow.unitsUsed,
        userUsed: userRow.unitsUsed,
        units,
      });

      // 9. Accepted: add the units to both rows, which keeps account usage = sum of user usage.
      if (decision.status === 'ACCEPTED') {
        await tx
          .update(accountUsage)
          .set({ unitsUsed: sql`${accountUsage.unitsUsed} + ${units}`, updatedAt: at })
          .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.month, month)));
        await tx
          .update(userUsage)
          .set({ unitsUsed: sql`${userUsage.unitsUsed} + ${units}`, updatedAt: at })
          .where(and(eq(userUsage.accountId, accountId), eq(userUsage.userId, user.id), eq(userUsage.month, month)));
      }

      // 10. Record the decision with its snapshot; replays are answered from this row alone.
      const [row] = await tx
        .insert(requests)
        .values({
          accountId,
          userId: user.id,
          requestId,
          units,
          month,
          status: decision.status,
          reasonCode: decision.reasonCode,
          rejectedBy: decision.rejectedBy,
          limitValue: decision.limit,
          accountPlanId: planRow.accountPlan.id,
          userPlanId: planRow.userPlan.id,
          remainingAccount: decision.remaining.account,
          remainingUser: decision.remaining.user,
          createdAt: at,
        })
        .returning();
      return decisionView(row!, false);
    });
  } catch (err) {
    // 12. Safety net: the same requestId committed by a consume that held a different lock
    //     (e.g. the other side of a month boundary). We have rolled back; answer from its row.
    if (isUniqueViolation(err, 'requests_account_id_request_id_unique')) {
      const stored = await findRequest(db, accountId, requestId);
      if (stored) return replay(stored, user.id, units);
    }
    throw err;
  }
}
