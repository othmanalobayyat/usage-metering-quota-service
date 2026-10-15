import { Router } from 'express';
import { z } from 'zod';
import { planIdBodySchema } from '../lib/schemas.js';
import { parseInput } from '../lib/validate.js';
import { accountOf } from '../middleware/auth.js';
import { createAccount, getAccount, setAccountPlan } from '../services/accounts.service.js';
import type { ServiceDeps } from '../services/deps.js';

// No planId: every account starts on Starter and switches with PUT /account/plan.
const createAccountSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});

/** POST /accounts. Public: this is how a caller gets its first API key. */
export function accountsRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const input = parseInput(createAccountSchema, req.body);
    res.status(201).json(await createAccount(deps, input));
  });

  return router;
}

/** /account: the calling account. Mounted behind requireApiKey. */
export function accountRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await getAccount(deps, accountOf(req).id));
  });

  router.put('/plan', async (req, res) => {
    const { planId } = parseInput(planIdBodySchema, req.body);
    res.json(await setAccountPlan(deps, accountOf(req).id, planId));
  });

  return router;
}
