import type { Clock } from '../lib/clock.js';
import type { Db } from './client.js';
import { plans } from './schema.js';

/**
 * Predefined plans have fixed IDs so every environment agrees on them and re-seeding
 * can't create duplicates. Never change these values: existing rows reference them.
 */
export const PREDEFINED_PLAN_IDS = {
  STARTER: '00000000-0000-4000-8000-000000000001',
  PRO: '00000000-0000-4000-8000-000000000002',
  BASIC: '00000000-0000-4000-8000-000000000003',
  PREMIUM: '00000000-0000-4000-8000-000000000004',
} as const;

/** New accounts start on Starter, new users on Basic. */
export const DEFAULT_ACCOUNT_PLAN_ID = PREDEFINED_PLAN_IDS.STARTER;
export const DEFAULT_USER_PLAN_ID = PREDEFINED_PLAN_IDS.BASIC;

export const PREDEFINED_PLANS = [
  { id: PREDEFINED_PLAN_IDS.STARTER, name: 'Starter', type: 'ACCOUNT', monthlyLimit: 10_000, perRequestLimit: 100 },
  { id: PREDEFINED_PLAN_IDS.PRO, name: 'Pro', type: 'ACCOUNT', monthlyLimit: 100_000, perRequestLimit: 1_000 },
  { id: PREDEFINED_PLAN_IDS.BASIC, name: 'Basic', type: 'USER', monthlyLimit: 1_000, perRequestLimit: 20 },
  { id: PREDEFINED_PLAN_IDS.PREMIUM, name: 'Premium', type: 'USER', monthlyLimit: 5_000, perRequestLimit: 100 },
] as const;

/**
 * Inserts the predefined plans. Idempotent: an existing ID is left untouched
 * (ON CONFLICT (id) DO NOTHING), so running it on every container start is safe.
 * Returns how many plans were newly inserted.
 */
export async function seedPlans(db: Db, now: Clock): Promise<number> {
  const at = now();
  const inserted = await db
    .insert(plans)
    .values(PREDEFINED_PLANS.map((p) => ({ ...p, accountId: null, createdAt: at, updatedAt: at })))
    .onConflictDoNothing({ target: plans.id })
    .returning({ id: plans.id });
  return inserted.length;
}
