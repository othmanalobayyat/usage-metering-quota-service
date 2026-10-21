import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/api.js';
import { createTestDb, dbAvailable, resetDatabase, type TestDb } from './helpers/db.js';
import { freePort, holdPort, startTs, stopAll, type Running } from './helpers/process.js';

// The example client's own HTTP server (client/src/server.ts) as a real process: the page, the
// POST /demo/run route, its 502 on API failure, shutdown and listen errors. tests/demo.db.test.ts
// covers runDemo() itself. None of this renders the page in a browser.

const CLIENT = 'client/src/server.ts';

/** Starts the client on a free port (PORT=0) and returns its base URL once it listens. */
async function startClient(apiUrl: string): Promise<{ client: Running; url: string }> {
  const client = startTs(CLIENT, { QUOTA_API_URL: apiUrl, PORT: '0' });
  const [, port] = await client.waitFor(/example client listening on port (\d+)/);
  return { client, url: `http://127.0.0.1:${port}` };
}

afterEach(stopAll);

describe('example client server', () => {
  it('serves the page with the Run demo control', async () => {
    const { url } = await startClient(`http://127.0.0.1:${await freePort()}`);
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain('<button id="run">Run demo</button>');
    expect(html).toContain("fetch('/demo/run', { method: 'POST' })");
  }, 30_000);

  it('POST /demo/run answers 502 with the error when the quota API is unreachable', async () => {
    const { client, url } = await startClient(`http://127.0.0.1:${await freePort()}`);
    const res = await fetch(`${url}/demo/run`, { method: 'POST' });
    expect(res.status).toBe(502);
    const run = await res.json();
    expect(run).toMatchObject({ account: null, steps: [], ok: false, error: expect.any(String) });
    expect(run.error).not.toBe('');
    await client.waitFor(/demo run failed:/);
  }, 30_000);

  it('exits 0 on SIGTERM through its own handler', async () => {
    const { client } = await startClient(`http://127.0.0.1:${await freePort()}`);
    client.child.kill('SIGTERM');
    // Without a handler Node would die of the signal (code null, signal SIGTERM), not exit 0.
    expect(await client.exited).toEqual({ code: 0, signal: null });
    expect(client.output()).toContain('SIGTERM received, shutting down');
  }, 30_000);

  it('exits 1 when its port is taken, instead of claiming to listen', async () => {
    const blocker = await holdPort();
    try {
      const port = (blocker.address() as AddressInfo).port;
      const client = startTs(CLIENT, { QUOTA_API_URL: 'http://127.0.0.1:1', PORT: String(port) });
      expect((await client.exited).code).toBe(1);
      expect(client.output()).toMatch(new RegExp(`could not listen on port ${port}: .*EADDRINUSE`));
      expect(client.output()).not.toMatch(/listening on port/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }, 30_000);
});

describe.skipIf(!(await dbAvailable()))('example client server against the API', () => {
  let testDb: TestDb;
  let api: Server;
  let apiUrl: string;

  beforeAll(async () => {
    testDb = createTestDb();
    await resetDatabase(testDb.pool);
    const app = createTestApp(testDb);
    api = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => api.close((err) => (err ? reject(err) : resolve())));
    await testDb.close();
  });

  it('POST /demo/run runs the whole demo and every step matches', async () => {
    const { url } = await startClient(apiUrl);
    const res = await fetch(`${url}/demo/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    const run = await res.json();
    expect(run.error).toBeNull();
    expect(run.account).toEqual({ id: expect.any(String), name: expect.stringMatching(/^Demo /) });
    expect(run.steps.filter((s: { ok: boolean }) => !s.ok)).toEqual([]);
    // Setup ×5, Alice 1, 2, the switch 3, Alice 4, Bob 5.1–5.5.
    expect(run.steps.map((s: { step: string }) => s.step)).toEqual([
      'Setup', 'Setup', 'Setup', 'Setup', 'Setup', '1', '2', '3', '4', '5.1', '5.2', '5.3', '5.4', '5.5',
    ]);
    expect(run.ok).toBe(true);
    // The page shows these; the key that made the calls never reaches it.
    expect(JSON.stringify(run)).not.toMatch(/mk_/);
  }, 30_000);
});
