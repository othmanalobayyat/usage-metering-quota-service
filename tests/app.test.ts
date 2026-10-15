import http from 'node:http';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const root = path.resolve(import.meta.dirname, '..');

describe('createApp', () => {
  it('builds the app without listening', () => {
    const createServer = vi.spyOn(http, 'createServer');
    const app = createApp({ pingDb: async () => {} });
    expect(typeof app).toBe('function');
    expect(createServer).not.toHaveBeenCalled();
  });

  it('returns a fresh app per call, wired to its own deps', async () => {
    const up = createApp({ pingDb: async () => {} });
    const down = createApp({
      pingDb: async () => {
        throw new Error('down');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(up).get('/healthz')).status).toBe(200);
    expect((await request(down).get('/healthz')).status).toBe(503);
  });

  it('does not send X-Powered-By', async () => {
    const res = await request(createApp({ pingDb: async () => {} })).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('server.ts', () => {
  it('exits with code 1 and names DATABASE_URL when it is missing', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(path.join(root, 'node_modules/.bin/tsx'), ['src/server.ts'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DATABASE_URL/);
  });
});
