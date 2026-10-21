import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// load/provenance.sh, the env.txt metadata load/run.sh records. Every function runs here under
// `set -euo pipefail`, as in run.sh, against throwaway git repositories and stub tools in temp
// directories. Nothing runs k6 or Docker, and nothing is written to the real repo or load/results/.

const root = path.resolve(import.meta.dirname, '..');
const PROVENANCE = path.join(root, 'load/provenance.sh');

const which = (tool: string) => spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();

let work: string;
let bash: string;
/** A bin directory with only git in it, and one with nothing. */
let gitOnly: string;
let empty: string;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'load-provenance-'));
  bash = which('bash');
  gitOnly = path.join(work, 'bin-git');
  empty = path.join(work, 'bin-empty');
  mkdirSync(gitOnly);
  mkdirSync(empty);
  symlinkSync(which('git'), path.join(gitOnly, 'git'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Runs one provenance function, under `set -euo pipefail`, with exactly `bin` on PATH. */
function run(cwd: string, bin: string, ...command: string[]) {
  const result = spawnSync(bash, ['-c', 'set -euo pipefail; source "$PROVENANCE"; "$@"', 'provenance', ...command], {
    cwd,
    encoding: 'utf8',
    env: { PATH: bin, HOME: work, PROVENANCE, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: work },
  });
  const fields = Object.fromEntries(
    result.stdout.trim().split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]),
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, fields };
}

let repos = 0;
/** A git repository with one commit holding `files`; returns its path and HEAD. */
function repoWith(files: Record<string, string>) {
  const dir = path.join(work, `repo-${++repos}`);
  mkdirSync(dir);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, HOME: work, GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q');
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, head: git('rev-parse', 'HEAD'), git };
}

function write(dir: string, file: string, content: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

/** A bin directory holding a stub `docker` with this body, plus any real tools named in `tools`. */
let stubs = 0;
function stubDocker(body: string, tools: string[] = []) {
  const bin = path.join(work, `bin-stub-${++stubs}`);
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, 'docker'), 0o755);
  for (const tool of tools) symlinkSync(which(tool), path.join(bin, tool));
  return bin;
}

describe('git_provenance', () => {
  it('records HEAD, tracked changes, and untracked files outside load/results/', () => {
    const { dir, head } = repoWith({ 'a.txt': 'a', 'load/results/old-run.txt': 'old' });
    write(dir, 'a.txt', 'changed');
    write(dir, 'src/new.ts', 'new');
    // What a load run writes before env.txt is recorded: its own output must not count.
    write(dir, 'load/results/hot-account-abcd1234-run.txt', 'this run');
    const { status, fields } = run(dir, gitOnly, 'git_provenance');
    expect(status).toBe(0);
    expect(fields).toEqual({ git_commit: head, git_tracked_changes: '1', git_untracked_files: '1' });
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a clean tracked tree reads 0, even with this run's new result files present", () => {
    const { dir, head } = repoWith({ 'a.txt': 'a' });
    write(dir, 'load/results/many-accounts-0000beef-env.txt', 'this run');
    expect(run(dir, gitOnly, 'git_provenance').fields).toEqual({ git_commit: head, git_tracked_changes: '0', git_untracked_files: '0' });
  });

  it('counts staged and deleted tracked files, but not ignored ones', () => {
    const { dir, git } = repoWith({ 'a.txt': 'a', 'c.txt': 'c', '.gitignore': 'dist/\n' });
    write(dir, 'a.txt', 'staged');
    git('add', 'a.txt');
    unlinkSync(path.join(dir, 'c.txt'));
    write(dir, 'dist/server.js', 'build output');
    expect(run(dir, gitOnly, 'git_provenance').fields).toMatchObject({ git_tracked_changes: '2', git_untracked_files: '0' });
  });

  it('records a modified tracked result file as a tracked change', () => {
    const { dir } = repoWith({ 'load/results/old-run.txt': 'old' });
    write(dir, 'load/results/old-run.txt', 'edited evidence');
    expect(run(dir, gitOnly, 'git_provenance').fields).toMatchObject({ git_tracked_changes: '1' });
  });

  it('reads unknown, not a clean tree, without git', () => {
    const { dir } = repoWith({ 'a.txt': 'a' });
    const { status, fields } = run(dir, empty, 'git_provenance');
    expect(status).toBe(0);
    expect(fields).toEqual({ git_commit: 'unknown', git_tracked_changes: 'unknown', git_untracked_files: 'unknown' });
  });

  it('reads unknown outside a git checkout', () => {
    const dir = path.join(work, 'not-a-repo');
    mkdirSync(dir);
    expect(run(dir, gitOnly, 'git_provenance').fields).toEqual({
      git_commit: 'unknown',
      git_tracked_changes: 'unknown',
      git_untracked_files: 'unknown',
    });
  });

  it('writes nothing to the repository (no index refresh)', () => {
    const { dir, git } = repoWith({ 'a.txt': 'a' });
    const index = path.join(dir, git('rev-parse', '--git-path', 'index'));
    // Same content, new mtime: a plain `git status` would refresh this entry and rewrite the index.
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(path.join(dir, 'a.txt'), earlier, earlier);
    const before = { bytes: readFileSync(index), mtimeMs: statSync(index).mtimeMs };
    expect(run(dir, gitOnly, 'git_provenance').fields).toMatchObject({ git_tracked_changes: '0' });
    expect({ bytes: readFileSync(index), mtimeMs: statSync(index).mtimeMs }).toEqual(before);
  });
});

