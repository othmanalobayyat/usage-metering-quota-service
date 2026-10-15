import { z } from 'zod';

/** Largest value an `integer` column holds. Every unit count and limit is capped here. */
export const MAX_INT32 = 2_147_483_647;

/** Any 8-4-4-4-12 hex UUID, the same set PostgreSQL's uuid type accepts. */
export const uuidSchema = z.guid();

export const externalUserIdSchema = z.string().min(1).max(128);

export const planIdBodySchema = z.strictObject({ planId: uuidSchema });

/** `limit` query param for cursor-paginated lists. */
export const pageLimitSchema = z.coerce.number().int().min(1).max(100).default(20);
