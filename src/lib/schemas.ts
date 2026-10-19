import { z } from 'zod';
import { parseYearMonth } from './month.js';

/** Largest value an `integer` column holds. Every unit count and limit is capped here. */
export const MAX_INT32 = 2_147_483_647;

/** Any 8-4-4-4-12 hex UUID, the same set PostgreSQL's uuid type accepts. */
export const uuidSchema = z.guid();

/** A UTF-16 surrogate not paired with its partner. The `u` flag matches a valid pair as one code point. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Any free-text string a caller supplies. PostgreSQL text can't store NUL (\u0000) and fails
 * the query with 22021, so it's rejected here as a 400 (404 in a URL path) instead of a 500.
 * A lone surrogate (JSON allows "\ud800") is rejected too: node-postgres encodes it as U+FFFD,
 * so distinct IDs would collide and a new request could be answered as a replay.
 */
function textSchema() {
  return z
    .string()
    .refine((value) => !value.includes('\u0000'), { message: 'must not contain NUL characters' })
    .refine((value) => !LONE_SURROGATE.test(value), { message: 'must not contain unpaired UTF-16 surrogates' });
}

/**
 * A caller-chosen ID (externalUserId, requestId): 1-128 characters with no leading or trailing
 * whitespace, so " alice" is rejected instead of becoming a different user from "alice".
 */
function callerIdSchema() {
  return textSchema()
    .min(1)
    .max(128)
    .refine((id) => id.trim() === id, { message: 'must not have leading or trailing whitespace' });
}

export const externalUserIdSchema = callerIdSchema();

/** `name` on accounts, plans and users: trimmed, 1-200 characters. */
export const nameSchema = textSchema().trim().min(1).max(200);

export const planIdBodySchema = z.strictObject({ planId: uuidSchema });

/** `limit` query param for cursor-paginated lists. */
export const pageLimitSchema = z.coerce.number().int().min(1).max(100).default(20);

/** `cursor` query param: an opaque value from a previous page's nextCursor (lib/cursor.ts). */
export const pageCursorSchema = textSchema().min(1).optional();

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
export const requestIdSchema = callerIdSchema();
