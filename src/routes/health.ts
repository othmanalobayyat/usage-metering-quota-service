import { Router } from 'express';

export type DbPing = () => Promise<void>;

export function healthRouter(pingDb: DbPing): Router {
  const router = Router();

  // Liveness + DB check: a running process with no database is not healthy.
  router.get('/healthz', async (_req, res) => {
    try {
      await pingDb();
      res.status(200).json({ status: 'ok', db: 'up' });
    } catch (err) {
      console.error('healthz: database check failed', err);
      res.status(503).json({ status: 'unavailable', db: 'down' });
    }
  });

  return router;
}
