import { Router } from 'express';
import { z } from 'zod';
import { decodeCursor } from '../lib/cursor.js';
import {
  externalUserIdSchema,
  monthQuerySchema,
  pageCursorSchema,
  pageLimitSchema,
  usageQuerySchema,
} from '../lib/schemas.js';
import { parseInput } from '../lib/validate.js';
import { accountOf } from '../middleware/auth.js';
import type { ServiceDeps } from '../services/deps.js';
import { listRequests } from '../services/requests.service.js';
import { getAccountUsage } from '../services/usage.service.js';

const historyQuerySchema = z.object({
  externalUserId: externalUserIdSchema.optional(),
  month: monthQuerySchema,
  limit: pageLimitSchema,
  cursor: pageCursorSchema,
});

/** GET /usage?month=YYYY-MM. Mounted behind requireApiKey. */
export function usageRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { month } = parseInput(usageQuerySchema, req.query);
    res.json(await getAccountUsage(deps, accountOf(req).id, month));
  });

  return router;
}

/** GET /requests: decision history, newest first. Mounted behind requireApiKey. */
export function requestsRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = parseInput(historyQuerySchema, req.query);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    res.json(await listRequests(deps, accountOf(req).id, { ...query, cursor }));
  });

  return router;
}
