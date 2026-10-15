import { Router } from 'express';
import { z } from 'zod';
import { planType } from '../db/schema.js';
import { notFound } from '../errors/app-error.js';
import { MAX_INT32, uuidSchema } from '../lib/schemas.js';
import { parseInput } from '../lib/validate.js';
import { accountOf } from '../middleware/auth.js';
import type { ServiceDeps } from '../services/deps.js';
import { createPlan, getEditablePlan, getPlan, listPlans, updatePlan } from '../services/plans.service.js';
import { planView } from '../services/views.js';

const name = z.string().trim().min(1).max(200);
const monthlyLimit = z.int().min(0).max(MAX_INT32);
const perRequestLimit = z.int().min(1).max(MAX_INT32);

const createPlanSchema = z.strictObject({
  name,
  type: z.enum(planType.enumValues),
  monthlyLimit,
  perRequestLimit,
});

// `type` is absent on purpose: strictObject rejects it, since changing it would invalidate assignments.
const updatePlanSchema = z
  .strictObject({ name: name.optional(), monthlyLimit: monthlyLimit.optional(), perRequestLimit: perRequestLimit.optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });

const listPlansQuerySchema = z.object({ type: z.enum(planType.enumValues).optional() });

/** A malformed ID can't name any plan, so it's a 404 like any other unknown plan. */
function planIdParam(raw: string): string {
  const result = uuidSchema.safeParse(raw);
  if (!result.success) throw notFound('Plan');
  return result.data;
}

/** /plans. Mounted behind requireApiKey. There is no DELETE: custom plans can't be deleted. */
export function plansRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { type } = parseInput(listPlansQuerySchema, req.query);
    const plans = await listPlans(deps, accountOf(req).id, type);
    res.json({ data: plans.map(planView) });
  });

  router.get('/:id', async (req, res) => {
    res.json(planView(await getPlan(deps, accountOf(req).id, planIdParam(req.params.id))));
  });

  router.post('/', async (req, res) => {
    const input = parseInput(createPlanSchema, req.body);
    res.status(201).json(planView(await createPlan(deps, accountOf(req).id, input)));
  });

  router.patch('/:id', async (req, res) => {
    const accountId = accountOf(req).id;
    // Before body validation: a predefined plan is 403 whatever the body says.
    const plan = await getEditablePlan(deps, accountId, planIdParam(req.params.id));
    const input = parseInput(updatePlanSchema, req.body);
    res.json(planView(await updatePlan(deps, accountId, plan, input)));
  });

  return router;
}
