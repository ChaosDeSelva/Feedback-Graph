import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { DetectedLink } from '@fb/core';
import { detectLinks, grepMentions, mentionNeedle, readManifests, type LinkProject } from './detect.ts';

function repo(root: string, name: string, files: Record<string, string>, git = true) {
  const dir = join(root, name);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
  }
  return dir;
}

const pkg = (o: object) => JSON.stringify(o);

test('readManifests reads names, dependencies and local paths from package.json, go.mod, Cargo.toml and pyproject.toml', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const dir = repo(root, 'game', {
    'package.json': pkg({ name: 'game', dependencies: { '@me/api-client': '^1', react: '^18' }, devDependencies: { tools: 'file:../shared-tools' } }),
    'packages/ui/package.json': pkg({ name: '@game/ui', peerDependencies: { react: '*' } }),
    'node_modules/x/package.json': pkg({ name: 'x', dependencies: { nope: '1' } }),
    'server/go.mod': 'module github.com/me/gameserver\n\ngo 1.22\n\nrequire (\n\tgithub.com/me/protocol v1.0.0\n)\nrequire github.com/other/thing v2\nreplace github.com/me/protocol => ../../protocol\n',
    'native/Cargo.toml': '[package]\nname = "game-native"\n\n[dependencies]\nserde = "1"\nengine-core = { path = "../../engine" }\n',
    'tools/pyproject.toml': '[project]\nname = "game-tools"\ndependencies = ["requests>=2", "asset-pipeline ~= 1.0"]\n',
  });
  const m = await readManifests(dir);
  expect(m.names.sort()).toEqual(['@game/ui', 'game', 'game-native', 'game-tools', 'github.com/me/gameserver']);
  expect(m.deps.map((d) => d.name).sort()).toEqual(['@me/api-client', 'asset-pipeline', 'engine-core', 'github.com/me/protocol', 'github.com/other/thing', 'react', 'requests', 'serde', 'tools']);
  expect(m.deps.find((d) => d.name === '@me/api-client')).toMatchObject({ path: 'package.json' });
  expect(m.localPaths.map((l) => l.target).sort()).toEqual([join(root, 'engine'), join(root, 'protocol'), join(root, 'shared-tools')]);
});

test('mentionNeedle matches a whole name or remote slug, not a longer one that starts with it', () => {
  const re = new RegExp(mentionNeedle('Feedback-Graph'), 'i');
  expect(re.test('see github.com/me/Feedback-Graph for the core')).toBe(true);
  expect(re.test('clone Feedback-Graph-Cloud')).toBe(false);
  expect(re.test('my_feedback-graph2')).toBe(false);
  expect(re.test('(feedback-graph)')).toBe(true);
});

test('detectLinks: a manifest dependency on another project is a strong depends_on link, with evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const projects: LinkProject[] = [
    { key: 'game', repoPath: repo(root, 'game', { 'package.json': pkg({ name: 'game', dependencies: { '@me/api-client': '^1' } }) }), remote: null },
    { key: 'api', repoPath: repo(root, 'api', { 'client/package.json': pkg({ name: '@me/api-client' }) }), remote: null },
    { key: 'unrelated', repoPath: repo(root, 'unrelated', { 'README.md': 'nothing here' }), remote: null },
  ];
  const links = await detectLinks(projects);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ a: 'api', b: 'game', relation: 'depends_on' });
  expect(links[0].score).toBeGreaterThanOrEqual(0.9);
  expect(links[0].evidence[0]).toEqual({ signal: 'manifest', detail: 'game depends on @me/api-client, a package of api', path: 'package.json', from: 'game' });
});

test('detectLinks: a local path dependency into another project counts as a manifest link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const projects: LinkProject[] = [
    { key: 'engine', repoPath: repo(root, 'engine', { 'src/lib.rs': '' }), remote: null },
    { key: 'gamenative', repoPath: repo(root, 'gamenative', { 'Cargo.toml': '[package]\nname = "x"\n[dependencies]\ncore = { path = "../engine/core" }\n' }), remote: null },
  ];
  const [l] = await detectLinks(projects);
  expect(l).toMatchObject({ a: 'engine', b: 'gamenative', relation: 'depends_on' });
  expect(l.evidence[0].detail).toMatch(/local path into engine/);
});

