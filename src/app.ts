import express, { type Express } from 'express';
import { healthRouter, type DbPing } from './routes/health.js';

export interface AppDeps {
  pingDb: DbPing;
}

/** Builds the Express app without listening, so tests can drive it with Supertest. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.use(healthRouter(deps.pingDb));

  return app;
}
