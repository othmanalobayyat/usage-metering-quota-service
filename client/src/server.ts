import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { runDemo } from './demo.js';
import { QuotaApi } from './quota-api.js';

const apiUrl = process.env.QUOTA_API_URL ?? 'http://localhost:3000';
const port = Number(process.env.PORT ?? 8080);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Below Docker's default 10s stop grace period, so the client exits before it would be SIGKILLed.
const SHUTDOWN_TIMEOUT_MS = 5_000;

const api = new QuotaApi(apiUrl);
const app = express();

app.use(express.static(publicDir));

// The page never talks to the quota service directly: this server makes every call.
app.post('/demo/run', async (_req, res) => {
  const run = await runDemo(api);
  if (run.error) console.error('demo run failed:', run.error);
  res.status(run.error ? 502 : 200).json(run);
});

// Express 5 passes a listen error (e.g. EADDRINUSE) to this callback instead of throwing it.
const server = app.listen(port, (err?: Error) => {
  if (err) {
    console.error(`could not listen on port ${port}: ${err.message}`);
    process.exit(1);
  }
  // The bound port, which differs from `port` when PORT=0 asks for any free one.
  const address = server.address();
  const listening = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`example client listening on port ${listening}, quota API at ${apiUrl}`);
});

// In the container Node is PID 1, and PID 1 ignores a signal it has no handler for, so without
// this `docker compose stop` would wait out the grace period and then SIGKILL the client.
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  // A demo run in flight can take a while; don't let it block exit. unref so the timer itself doesn't.
  setTimeout(() => {
    console.error(`graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
