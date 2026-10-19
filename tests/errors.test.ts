import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { ERROR_STATUS } from '../src/errors/codes.js';
import { errorHandler } from '../src/middleware/errors.js';
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
      SERVICE_UNAVAILABLE: 503,
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

  it('an undecodable path parameter on a router without its own mapping → 404 NOT_FOUND, not 500', async () => {
    const error = vi.spyOn(console, 'error');
    const bare = express();
    bare.get('/things/:id', (_req, res) => {
      res.json({});
    });
    bare.use(errorHandler);
    const res = await request(bare).get('/things/%E0%A4%A');
    expectError(res, 404, 'NOT_FOUND');
    expect(res.body.error.message).toBe('Resource not found');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('overload → 503 SERVICE_UNAVAILABLE', () => {
  /** A Db whose first use throws `err`, the way a failed auth lookup would. */
  const failingDb = (err: Error) =>
    new Proxy({} as Db, {
      get() {
        throw err;
      },
    });

  /** Wraps a driver error the way Drizzle does (`Failed query: …` with the pg error as cause). */
  const drizzleWrapped = (cause: Error) => new Error('Failed query: select 1', { cause });

  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  const call = (err: Error) =>
    request(createApp({ db: failingDb(err), pingDb: async () => {} }))
      .get('/account')
      .set('X-API-Key', 'mk_anything');

  it.each([
    ['pg-pool checkout timeout', new Error('timeout exceeded when trying to connect')],
    ['pg-pool checkout timeout, wrapped by Drizzle', drizzleWrapped(new Error('timeout exceeded when trying to connect'))],
    ['lock_timeout (55P03), wrapped by Drizzle', drizzleWrapped(pgError('55P03', 'canceling statement due to lock timeout'))],
    ['statement cancel (57014), wrapped by Drizzle', drizzleWrapped(pgError('57014', 'canceling statement due to statement timeout'))],
  ])('%s → 503 with Retry-After: 1', async (_name, err) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(err);
    expectError(res, 503, 'SERVICE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.error.message).toMatch(/same requestId/);
  });

  it.each([
    ['a unique violation (23505)', drizzleWrapped(pgError('23505', 'duplicate key value'))],
    ['a deadlock (40P01)', drizzleWrapped(pgError('40P01', 'deadlock detected'))],
    ['the client-side query_timeout', new Error('Query read timeout')],
    ['a new connection that could not be opened in time (the DB may be down)', new Error('Connection terminated due to connection timeout')],
    ['a refused connection', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })],
  ])('%s stays 500 with no Retry-After', async (_name, err) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(err);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(res.headers['retry-after']).toBeUndefined();
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
