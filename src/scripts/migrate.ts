import { runMigrations } from '../db/migrate.js';
import { runWithDb } from './run-with-db.js';

await runWithDb('migrate', async (db) => {
  await runMigrations(db);
  console.log('migrate: database is up to date');
});
