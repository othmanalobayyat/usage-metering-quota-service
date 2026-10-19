import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, notFound } from '../errors/app-error.js';
import type { ErrorCode } from '../errors/codes.js';
import { isOverloadError } from '../lib/pg-error.js';

function send(res: Parameters<RequestHandler>[1], status: number, code: ErrorCode, message: string) {
  res.status(status).json({ error: { code, message } });
}

/**
 * Express's router throws a URIError with status 400 when a path parameter isn't valid
 * percent-encoding (e.g. `/users/%E0%A4%A`), before any route handler runs.
 */
function isParamDecodeError(err: unknown): boolean {
  return err instanceof URIError && (err as { status?: unknown }).status === 400;
}

/**
 * Mounted last in a router with path parameters. An undecodable parameter can't name an
 * existing resource, so it's a 404 like any other malformed ID in the URL.
 */
export function undecodableParamNotFound(what: string): ErrorRequestHandler {
  return (err, _req, _res, next) => {
    next(isParamDecodeError(err) ? notFound(what) : err);
  };
}

/** Unknown route or method. Mounted after every router. */
export const notFoundHandler: RequestHandler = (req, res) => {
  send(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);
};

/**
 * The single place errors become responses. A 500 never exposes details. Overload (a pool,
 * lock or statement timeout) is a 503 with Retry-After instead, so callers know to retry.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AppError) {
    send(res, err.status, err.code, err.message);
    return;
  }
  // Fallback for a router without undecodableParamNotFound, so a bad parameter is never a 500.
  if (isParamDecodeError(err)) {
    send(res, 404, 'NOT_FOUND', 'Resource not found');
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
  if (isOverloadError(err)) {
    console.error('service unavailable (overload)', err);
    res.set('Retry-After', '1');
    send(
      res,
      503,
      'SERVICE_UNAVAILABLE',
      'Service is temporarily overloaded. Retry the request; for POST /consume, retry with the same requestId.',
    );
    return;
  }
  console.error('unhandled error', err);
  send(res, 500, 'INTERNAL_ERROR', 'Internal server error');
};
