import { z } from 'zod';
import { AppError } from '../errors/app-error.js';

/** Position in a `(created_at, id)` ordering. */
export interface Cursor {
  createdAt: Date;
  id: string;
}

const payloadSchema = z.tuple([z.iso.datetime(), z.guid()]);

/**
 * Opaque to clients: base64url of `[createdAt ISO, id]`.
 *
 * The ISO string keeps only milliseconds, while timestamptz stores microseconds. That is safe
 * only because every created_at is written from the app clock (a JS Date, so whole
 * milliseconds). A created_at from a DB default like now() would have sub-millisecond digits,
 * and the truncated cursor could repeat or skip rows.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString('base64url');
}

/** Throws VALIDATION_ERROR for anything encodeCursor didn't produce. */
export function decodeCursor(raw: string): Cursor {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    payload = undefined;
  }
  const result = payloadSchema.safeParse(payload);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'cursor: invalid cursor');
  }
  const [createdAt, id] = result.data;
  return { createdAt: new Date(createdAt), id };
}
