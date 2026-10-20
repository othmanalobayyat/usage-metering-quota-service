import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { durationSeconds } from '../load/duration.js';

// DURATION for the load scripts must be whole seconds: load/lib.js divides the request count by it
// for req/s, and the old parseFloat read '1m' as 1 and '500ms' as 500. Nothing here runs k6 or Docker.

const root = path.resolve(import.meta.dirname, '..');

const VALID: [string, number][] = [
  ['20s', 20],
  ['30s', 30],
  ['90s', 90],
  ['1s', 1],
  ['3600s', 3600],
];

/** Valid k6 durations the req/s math can't read, and values that aren't durations at all. */
const INVALID = ['1m', '1m30s', '1h', '500ms', '1.5s', '30', '0s', '030s', '30S', ' 30s', '30s ', '-30s', 's', ''];

describe('load/duration.js durationSeconds', () => {
  it.each(VALID)('%s → %d', (value, seconds) => {
    expect(durationSeconds(value)).toBe(seconds);
  });

  it.each(INVALID)('%j is refused', (value) => {
    expect(() => durationSeconds(value)).toThrow(`DURATION must be whole seconds such as 30s or 90s, got "${value}"`);
  });
});

describe('load/run.sh DURATION check', () => {
  // PATH holds only `dirname`, which run.sh needs to find the repo. Docker, jq and k6 can't be found,
  // so no load test can start: a value that passes the check stops at the jq requirement instead.
  let binDir: string;
  let bash: string;

  beforeAll(() => {
    bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
    const dirname = spawnSync('sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).stdout.trim();
    expect(bash).not.toBe('');
    expect(dirname).not.toBe('');
    binDir = mkdtempSync(path.join(tmpdir(), 'run-sh-path-'));
    symlinkSync(dirname, path.join(binDir, 'dirname'));
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  function runSh(duration: string | undefined) {
    const env: Record<string, string> = { PATH: binDir };
    if (duration !== undefined) env.DURATION = duration;
    return spawnSync(bash, [path.join(root, 'load/run.sh'), 'hot-account'], { env, encoding: 'utf8', timeout: 10_000 });
  }

  it.each([undefined, ...VALID.map(([value]) => value)])('DURATION=%s passes the check', (duration) => {
    const result = runSh(duration);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('load/run.sh needs jq');
    expect(result.stderr).not.toContain('DURATION must be');
  });

  // '' is left out: run.sh treats an empty DURATION as unset (load/compare.sh passes it for the default).
  it.each(INVALID.filter((value) => value !== ''))('DURATION=%j stops with exit 2 before anything starts', (duration) => {
    const result = runSh(duration);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`DURATION must be whole seconds such as 30s or 90s, got "${duration}"`);
    expect(result.stderr).not.toContain('needs jq');
  });

  it('an empty DURATION is the 30s default, as load/compare.sh relies on', () => {
    expect(runSh('').stderr).toContain('load/run.sh needs jq');
  });
});
