import { isUtf8 } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Express } from 'express';
import type { Db } from './db/client.js';
import { systemClock, type Clock } from './lib/clock.js';
import { requireApiKey } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { accountRouter, accountsRouter } from './routes/accounts.js';
import { consumeRouter } from './routes/consume.js';
import { healthRouter, type DbPing } from './routes/health.js';
import { plansRouter } from './routes/plans.js';
import { requestsRouter, usageRouter } from './routes/usage.js';
import { usersRouter } from './routes/users.js';

export interface AppDeps {
  pingDb: DbPing;
  db: Db;
  /** Defaults to the system clock; tests inject their own. */
  now?: Clock;
}

/**
 * express.json() `verify` hook: runs on the raw bytes before they are decoded. Decoding replaces
 * invalid bytes with U+FFFD, so two different requestIds (e.g. "r"+0xFF and "r"+0xFE) would arrive
 * as the same string and the second would be answered as a replay. Only UTF-8 is accepted (JSON
 * between systems must be UTF-8, RFC 8259 §8.1): the other utf-* charsets body-parser allows
 * have the same problem (UTF-32 maps out-of-range values to U+FFFD). body-parser tags a throw here
 * `entity.verify.failed`, which errorHandler returns as 400 VALIDATION_ERROR.
 */
function requireUtf8Body(_req: IncomingMessage, _res: ServerResponse, body: Buffer, encoding: string): void {
  if (encoding !== 'utf-8') {
    throw new Error(`unsupported charset "${encoding.toUpperCase()}": request bodies must be UTF-8`);
  }
  if (!isUtf8(body)) {
    throw new Error('Request body is not valid UTF-8');
  }
}

/** Builds the Express app without listening, so tests can drive it with Supertest. */
export function createApp(deps: AppDeps): Express {
  const services = { db: deps.db, now: deps.now ?? systemClock };
  const auth = requireApiKey(deps.db);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ verify: requireUtf8Body }));

  // Public: health check and account creation.
  app.use(healthRouter(deps.pingDb));
  app.use('/accounts', accountsRouter(services));

  // Everything else needs X-API-Key.
  app.use('/account', auth, accountRouter(services));
  app.use('/plans', auth, plansRouter(services));
  app.use('/users', auth, usersRouter(services));
  app.use('/consume', auth, consumeRouter(services));
  app.use('/usage', auth, usageRouter(services));
  app.use('/requests', auth, requestsRouter(services));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
