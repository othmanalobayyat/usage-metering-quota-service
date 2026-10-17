import { Router } from 'express';
import { z } from 'zod';
import { externalUserIdSchema, MAX_INT32, requestIdSchema } from '../lib/schemas.js';
import { parseInput } from '../lib/validate.js';
import { accountOf } from '../middleware/auth.js';
import { consume } from '../services/consume.service.js';
import type { ServiceDeps } from '../services/deps.js';

const consumeSchema = z.strictObject({
  externalUserId: externalUserIdSchema,
  units: z.int().min(1).max(MAX_INT32),
  requestId: requestIdSchema,
});

/** POST /consume. Mounted behind requireApiKey. Accepted and rejected decisions are both 200. */
export function consumeRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const input = parseInput(consumeSchema, req.body);
    res.json(await consume(deps, accountOf(req).id, input));
  });

  return router;
}
