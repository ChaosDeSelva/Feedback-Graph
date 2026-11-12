import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { detectLinks, grepMentions, readManifests, type LinkProject } from './detect.ts';

function repo(root: string, name: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A', '-f'], { cwd: dir });
  return dir;
}
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'x', dependencies: deps });

test('a dependency given as a plain relative path is a local path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const m = await readManifests(repo(root, 'app', { 'package.json': pkg({ lib: '../lib' }) }));
  expect(m.localPaths).toEqual([{ target: join(root, 'lib'), spec: '../lib', path: 'package.json' }]);
});

test('links rank by relation, then evidence, then name; the same evidence twice is listed once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const projects: LinkProject[] = [
    { key: 'engine', repoPath: repo(root, 'engine', { 'a.md': '' }), remote: 'github.com/me/engine-core' },
    // Two dependencies on one local folder are one piece of evidence; another folder in it is another.
    { key: 'gamenative', repoPath: repo(root, 'gamenative', { 'package.json': pkg({ a: 'file:../engine', b: 'file:../engine', c: 'file:../engine/sub' }), 'README.md': 'built on me/engine-core\n' }), remote: null },
    { key: 'tools', repoPath: repo(root, 'tools', { 'package.json': pkg({ e: 'file:../engine' }) }), remote: null },
    { key: 'zebra', repoPath: repo(root, 'zebra', { 'package.json': pkg({ e: 'file:../engine' }) }), remote: null },
    { key: 'alpha', repoPath: repo(root, 'alpha', { 'package.json': pkg({ b: 'file:../beta' }) }), remote: null },
    { key: 'beta', repoPath: repo(root, 'beta', { 'a.md': '' }), remote: null },
  ];
  const links = await detectLinks(projects);
  expect(links.map((l) => [l.a, l.b, l.score])).toEqual([
    ['engine', 'gamenative', 0.96], ['alpha', 'beta', 0.9], ['engine', 'tools', 0.9], ['engine', 'zebra', 0.9],
  ]);
  expect(links[0].evidence.map((e) => e.signal)).toEqual(['manifest', 'manifest', 'remote']);
});

test("a remote too short to be a repository slug is not searched for: no remote evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const projects: LinkProject[] = [
    { key: 'ab', repoPath: repo(root, 'ab', { 'a.md': '' }), remote: 'github.com/me/ab' },
    { key: 'solo', repoPath: repo(root, 'solo', { 'a.md': '' }), remote: 'github.com/solo' },
    { key: 'app', repoPath: repo(root, 'app', { 'a.md': 'uses me/ab and github.com/solo\n' }), remote: null },
  ];
  expect(await detectLinks(projects)).toEqual([]);
});

test('a tracked dependency folder never counts as a mention', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const dir = repo(root, 'tool', { 'node_modules/x/README.md': 'orbital-server\n', 'a.md': 'orbital-server\n' });
  expect(await grepMentions(dir, ['orbital-server'])).toEqual(new Map([['orbital-server', ['a.md']]]));
});
