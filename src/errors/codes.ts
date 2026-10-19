/**
 * Every error code the API returns, with its HTTP status (docs/PLAN.md §4).
 * There is deliberately no quota code: a quota rejection is a 200 decision, not an error.
 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  ALREADY_EXISTS: 409,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
