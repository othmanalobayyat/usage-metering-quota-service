import { defineConfig } from 'drizzle-kit';

// Only `drizzle-kit generate` is used; it reads the schema and needs no database.
// Migrations are applied at runtime by src/scripts/migrate.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
