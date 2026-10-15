import { and, asc, eq, sql } from 'drizzle-orm';
import { plans } from '../db/schema.js';
import { AppError, notFound } from '../errors/app-error.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import type { ServiceDeps } from './deps.js';
import { visibleTo, type Plan, type PlanType } from './plan-guard.js';

const NAME_UNIQUE = 'plans_account_id_name_unique';

const nameTaken = (name: string) => new AppError('ALREADY_EXISTS', `A plan named "${name}" already exists`);

/** Predefined plans first (in seed order), then this account's custom plans, oldest first. */
export async function listPlans({ db }: ServiceDeps, accountId: string, type?: PlanType): Promise<Plan[]> {
  return db
    .select()
    .from(plans)
    .where(and(visibleTo(accountId), type ? eq(plans.type, type) : undefined))
    .orderBy(sql`${plans.accountId} IS NOT NULL`, asc(plans.createdAt), asc(plans.id));
}

/** A predefined plan or one of this account's own. Another account's plan is a 404. */
export async function getPlan({ db }: ServiceDeps, accountId: string, planId: string): Promise<Plan> {
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), visibleTo(accountId)));
  if (!plan) throw notFound('Plan');
  return plan;
}

export interface CreatePlanInput {
  name: string;
  type: PlanType;
  monthlyLimit: number;
  perRequestLimit: number;
}

export async function createPlan({ db, now }: ServiceDeps, accountId: string, input: CreatePlanInput): Promise<Plan> {
  const at = now();
  try {
    const [plan] = await db
      .insert(plans)
      .values({ ...input, accountId, createdAt: at, updatedAt: at })
      .returning();
    return plan!;
  } catch (err) {
    if (isUniqueViolation(err, NAME_UNIQUE)) throw nameTaken(input.name);
    throw err;
  }
}

/** `type` is not updatable: changing it would invalidate existing assignments. */
export type UpdatePlanInput = Partial<Omit<CreatePlanInput, 'type'>>;

/** One of this account's custom plans, about to be edited. Predefined → 403; another account's → 404. */
export async function getEditablePlan(deps: ServiceDeps, accountId: string, planId: string): Promise<Plan> {
  const existing = await getPlan(deps, accountId, planId);
  if (existing.accountId === null) {
    throw new AppError('FORBIDDEN', 'Predefined plans are read-only');
  }
  return existing;
}

/** Updates a plan returned by getEditablePlan. Takes effect on the next consume, with no redeploy. */
export async function updatePlan(
  deps: ServiceDeps,
  accountId: string,
  existing: Plan,
  input: UpdatePlanInput,
): Promise<Plan> {
  try {
    const [plan] = await deps.db
      .update(plans)
      .set({ ...input, updatedAt: deps.now() })
      .where(and(eq(plans.id, existing.id), eq(plans.accountId, accountId)))
      .returning();
    return plan!;
  } catch (err) {
    if (isUniqueViolation(err, NAME_UNIQUE)) throw nameTaken(input.name ?? existing.name);
    throw err;
  }
}