describe('image_provenance', () => {
  it('records the container image and when it was built', () => {
    const bin = stubDocker(`case "$1 $2" in
  "inspect --format") echo sha256:1111 ;;
  "image inspect") echo 2026-10-20T17:29:48Z ;;
  *) exit 1 ;;
esac`);
    expect(run(work, bin, 'image_provenance', 'quota-service-api-1').fields).toEqual({
      api_image: 'sha256:1111',
      api_image_created: '2026-10-20T17:29:48Z',
    });
  });

  it('reads unknown when docker inspect fails, and says why on stderr', () => {
    const bin = stubDocker('echo "no such container" >&2; exit 1');
    const { status, fields, stderr } = run(work, bin, 'image_provenance', 'gone');
    expect(status).toBe(0);
    expect(fields).toEqual({ api_image: 'unknown', api_image_created: 'unknown' });
    expect(stderr).toContain('no such container');
  });

  it('reads unknown when docker prints nothing, instead of an empty field', () => {
    const bin = stubDocker('exit 0');
    expect(run(work, bin, 'image_provenance', 'x').fields).toEqual({ api_image: 'unknown', api_image_created: 'unknown' });
  });

  it('keeps the image ID when only the build time is unavailable', () => {
    const bin = stubDocker(`if [ "$1" = inspect ]; then echo sha256:2222; else exit 1; fi`);
    expect(run(work, bin, 'image_provenance', 'x').fields).toEqual({ api_image: 'sha256:2222', api_image_created: 'unknown' });
  });
});

describe('meta, compose_image, host_memory', () => {
  const config = JSON.stringify({ services: { k6: { image: 'grafana/k6:1.3.0' }, db: { image: 'postgres:16' }, api: { build: {} } } });

  // compose_image needs jq. load/run.sh refuses to start without jq, so these only matter where it's installed.
  it.skipIf(which('jq') === '')('compose_image reads a service image from the Compose config', () => {
    const bin = stubDocker(`echo '${config}'`, ['jq']);
    expect(run(work, bin, 'meta', 'compose_image', 'k6').stdout).toBe('grafana/k6:1.3.0\n');
    expect(run(work, bin, 'meta', 'compose_image', 'db').stdout).toBe('postgres:16\n');
    // A service built from a Dockerfile has no image field.
    expect(run(work, bin, 'meta', 'compose_image', 'api').stdout).toBe('unknown\n');
  });

  it.skipIf(which('jq') === '')('compose_image reads unknown when docker compose fails or prints no JSON', () => {
    expect(run(work, stubDocker('exit 1', ['jq']), 'meta', 'compose_image', 'k6').stdout).toBe('unknown\n');
    expect(run(work, stubDocker('exit 0', ['jq']), 'meta', 'compose_image', 'k6').stdout).toBe('unknown\n');
  });

  it('meta prints the output, or unknown on failure or empty output', () => {
    const bin = stubDocker('', ['true', 'false', 'echo']);
    expect(run(work, bin, 'meta', 'echo', 'value').stdout).toBe('value\n');
    expect(run(work, bin, 'meta', 'false').stdout).toBe('unknown\n');
    expect(run(work, bin, 'meta', 'true').stdout).toBe('unknown\n');
  });

  it('host_memory reads unknown without free', () => {
    expect(run(work, empty, 'host_memory').fields).toEqual({ host_mem_total_mib: 'unknown', host_swap_used_mib: 'unknown' });
  });

  it.skipIf(which('free') === '')('host_memory reads the totals from free', () => {
    const bin = stubDocker('', ['free', 'awk']);
    const { fields } = run(work, bin, 'host_memory');
    expect(fields.host_mem_total_mib).toMatch(/^\d+$/);
    expect(fields.host_swap_used_mib).toMatch(/^\d+$/);
  });
});
