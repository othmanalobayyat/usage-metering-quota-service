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

/** Builds the Express app without listening, so tests can drive it with Supertest. */
export function createApp(deps: AppDeps): Express {
  const services = { db: deps.db, now: deps.now ?? systemClock };
  const auth = requireApiKey(deps.db);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

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
