import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, QuotaApi } from '../client/src/quota-api.js';

// The example client's API wrapper against a stub server, so no database is needed.
describe('client QuotaApi errors', () => {
  let server: Server;
  let api: QuotaApi;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/html-502') {
        res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html><body>Bad Gateway</body></html>');
      } else if (req.url === '/empty-503') {
        res.writeHead(503).end();
      } else if (req.url === '/json-404') {
        res
          .writeHead(404, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'User not found' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>not json</html>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = new QuotaApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  /** QuotaApi.call is private; the public methods only differ in path, so call it directly. */
  const get = (path: string) => (api as unknown as { call(method: string, path: string): Promise<unknown> }).call('GET', path);

  async function errorOf(path: string): Promise<unknown> {
    try {
      await get(path);
    } catch (err) {
      return err;
    }
    throw new Error(`expected GET ${path} to fail`);
  }

  it('a non-JSON error body reports the HTTP status, not a SyntaxError', async () => {
    const err = await errorOf('/html-502');
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: 'HTTP_502', message: 'GET /html-502 failed with HTTP 502' });
  });

  it('an empty error body reports the HTTP status', async () => {
    expect(await errorOf('/empty-503')).toMatchObject({ status: 503, code: 'HTTP_503' });
  });

  it('a JSON error body still reports its code and message', async () => {
    expect(await errorOf('/json-404')).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'User not found' });
  });

  it('a non-JSON success body is still an error', async () => {
    expect(await errorOf('/ok-html')).toBeInstanceOf(SyntaxError);
  });
});
