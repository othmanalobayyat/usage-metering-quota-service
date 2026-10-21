import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import path from 'node:path';

/** Repository root, the working directory for spawned processes. */
export const root = path.resolve(import.meta.dirname, '../..');

export interface Running {
  child: ChildProcess;
  /** Everything the process printed so far, stdout and stderr. */
  output: () => string;
  /** Resolves with the first match of `pattern` in the output; rejects after timeoutMs. */
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>;
  /** The exit code, or null if a signal ended the process. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const started: Running[] = [];

/** Runs a TypeScript entry point under tsx as a real process, the way tests/server.db.test.ts does. */
export function startTs(entry: string, env: Record<string, string>): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const listeners = new Set<() => void>();
  const onData = (chunk: Buffer) => {
    out += chunk.toString();
    for (const listener of listeners) listener();
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const running: Running = {
    child,
    output: () => out,
    exited,
    waitFor: (pattern, timeoutMs = 15_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const match = out.match(pattern);
          if (match) {
            listeners.delete(check);
            clearTimeout(timer);
            resolve(match);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out waiting for ${pattern}; output so far:\n${out}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      }),
  };
  started.push(running);
  return running;
}

/** SIGKILLs every process startTs() started that is still running. Call it in afterEach. */
export async function stopAll(): Promise<void> {
  for (const running of started.splice(0)) {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGKILL');
      await running.exited;
    }
  }
}

/** A port that was free a moment ago. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Listens on a free port (all interfaces) and keeps it taken until closed. */
export async function holdPort(): Promise<Server> {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, resolve));
  return blocker;
}
