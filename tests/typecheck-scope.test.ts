import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// `npm run typecheck` is `tsc --noEmit` over tsconfig.json. The example client is built only inside
// its Docker image, so a client file left out here would fail first in `docker compose up --build`.

const root = path.resolve(import.meta.dirname, '..');

/** The files `tsc -p <project>` would check, relative to the repo root. */
function checkedFiles(project: string): string[] {
  const result = spawnSync(path.join(root, 'node_modules/.bin/tsc'), ['--showConfig', '-p', project], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout).files as string[]).map((f) => path.normalize(f));
}

function tsFilesIn(dir: string): string[] {
  return readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.normalize(path.join(dir, f)));
}

describe('typecheck scope', () => {
  it('npm run typecheck covers every TypeScript file of the API, the tests and the example client', () => {
    const files = checkedFiles('tsconfig.json');
    for (const dir of ['src', 'tests', 'client/src']) {
      const expected = tsFilesIn(dir);
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.filter((f) => !files.includes(f))).toEqual([]);
    }
  });

  it('the API build still compiles src/ only', () => {
    const files = checkedFiles('tsconfig.build.json');
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !f.startsWith(`src${path.sep}`))).toEqual([]);
  });
});
