import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import type { ErrorCode } from '../errors/codes.js';

function send(res: Parameters<RequestHandler>[1], status: number, code: ErrorCode, message: string) {
  res.status(status).json({ error: { code, message } });
}

/** Unknown route or method. Mounted after every router. */
export const notFoundHandler: RequestHandler = (req, res) => {
  send(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);
};

/** The single place errors become responses. A 500 never exposes details. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AppError) {
    send(res, err.status, err.code, err.message);
    return;
  }
  // express.json() failures (malformed JSON, oversized body, bad charset) carry a 4xx status.
  const status = (err as { status?: unknown }).status;
  if ((err as { type?: unknown }).type !== undefined && typeof status === 'number' && status >= 400 && status < 500) {
    const message =
      (err as { type?: unknown }).type === 'entity.parse.failed' ? 'Malformed JSON body' : (err as Error).message;
    send(res, 400, 'VALIDATION_ERROR', message);
    return;
  }
  console.error('unhandled error', err);
  send(res, 500, 'INTERNAL_ERROR', 'Internal server error');
};
