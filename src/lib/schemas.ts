import { z } from 'zod';
import { parseYearMonth } from './month.js';

/** Largest value an `integer` column holds. Every unit count and limit is capped here. */
export const MAX_INT32 = 2_147_483_647;

/** Any 8-4-4-4-12 hex UUID, the same set PostgreSQL's uuid type accepts. */
export const uuidSchema = z.guid();

export const externalUserIdSchema = z.string().min(1).max(128);

export const planIdBodySchema = z.strictObject({ planId: uuidSchema });

/** `limit` query param for cursor-paginated lists. */
export const pageLimitSchema = z.coerce.number().int().min(1).max(100).default(20);

/** `cursor` query param: an opaque value from a previous page's nextCursor (lib/cursor.ts). */
export const pageCursorSchema = z.string().min(1).optional();

/** `month` query param, `YYYY-MM`, as the first instant of that UTC month. Absent means undefined. */
export const monthQuerySchema = z
  .string()
  .transform((raw, ctx) => {
    const month = parseYearMonth(raw);
    if (!month) {
      ctx.addIssue({ code: 'custom', message: 'expected YYYY-MM' });
      return z.NEVER;
    }
    return month;
  })
  .optional();

/** Query for the usage endpoints: an optional month, default the current UTC month. */
export const usageQuerySchema = z.object({ month: monthQuerySchema });

/** Caller-supplied idempotency key, scoped per account. */
export const requestIdSchema = z.string().min(1).max(128);
