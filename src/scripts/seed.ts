import { seedPlans } from '../db/seed.js';
import { systemClock } from '../lib/clock.js';
import { runWithDb } from './run-with-db.js';

await runWithDb('seed', async (db) => {
  const inserted = await seedPlans(db, systemClock);
  console.log(`seed: ${inserted} predefined plan(s) inserted`);
});
