import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // API processes (node:cluster). Each has its own pool of 10, so 8 × 10 stays well under
  // Postgres's default max_connections of 100. 1 (the default) runs the server in this process,
  // no cluster: more workers slow a hot account down (docs/LOAD_TEST.md §8).
  WORKERS: z.coerce.number().int().min(1).max(8).default(1),
});

export type Config = z.infer<typeof envSchema>;

/** Validates the environment; throws with every problem listed if it's invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
