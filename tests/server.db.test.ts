import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dbAvailable, TEST_DATABASE_URL } from './helpers/db.js';

const root = path.resolve(import.meta.dirname, '..');

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Listens on a free port (all interfaces, like the server) and keeps it taken until closed. */
async function holdPort(): Promise<Server> {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, resolve));
  return blocker;
}

interface Running {
  child: ChildProcess;
  port: number;
  /** Everything the process tree printed so far, stdout and stderr. */
  output: () => string;
  /** Resolves once `predicate(output)` holds; rejects after timeoutMs. */
  waitFor: (predicate: (out: string) => boolean, timeoutMs?: number) => Promise<void>;
  exited: Promise<number | null>;
}

const started: Running[] = [];

/** Runs src/server.ts as a real process (cluster.fork re-runs it with the same tsx loader). */
async function startServer(workers: number, port?: number): Promise<Running> {
  port ??= await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: String(port), WORKERS: String(workers) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const listeners = new Set<() => void>();
  const onData = (chunk: Buffer) => {
    out += chunk.toString();
    for (const l of listeners) l();
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const running: Running = {
    child,
    port,
    output: () => out,
    exited,
    waitFor: (predicate, timeoutMs = 15_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (predicate(out)) {
            listeners.delete(check);
            clearTimeout(timer);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out; output so far:\n${out}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      }),
  };
  started.push(running);
  return running;
}

function count(out: string, re: RegExp): number {
  return out.match(new RegExp(re.source, 'g'))?.length ?? 0;
}

function workerPids(out: string): number[] {
  return [...out.matchAll(/listening on port \d+ \(worker (\d+)\)/g)].map((m) => Number(m[1]));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const r of started.splice(0)) {
    if (r.child.exitCode === null && r.child.signalCode === null) {
      r.child.kill('SIGKILL');
      await r.exited;
    }
    for (const pid of workerPids(r.output())) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
});

describe.skipIf(!(await dbAvailable()))('server process (WORKERS)', () => {
  it('WORKERS=1 runs one process with no cluster and exits 0 on SIGTERM', async () => {
    const s = await startServer(1);
    await s.waitFor((out) => out.includes(`quota-service listening on port ${s.port}\n`));
    expect(s.output()).not.toMatch(/worker|primary/);

    const res = await fetch(`http://127.0.0.1:${s.port}/healthz`);
    expect(res.status).toBe(200);

    s.child.kill('SIGTERM');
    expect(await s.exited).toBe(0);
    expect(s.output()).toContain('SIGTERM received, shutting down\n');
  }, 30_000);

  it('WORKERS=2 forks two workers, replaces a crashed one, and stops all on SIGTERM', async () => {
    const s = await startServer(2);
    await s.waitFor((out) => workerPids(out).length === 2);
    expect(s.output()).toMatch(new RegExp(`primary ${s.child.pid} starting 2 workers`));
    const [first, second] = workerPids(s.output());
    expect(first).not.toBe(s.child.pid);

    const res = await fetch(`http://127.0.0.1:${s.port}/healthz`);
    expect(res.status).toBe(200);

    process.kill(first!, 'SIGKILL');
    await s.waitFor((out) => workerPids(out).length === 3);
    expect(s.output()).toMatch(new RegExp(`worker ${first} exited \\(SIGKILL\\)`));
    const replacement = workerPids(s.output())[2]!;
    expect(isAlive(replacement)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${s.port}/healthz`)).status).toBe(200);

    s.child.kill('SIGTERM');
    expect(await s.exited).toBe(0);
    expect(s.output()).toContain('SIGTERM received, stopping 2 workers');
    expect(count(s.output(), /SIGTERM received, shutting down \(worker \d+\)/)).toBe(2);
    expect(isAlive(second!)).toBe(false);
    expect(isAlive(replacement)).toBe(false);
  }, 30_000);

  it('WORKERS=1 exits 1 when the port is taken', async () => {
    const blocker = await holdPort();
    try {
      const s = await startServer(1, (blocker.address() as { port: number }).port);
      expect(await s.exited).toBe(1);
      expect(s.output()).toMatch(/could not listen on port \d+: .*EADDRINUSE/);
      expect(s.output()).not.toMatch(/listening on port/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }, 30_000);

  it('exits 1 after 5 workers in a row die before listening', async () => {
    // Hold the port so every worker's listen fails and the worker exits right after its fork.
    const blocker = await holdPort();
    const port = (blocker.address() as { port: number }).port;
    try {
      const s = await startServer(2, port);
      expect(await s.exited).toBe(1);
      const out = s.output();
      expect(count(out, /exited \(code 1\), restarting in 1000ms/)).toBe(4);
      expect(out).toMatch(/5 workers in a row died before listening or within 1000ms of it, giving up/);
      expect(out).toMatch(/crash loop, stopping \d workers/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }, 30_000);
});
