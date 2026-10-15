import { ERROR_STATUS, type ErrorCode } from './codes.js';

/** An expected failure. The error middleware turns it into `{ error: { code, message } }`. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
