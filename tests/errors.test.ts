import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ERROR_STATUS } from '../src/errors/codes.js';
import { expectError } from './helpers/api.js';
import { noDb } from './helpers/db.js';

// No database: these paths must all be answered before (or without) a DB query.
const app = createApp({ db: noDb, pingDb: async () => {} });

describe('error codes', () => {
  it('match the table in docs/PLAN.md §4, with no quota code', () => {
    expect(ERROR_STATUS).toEqual({
      VALIDATION_ERROR: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      IDEMPOTENCY_CONFLICT: 409,
      ALREADY_EXISTS: 409,
      INTERNAL_ERROR: 500,
    });
  });
});

describe('central error handling', () => {
  it('malformed JSON → 400 VALIDATION_ERROR in the standard shape', async () => {
    const res = await request(app)
      .post('/accounts')
      .set('Content-Type', 'application/json')
      .send('{"name": "acme",');
    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Malformed JSON body');
  });

  it('malformed JSON on an authenticated route is also a 400 (body parsing runs first)', async () => {
    const res = await request(app)
      .post('/plans')
      .set('X-API-Key', 'mk_whatever')
      .set('Content-Type', 'application/json')
      .send('not json');
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('unknown route → 404 NOT_FOUND in the standard shape', async () => {
    expectError(await request(app).get('/nope'), 404, 'NOT_FOUND');
    expectError(await request(app).post('/consume-typo').send({}), 404, 'NOT_FOUND');
  });

  it('unknown method on a known path → 404 NOT_FOUND (no DELETE for plans)', async () => {
    expectError(await request(app).delete('/accounts'), 404, 'NOT_FOUND');
  });

  it('an unexpected failure → 500 INTERNAL_ERROR without details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // noDb throws a plain Error the moment the auth lookup touches the database.
    const res = await request(app).get('/account').set('X-API-Key', 'mk_anything');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(JSON.stringify(res.body)).not.toMatch(/noDb|stack/);
  });
});

describe('missing API key → 401', () => {
  const routes: [string, string][] = [
    ['get', '/account'],
    ['put', '/account/plan'],
    ['get', '/plans'],
    ['get', '/plans/00000000-0000-4000-8000-000000000001'],
    ['post', '/plans'],
    ['patch', '/plans/00000000-0000-4000-8000-000000000001'],
    ['get', '/users'],
    ['post', '/users'],
    ['get', '/users/alice'],
    ['put', '/users/alice/plan'],
  ];

  it.each(routes)('%s %s', async (method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path).send({});
    expectError(res, 401, 'UNAUTHORIZED');
  });

  it('an empty X-API-Key header counts as missing', async () => {
    expectError(await request(app).get('/account').set('X-API-Key', ''), 401, 'UNAUTHORIZED');
  });

  it('POST /accounts and /healthz need no key', async () => {
    expect((await request(app).get('/healthz')).status).toBe(200);
    // Validation runs (400) instead of auth (401): the route is public.
    expectError(await request(app).post('/accounts').send({}), 400, 'VALIDATION_ERROR');
  });
});
