import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// load/ab.sh checks its arguments before it touches Compose. PATH holds only `dirname` and a stub
// `docker` whose `image inspect` succeeds or fails on demand, so nothing here can start a load run.

const root = path.resolve(import.meta.dirname, '..');

describe('load/ab.sh argument checks', () => {
  let binDir: string;
  let bash: string;

  beforeAll(() => {
    bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
    const dirname = spawnSync('sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).stdout.trim();
    expect(bash).not.toBe('');
    binDir = mkdtempSync(path.join(tmpdir(), 'ab-sh-path-'));
    symlinkSync(dirname, path.join(binDir, 'dirname'));
    // `docker image inspect <image>` succeeds only for images named ok:*; any other docker call fails loudly.
    writeFileSync(
      path.join(binDir, 'docker'),
      '#!/bin/sh\nif [ "$1 $2" = "image inspect" ]; then case "$3" in ok:*) exit 0;; *) exit 1;; esac; fi\necho "unexpected docker $*" >&2; exit 99\n',
    );
    chmodSync(path.join(binDir, 'docker'), 0o755);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  function abSh(env: Record<string, string>) {
    return spawnSync(bash, [path.join(root, 'load/ab.sh')], { env: { PATH: binDir, ...env }, encoding: 'utf8', timeout: 10_000 });
  }

  it('refuses to start without both images', () => {
    const cases: Record<string, string>[] = [{}, { A_IMAGE: 'ok:a' }, { B_IMAGE: 'ok:b' }];
    for (const env of cases) {
      const result = abSh(env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('set A_IMAGE and B_IMAGE');
    }
  });

  it('refuses an image that does not exist', () => {
    const result = abSh({ A_IMAGE: 'ok:a', B_IMAGE: 'missing:b' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no such image: missing:b');
  });

  it('refuses an unknown scenario before running anything', () => {
    const result = abSh({ A_IMAGE: 'ok:a', B_IMAGE: 'ok:b', SCENARIOS: 'hot-account nope' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown scenario: nope');
    expect(result.stderr).not.toContain('unexpected docker');
  });
});
