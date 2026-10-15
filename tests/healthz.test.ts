import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /healthz', () => {
  it('returns 200 when the DB answers', async () => {
    const app = createApp({ pingDb: async () => {} });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('returns 503 when the DB check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({
      pingDb: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', db: 'down' });
  });
});
