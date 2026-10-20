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
  ports?: (string | { target?: number | string })[];
}

/**
 * The container port of one Compose port mapping. `docker compose config` resolves ports to
 * objects (`{ target: 8080, published: "8081" }`); the short string form is `[[ip:]host:]container[/proto]`.
 */
function containerPort(port: string | { target?: number | string }): number {
  if (typeof port !== 'string') return Number(port.target);
  return Number(port.split('/')[0]?.split(':').at(-1));
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
  const client = services.client ?? {};

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

  it.skipIf(process.env.WORKERS !== undefined)('runs one API process unless WORKERS is set', () => {
    expect(api.environment?.WORKERS).toBe('1');
  });

  it('builds the example client and points it at the api service', () => {
    expect(client.build).toBeDefined();
    expect(client.environment?.QUOTA_API_URL).toMatch(/^http:\/\/api:3000/);
  });

  it('starts the example client only after the API is healthy', () => {
    expect(client.depends_on?.api?.condition).toBe('service_healthy');
  });

  it('publishes the example client on container port 8080', () => {
    expect((client.ports ?? []).map(containerPort)).toContain(8080);
  });
});
