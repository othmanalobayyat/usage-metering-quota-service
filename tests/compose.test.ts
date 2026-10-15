import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

interface ComposeService {
  image?: string;
  build?: unknown;
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  depends_on?: Record<string, { condition?: string }>;
}

/** Fully resolved Compose model, or null when Docker Compose isn't installed. */
function composeConfig(): { services: Record<string, ComposeService> } | null {
  const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

const config = composeConfig();

describe.skipIf(config === null)('docker-compose.yml', () => {
  const services = config?.services ?? {};
  const db = services.db ?? {};
  const api = services.api ?? {};

  it('runs PostgreSQL 16 with a health check', () => {
    expect(db.image).toBe('postgres:16');
    expect(db.healthcheck?.test?.join(' ')).toMatch(/pg_isready/);
  });

  it('starts the API only after the DB is healthy', () => {
    expect(api.depends_on?.db?.condition).toBe('service_healthy');
  });

  it('builds the API from the Dockerfile and points it at the db service', () => {
    expect(api.build).toBeDefined();
    expect(api.environment?.DATABASE_URL).toMatch(/^postgres(ql)?:\/\/.*@db:5432\//);
  });
});
