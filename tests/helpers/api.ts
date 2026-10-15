import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { systemClock, type Clock } from '../../src/lib/clock.js';
import type { TestDb } from './db.js';

/** The real app wired to the test database. */
export function createTestApp(testDb: TestDb, now: Clock = systemClock): Express {
  return createApp({ db: testDb.db, pingDb: testDb.pingDb, now });
}

/** Creates an account through the API and returns its ID and plaintext key. */
export async function signUp(app: Express, name = 'acme', extra: Record<string, unknown> = {}) {
  const res = await request(app).post('/accounts').send({ name, ...extra });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, apiKey: res.body.apiKey as string };
}

/** Creates a custom plan for the account behind `apiKey` and returns its ID. */
export async function createCustomPlan(
  app: Express,
  apiKey: string,
  plan: { name: string; type: 'ACCOUNT' | 'USER'; monthlyLimit?: number; perRequestLimit?: number },
): Promise<string> {
  const res = await request(app)
    .post('/plans')
    .set('X-API-Key', apiKey)
    .send({ monthlyLimit: 200, perRequestLimit: 50, ...plan });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Asserts the `{ error: { code, message } }` shape with exactly these two keys. */
export function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: { code, message: expect.any(String) } });
  expect(res.body.error.message).not.toBe('');
}
