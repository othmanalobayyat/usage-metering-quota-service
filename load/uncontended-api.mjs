// Uncontended request costs, measured from inside the API container: sequential requests, one at a time,
// so nothing waits on a lock or the pool. Run by load/uncontended.sh (stdin to `node --input-type=module`).
import pg from 'pg';

const RUN_ID = process.env.RUN_ID;
const N = Number(process.env.N || 300);
const WARMUP = 20;
const BASE = 'http://localhost:3000';
const JSON_HEADERS = { 'content-type': 'application/json' };

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return { mean, p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)] };
}

async function time(label, n, fn) {
  for (let i = 0; i < WARMUP; i++) await fn(-1 - i);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    samples.push(performance.now() - t);
  }
  const s = stats(samples);
  console.log(`${label.padEnd(52)} n=${String(n).padEnd(5)} mean ${s.mean.toFixed(2)} ms  p50 ${s.p50.toFixed(2)} ms  p95 ${s.p95.toFixed(2)} ms`);
}

async function ok(res) {
  if (res.status < 200 || res.status > 299) throw new Error(`${res.url}: ${res.status} ${await res.text()}`);
  return res.json();
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await time('pg: select 1 (one round trip, no HTTP)', 2000, () => client.query('select 1'));
await time('pg: select $1::int (parameterized round trip)', 2000, (i) => client.query('select $1::int', [i]));
await client.end();

const account = await ok(
  await fetch(`${BASE}/accounts`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: `load-uncontended-${RUN_ID}-0` }) }),
);
const headers = { ...JSON_HEADERS, 'x-api-key': account.apiKey };
await ok(await fetch(`${BASE}/users`, { method: 'POST', headers, body: JSON.stringify({ externalUserId: 'u0' }) }));
const consume = (requestId) =>
  fetch(`${BASE}/consume`, { method: 'POST', headers, body: JSON.stringify({ externalUserId: 'u0', units: 1, requestId }) }).then(ok);

await time('GET /healthz (1 query)', N, () => fetch(`${BASE}/healthz`).then(ok));
await time('GET /usage (auth + usage read)', N, () => fetch(`${BASE}/usage`, { headers }).then(ok));
// Fresh: a new requestId each time, the full transaction. Starter allows 10,000/month and N stays far below.
await time('POST /consume fresh (auth, user, fast path, transaction)', N, (i) => consume(`fresh-${i}`));
// Replay: requestIds decided above, answered by the fast path (step 2) without a transaction.
await time('POST /consume replay (auth, user, fast path)', N, (i) => consume(`fresh-${Math.abs(i) % N}`));
console.log(`ACCOUNT load-uncontended-${RUN_ID}-0`);
