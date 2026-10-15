import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../errors/app-error.js';
import { decodeCursor } from '../lib/cursor.js';
import { externalUserIdSchema, pageLimitSchema, planIdBodySchema, uuidSchema } from '../lib/schemas.js';
import { parseInput } from '../lib/validate.js';
import { accountOf } from '../middleware/auth.js';
import type { ServiceDeps } from '../services/deps.js';
import { getUser, listUsers, registerUser, setUserPlan } from '../services/users.service.js';

const registerUserSchema = z.strictObject({
  externalUserId: externalUserIdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  planId: uuidSchema.optional(),
});

const listUsersQuerySchema = z.object({
  limit: pageLimitSchema,
  cursor: z.string().min(1).optional(),
});

/** An externalUserId that fails validation can't exist, so it's a 404 like any unknown user. */
function externalUserIdParam(raw: string): string {
  const result = externalUserIdSchema.safeParse(raw);
  if (!result.success) throw notFound('User');
  return result.data;
}

/** /users, addressed by externalUserId. Mounted behind requireApiKey. */
export function usersRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const input = parseInput(registerUserSchema, req.body);
    res.status(201).json(await registerUser(deps, accountOf(req).id, input));
  });

  router.get('/', async (req, res) => {
    const query = parseInput(listUsersQuerySchema, req.query);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    res.json(await listUsers(deps, accountOf(req).id, { limit: query.limit, cursor }));
  });

  router.get('/:externalUserId', async (req, res) => {
    res.json(await getUser(deps, accountOf(req).id, externalUserIdParam(req.params.externalUserId)));
  });

  router.put('/:externalUserId/plan', async (req, res) => {
    const externalUserId = externalUserIdParam(req.params.externalUserId);
    const { planId } = parseInput(planIdBodySchema, req.body);
    res.json(await setUserPlan(deps, accountOf(req).id, externalUserId, planId));
  });

  return router;
}
