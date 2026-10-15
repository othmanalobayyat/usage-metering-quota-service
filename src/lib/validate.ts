import type { z } from 'zod';
import { AppError } from '../errors/app-error.js';

/** Parses untrusted input (body, query) or throws VALIDATION_ERROR listing every issue. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new AppError('VALIDATION_ERROR', message);
  }
  return result.data;
}
