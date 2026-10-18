import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { runDemo } from './demo.js';
import { QuotaApi } from './quota-api.js';

const apiUrl = process.env.QUOTA_API_URL ?? 'http://localhost:3000';
const port = Number(process.env.PORT ?? 8080);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const api = new QuotaApi(apiUrl);
const app = express();

app.use(express.static(publicDir));

// The page never talks to the quota service directly: this server makes every call.
app.post('/demo/run', async (_req, res) => {
  const run = await runDemo(api);
  if (run.error) console.error('demo run failed:', run.error);
  res.status(run.error ? 502 : 200).json(run);
});

app.listen(port, () => {
  console.log(`example client listening on port ${port}, quota API at ${apiUrl}`);
});