test('detectLinks: a remote slug mention plus name mentions make a related suggestion; name mentions alone do not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const many = Object.fromEntries(['a.md', 'b.md', 'c.md'].map((f) => [f, 'talks to orbital-server here\n']));
  const projects: LinkProject[] = [
    { key: 'orbital-server', repoPath: repo(root, 'orbital-server', { 'x.ts': '' }), remote: 'github.com/me/orbital-server' },
    { key: 'launcher', repoPath: repo(root, 'launcher', { ...many, 'README.md': 'Deploys github.com/me/orbital-server\n' }), remote: null },
    { key: 'weakling', repoPath: repo(root, 'weakling', many), remote: null },
  ];
  const links = await detectLinks(projects);
  expect(links.map((l: DetectedLink) => [l.a, l.b, l.relation])).toEqual([['launcher', 'orbital-server', 'related']]);
  expect(links[0].evidence.map((e) => e.signal).sort()).toEqual(['name', 'remote']);
});

test('detectLinks never suggests a project and its own clone: the same remote, or a local/<key> remote naming the other', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const many = Object.fromEntries(['a.md', 'b.md', 'c.md'].map((f) => [f, 'the orbital-server and github.com/me/orbital-server\n']));
  const projects: LinkProject[] = [
    { key: 'orbital-server', repoPath: repo(root, 'orbital-server', many), remote: 'github.com/me/orbital-server' },
    // Cloned from the same GitHub repo, and cloned from the folder on disk.
    { key: 'tmp-orbital-fresh', repoPath: repo(root, 'tmp-orbital-fresh', many), remote: 'github.com/me/orbital-server' },
    { key: 'tmp-orbital-bug1', repoPath: repo(root, 'tmp-orbital-bug1', many), remote: 'local/orbital-server' },
  ];
  expect(await detectLinks(projects)).toEqual([]);
});

test('detectLinks ranks depends_on above related, whatever the scores', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const many = Object.fromEntries(['a.md', 'b.md', 'c.md'].map((f) => [f, 'talks to orbital-server via github.com/me/orbital-server\n']));
  const projects: LinkProject[] = [
    { key: 'orbital-server', repoPath: repo(root, 'orbital-server', { 'package.json': pkg({ name: '@me/orbital' }) }), remote: 'github.com/me/orbital-server' },
    { key: 'launcher', repoPath: repo(root, 'launcher', many), remote: null },
    { key: 'zz-client', repoPath: repo(root, 'zz-client', { 'package.json': pkg({ name: 'zz', dependencies: { '@me/orbital': '1' } }) }), remote: null },
  ];
  const links = await detectLinks(projects);
  expect(links.map((l) => l.relation)).toEqual(['depends_on', 'related']);
});

test('detectLinks skips short or generic names, and never links a project to itself', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const files = Object.fromEntries(['a.md', 'b.md', 'c.md', 'd.md'].map((f) => [f, 'the server and the shop\n']));
  const projects: LinkProject[] = [
    { key: 'server', repoPath: repo(root, 'server', files), remote: null },
    { key: 'shop', repoPath: repo(root, 'shop', { ...files, 'package.json': pkg({ name: 'shop', dependencies: { shop: '1' } }) }), remote: null },
  ];
  expect(await detectLinks(projects)).toEqual([]);
});

test('grepMentions finds every name in one pass, file by file, and tells a name from a longer one that starts with it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fblinks-'));
  const dir = repo(root, 'tool', {
    'a.md': 'deploys Feedback-Graph and orbital-server\n',
    'b.md': 'Feedback-Graph-Cloud only\n',
    'c.ts': 'import x from "me/orbital-server"\n',
    '.env': 'orbital-server secret\n',
  });
  const found = await grepMentions(dir, ['feedback-graph', 'orbital-server', 'me/orbital-server', 'absent-name']);
  expect(found.get('feedback-graph')).toEqual(['a.md']);
  expect(found.get('orbital-server')?.sort()).toEqual(['a.md', 'c.ts']);
  expect(found.get('me/orbital-server')).toEqual(['c.ts']);
  expect(found.get('absent-name')).toBeUndefined();
  // Not a git repo: nothing, rather than reading every file under it.
  const plain = repo(root, 'plain', { 'a.md': 'orbital-server' }, false);
  expect(await grepMentions(plain, ['orbital-server'])).toEqual(new Map());
});
