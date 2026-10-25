import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { discoverNested, hostRepoPath, keyOfRel, projectFolders, projectFromCwd, refreshLayout, relOfKey, type Root } from './projects.ts';

const roots = [{ host: '/Users/you/code', container: '/vibe' }];

test('maps a nested cwd to its top-level project', () => {
  expect(projectFromCwd('/Users/you/code/GameX_1.2.0/source', roots)).toEqual({
    key: 'GameX_1.2.0',
    name: 'GameX_1.2.0',
    repoPath: '/vibe/GameX_1.2.0',
  });
});

test('the root itself is not a project', () => {
  expect(projectFromCwd('/Users/you/code', roots)).toBeNull();
  expect(projectFromCwd('/Users/you/code/', roots)).toBeNull();
});

test('paths outside every root are skipped', () => {
  expect(projectFromCwd('/private/tmp/x', roots)).toBeNull();
  expect(projectFromCwd('/Users/you/codeOther/x', roots)).toBeNull();
  expect(projectFromCwd('', roots)).toBeNull();
});

test('rootsFromEnv pairs container and host roots, rejecting mismatched lists', async () => {
  const { rootsFromEnv } = await import('./projects.ts');
  expect(rootsFromEnv('/vibe,/code', '/Users/j/Vibe,/Users/j/Code')).toEqual([
    { container: '/vibe', host: '/Users/j/Vibe' },
    { container: '/code', host: '/Users/j/Code' },
  ]);
  expect(() => rootsFromEnv('/vibe', '')).toThrow();
});

test('the most specific (longest) root wins when roots are nested', () => {
  const nested = [
    { host: '/Users/j/Vibe', container: '/vibe' },
    { host: '/Users/j/Vibe/feedback_tool/examples', container: '/examples' },
  ];
  expect(projectFromCwd('/Users/j/Vibe/feedback_tool/examples/demo-shop/src', nested)).toEqual({
    key: 'demo-shop', name: 'demo-shop', repoPath: '/examples/demo-shop',
  });
  expect(projectFromCwd('/Users/j/Vibe/feedback_tool', nested)?.key).toBe('feedback_tool');
});

// Nested repos: a folder that is not a git repo but holds some (~/src/github.com/org/repo, ~/code/client/app).
function tree() {
  const base = mkdtempSync(join(tmpdir(), 'fb-nested-'));
  const git = (rel: string) => {
    mkdirSync(join(base, rel), { recursive: true });
    execFileSync('git', ['init', '-q', join(base, rel)]);
  };
  git('plain-repo');
  mkdirSync(join(base, 'plain-repo', 'inner', 'deep'), { recursive: true });
  git('plain-repo/vendored'); // inside a repo: not a project of its own
  mkdirSync(join(base, 'notes', 'drafts'), { recursive: true }); // a plain folder, no repos: stays a project
  git('client/app');
  git('client/api');
  mkdirSync(join(base, 'client', 'docs'), { recursive: true });
  git('github.com/org/repo');
  git('github.com/org/other');
  git('github.com/me/tool');
  git('github.com/org/node_modules/dep'); // never searched
  git('github.com/org/repo/sub'); // a repo inside a nested repo: not split further
  // A worktree's .git is a file.
  mkdirSync(join(base, 'work', 'wt'), { recursive: true });
  writeFileSync(join(base, 'work', 'wt', '.git'), 'gitdir: /elsewhere\n');
  // Links are never followed.
  mkdirSync(join(base, 'links'));
  symlinkSync(join(base, 'client', 'app'), join(base, 'links', 'app'));
  git('.hidden/repo');
  git('kept/one');
  return base;
}

test('discoverNested finds repos one or two levels inside folders that are not repos, never inside a repo or through a link', async () => {
  const base = tree();
  expect(await discoverNested(base)).toEqual([
    'client/api', 'client/app', 'github.com/me/tool', 'github.com/org/other', 'github.com/org/repo', 'kept/one', 'work/wt',
  ]);
  // A folder kept whole (already selected or excluded as one project) is not split.
  expect(await discoverNested(base, { keepWhole: (k) => k === 'kept' })).not.toContain('kept/one');
  // It makes real git repos: a few seconds alone, more on a loaded machine.
}, 20_000);

test('a nested key is its path with a safe separator, and maps back to its folder', () => {
  expect(keyOfRel('github.com/org/repo')).toBe('github.com__org__repo');
  expect(keyOfRel('plain')).toBe('plain');
  const root: Root = { host: '/h', container: '/c', nested: ['github.com/org/repo'] };
  expect(relOfKey('github.com__org__repo', root)).toBe('github.com/org/repo');
  expect(relOfKey('plain', root)).toBe('plain');
});

test('projectFromCwd maps a cwd to the deepest nested git root, and to the top-level folder outside every nested repo', () => {
  const roots: Root[] = [{ host: '/Users/you/src', container: '/vibe', nested: ['client/app', 'github.com/org/repo', 'github.com/org'] }];
  expect(projectFromCwd('/Users/you/src/github.com/org/repo/pkg/x', roots)).toEqual({
    key: 'github.com__org__repo', name: 'github.com/org/repo', repoPath: '/vibe/github.com/org/repo',
  });
  expect(projectFromCwd('/Users/you/src/github.com/org/repository', roots)?.key).toBe('github.com__org'); // a path prefix, not a text prefix
  expect(projectFromCwd('/Users/you/src/client/app', roots)?.key).toBe('client__app');
  expect(projectFromCwd('/Users/you/src/client/notes', roots)?.key).toBe('client');
  expect(projectFromCwd('/Users/you/src/other/x', roots)?.key).toBe('other');
  expect(hostRepoPath('/Users/you/src/client/app/src/a.ts', roots)).toBe('/Users/you/src/client/app');
  expect(hostRepoPath('/Users/you/src/other/x', roots)).toBe('/Users/you/src/other');
});

test('projectFolders lists plain top-level folders and nested repos, not the folders that hold them', async () => {
  const base = tree();
  const roots: Root[] = [{ host: '/Users/you/src', container: base }];
  await refreshLayout(roots, { keepWhole: (k) => k === 'kept' });
  const folders = await projectFolders(roots);
  expect(folders.map((f) => [f.key, f.host])).toEqual([
    ['kept', '/Users/you/src/kept'],
    ['links', '/Users/you/src/links'],
    ['notes', '/Users/you/src/notes'],
    ['plain-repo', '/Users/you/src/plain-repo'],
    ['client__api', '/Users/you/src/client/api'],
    ['client__app', '/Users/you/src/client/app'],
    ['github.com__me__tool', '/Users/you/src/github.com/me/tool'],
    ['github.com__org__other', '/Users/you/src/github.com/org/other'],
    ['github.com__org__repo', '/Users/you/src/github.com/org/repo'],
    ['work__wt', '/Users/you/src/work/wt'],
  ]);
  expect(folders.find((f) => f.key === 'client__app')?.container).toBe(`${base}/client/app`);
  expect(projectFromCwd('/Users/you/src/github.com/org/repo/src', roots)?.repoPath).toBe(`${base}/github.com/org/repo`);
});
