import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.js';

// drizzle/ sits at the project root; this file runs from src/db (tsx) or dist/db (node).
export const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../../drizzle');

/** Applies pending migrations from drizzle/. Already-applied ones are skipped via the drizzle journal. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
