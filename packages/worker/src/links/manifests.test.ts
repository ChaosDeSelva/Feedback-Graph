import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readManifests } from './detect.ts';

function write(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
}

test('a folder that is not a git repository is walked for manifests, skipping vendor, hidden and very deep folders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fblinks-plain-'));
  write(dir, {
    'package.json': JSON.stringify({ name: 'plain', dependencies: { shared: 'link:../shared' } }),
    'svc/go.mod': 'module example.com/svc\n',
    'node_modules/dep/package.json': JSON.stringify({ name: 'vendored' }),
    '.cache/package.json': JSON.stringify({ name: 'hidden' }),
    'a/b/c/d/e/f/package.json': JSON.stringify({ name: 'six-deep' }),
    'a/b/c/d/e/f/g/package.json': JSON.stringify({ name: 'seven-deep' }),
    'README.md': '# plain',
  });
  const m = await readManifests(dir);
  expect(m.names.sort()).toEqual(['example.com/svc', 'plain', 'six-deep']);
  expect(m.localPaths).toEqual([{ target: join(dir, '..', 'shared'), spec: 'link:../shared', path: 'package.json' }]);
});

test('a manifest that is not valid JSON, or listed by git but gone from the folder, is passed over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fblinks-bad-'));
  write(dir, {
    'package.json': '{ "name": "broken", ',
    'gone/package.json': JSON.stringify({ name: 'gone' }),
    'ok/package.json': JSON.stringify({ name: 'ok', dependencies: { react: { version: '18' } } }),
  });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  rmSync(join(dir, 'gone'), { recursive: true });
  const m = await readManifests(dir);
  expect(m.names).toEqual(['ok']);
  // A dependency whose spec is not a string is still a dependency, never a local path.
  expect(m.deps).toEqual([{ name: 'react', path: 'ok/package.json' }]);
  expect(m.localPaths).toEqual([]);
});
