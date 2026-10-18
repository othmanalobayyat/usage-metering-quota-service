import cluster, { type Worker } from 'node:cluster';
import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, createPool, pingDb } from './db/client.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const SHUTDOWN_TIMEOUT_MS = 10_000;
// A worker that dies before it listens, or sooner than this after it starts listening, is
// restarted after a delay, not at once, so a worker that crashes on startup can't turn into a
// tight fork loop. After this many such early deaths in a row the primary gives up and exits 1;
// a worker that stays up MIN_UPTIME_MS after listening resets the count. Uptime is counted
// from listening, not from the fork, because loading the code alone can take over a second.
const MIN_UPTIME_MS = 1_000;
const RESTART_DELAY_MS = 1_000;
const MAX_EARLY_DEATHS = 5;

if (config.WORKERS === 1) {
  // No cluster: the server runs in this process, exactly as before WORKERS existed.
  runServer(config);
} else if (cluster.isPrimary) {
  runPrimary(config.WORKERS);
} else {
  runServer(config);
}

/** One API process: its own pool (pg's default of 10 connections) and its own HTTP server. */
function runServer(config: Config) {
  const pool = createPool(config.DATABASE_URL);
  // Idle clients can error when the DB restarts; log instead of crashing the process.
  pool.on('error', (err) => console.error('pg pool error', err));
  const db = createDb(pool);

  const app = createApp({ db, pingDb: () => pingDb(db) });

  const workerTag = cluster.isWorker ? ` (worker ${process.pid})` : '';
  // Express 5 passes a listen error (e.g. EADDRINUSE) to this callback instead of throwing it.
  const server = app.listen(config.PORT, (err?: Error) => {
    if (err) {
      console.error(`could not listen on port ${config.PORT}${workerTag}: ${err.message}`);
      process.exit(1);
    }
    console.log(`quota-service listening on port ${config.PORT}${workerTag}`);
  });

  function shutdown(signal: string) {
    console.log(`${signal} received, shutting down${workerTag}`);
    // Don't let open connections block exit forever; unref so the timer itself doesn't keep the process alive.
    setTimeout(() => {
      console.error(`graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit${workerTag}`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (cluster.isWorker) {
    // Ctrl+C signals the whole process group; the primary forwards it as SIGTERM, so ignore it here.
    process.on('SIGINT', () => {});
  } else {
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

/** Forks the workers, replaces any that die, and on SIGTERM/SIGINT stops them all gracefully. */
function runPrimary(count: number) {
  const live = new Set<Worker>();
  const listeningAt = new Map<Worker, number>();
  let shuttingDown = false;
  let exitCode = 0;
  let earlyDeaths = 0;

  function fork() {
    const worker = cluster.fork();
    live.add(worker);
    worker.once('listening', () => {
      listeningAt.set(worker, Date.now());
      setTimeout(() => {
        if (live.has(worker)) earlyDeaths = 0;
      }, MIN_UPTIME_MS).unref();
    });
  }

  cluster.on('exit', (worker, code, signal) => {
    live.delete(worker);
    const upSince = listeningAt.get(worker);
    listeningAt.delete(worker);
    if (shuttingDown) {
      if (code !== 0) exitCode = 1;
      if (live.size === 0) process.exit(exitCode);
      return;
    }
    const early = upSince === undefined || Date.now() - upSince < MIN_UPTIME_MS;
    earlyDeaths = early ? earlyDeaths + 1 : 0;
    if (earlyDeaths >= MAX_EARLY_DEATHS) {
      console.error(
        `worker ${worker.process.pid} exited (${signal ?? `code ${code}`}); ${earlyDeaths} workers in a row died before listening or within ${MIN_UPTIME_MS}ms of it, giving up`,
      );
      exitCode = 1;
      shutdown('crash loop');
      return;
    }
    const delay = early ? RESTART_DELAY_MS : 0;
    console.error(`worker ${worker.process.pid} exited (${signal ?? `code ${code}`}), restarting in ${delay}ms`);
    setTimeout(() => {
      if (!shuttingDown) fork();
    }, delay);
  });

  /** `why` starts the log line, e.g. "SIGTERM received". */
  function shutdown(why: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${why}, stopping ${live.size} workers`);
    // Each worker forces its own exit after SHUTDOWN_TIMEOUT_MS; this is the backstop if one hangs.
    setTimeout(() => {
      console.error(`workers still running after ${SHUTDOWN_TIMEOUT_MS + 2_000}ms, killing them`);
      for (const worker of live) worker.process.kill('SIGKILL');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS + 2_000).unref();
    if (live.size === 0) process.exit(exitCode);
    for (const worker of live) worker.process.kill('SIGTERM');
  }

  process.on('SIGTERM', () => shutdown('SIGTERM received'));
  process.on('SIGINT', () => shutdown('SIGINT received'));

  console.log(`quota-service primary ${process.pid} starting ${count} workers`);
  for (let i = 0; i < count; i++) fork();
}
