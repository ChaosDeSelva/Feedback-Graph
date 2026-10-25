import { expect, test } from 'vitest';
import { codeGraphViews, expandDependents, hotspotScore, isCodeLang, isGitCommit, pathMatches, repoRelative, sessionFiles, sessionWork, suggestLessonPaths, touchedAround, type CodeGraphReads } from './codegraph.ts';
import { hostRepoPath } from './projects.ts';
import type { ParsedSession, ToolCall } from './types.ts';

test('repoRelative keeps paths inside the repo, normalized, and refuses everything outside it', () => {
  expect(repoRelative('/h/vibe/demo/src/a.ts', '/h/vibe/demo')).toBe('src/a.ts');
  expect(repoRelative('/h/vibe/demo/src/../lib/./b.ts', '/h/vibe/demo/')).toBe('lib/b.ts');
  expect(repoRelative('src/a.ts', '/h/vibe/demo', '/h/vibe/demo/packages/x')).toBe('packages/x/src/a.ts');
  expect(repoRelative('/h/vibe/demo/../other/a.ts', '/h/vibe/demo')).toBeNull();
  expect(repoRelative('../../etc/passwd', '/h/vibe/demo', '/h/vibe/demo/src')).toBeNull();
  expect(repoRelative('/h/vibe/demo-two/a.ts', '/h/vibe/demo')).toBeNull();
  expect(repoRelative('/h/vibe/demo', '/h/vibe/demo')).toBeNull();
  expect(repoRelative('/h/vibe/demo/a\0.ts', '/h/vibe/demo')).toBeNull();
  expect(repoRelative('', '/h/vibe/demo')).toBeNull();
});

test('hostRepoPath is the host folder of the project a cwd is in', () => {
  const roots = [{ host: '/Users/me/Vibe', container: '/projects' }];
  expect(hostRepoPath('/Users/me/Vibe/demo/packages/api', roots)).toBe('/Users/me/Vibe/demo');
  expect(hostRepoPath('/elsewhere/demo', roots)).toBeNull();
});

const call = (name: string, filePath: string, ts = '2026-10-01T10:00:00Z'): ToolCall => ({ name, ts, filePath });

test('sessionFiles records which repo files a session read and edited, with the first and last edit time', () => {
  const s: ParsedSession = {
    sessionId: 's', sourceFile: 'f', cwd: '/h/demo/src', gitBranch: null, startedAt: '', endedAt: '', turns: [],
    toolCalls: [
      call('Read', '/h/demo/src/a.ts'),
      call('Edit', '/h/demo/src/a.ts', '2026-10-01T10:05:00+02:00'),
      call('Write', 'b.ts', '2026-10-01T10:01:00Z'),
      call('MultiEdit', '/h/demo/src/a.ts', '2026-10-01T10:09:00Z'),
      call('Delete', '/h/demo/old.ts'),
      call('Read', '/etc/hosts'),
      call('Edit', '/h/demo/.env'),
      { name: 'Bash', ts: '2026-10-01T10:00:00Z', command: 'ls' },
    ],
  };
  expect(sessionFiles(s, '/h/demo')).toEqual([
    { path: 'old.ts', read: false, edited: true, firstEditAt: '2026-10-01T10:00:00.000Z', lastEditAt: '2026-10-01T10:00:00.000Z' },
    { path: 'src/a.ts', read: true, edited: true, firstEditAt: '2026-10-01T08:05:00.000Z', lastEditAt: '2026-10-01T10:09:00.000Z' },
    { path: 'src/b.ts', read: false, edited: true, firstEditAt: '2026-10-01T10:01:00.000Z', lastEditAt: '2026-10-01T10:01:00.000Z' },
  ]);
});

test('pathMatches: plain paths match the file or the folder under it; globs follow gitignore-like rules', () => {
  expect(pathMatches('src/db.ts', 'src/db.ts')).toBe(true);
  expect(pathMatches('./src/db', 'src/db/pool.ts')).toBe(true);
  expect(pathMatches('src/db', 'src/dbx.ts')).toBe(false);
  expect(pathMatches('src/**/*.sql', 'src/a/b/c.sql')).toBe(true);
  expect(pathMatches('src/**/*.sql', 'src/c.sql')).toBe(true);
  expect(pathMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
  expect(pathMatches('*.sql', 'migrations/0001.sql')).toBe(true);
  expect(pathMatches('migrations/**', 'migrations/0001.sql')).toBe(true);
  expect(pathMatches('', 'a.ts')).toBe(false);
  expect(pathMatches('**', 'a.ts')).toBe(true);
});

test('hotspotScore weighs misses most, then churn and dependents on a log scale', () => {
  expect(hotspotScore({ churn: 0, misses: 0, dependents: 0 })).toBe(0);
  expect(hotspotScore({ churn: 3, misses: 0, dependents: 1 })).toBe(3);
  expect(hotspotScore({ churn: 3, misses: 2, dependents: 1 })).toBe(11);
  expect(hotspotScore({ churn: 2, misses: 0, dependents: 0 })).toBe(1.58);
  expect(hotspotScore({ churn: 0, misses: 1, dependents: 0 })).toBeGreaterThan(hotspotScore({ churn: 7, misses: 0, dependents: 0 }));
});

test('expandDependents walks importers breadth first up to a depth, nearest first, each file once', async () => {
  const importers: Record<string, string[]> = { 'db.ts': ['repo.ts', 'cli.ts'], 'repo.ts': ['api.ts', 'db.ts'], 'api.ts': ['main.ts'], 'cli.ts': [] };
  const asked: string[][] = [];
  const of = async (paths: string[]) => {
    asked.push(paths);
    return new Map(paths.map((p) => [p, importers[p] ?? []]));
  };
  expect(await expandDependents(['db.ts'], 2, of)).toEqual([
    { path: 'cli.ts', depth: 1 }, { path: 'repo.ts', depth: 1 }, { path: 'api.ts', depth: 2 },
  ]);
  expect(asked).toEqual([['db.ts'], ['cli.ts', 'repo.ts']]);
  expect(await expandDependents(['db.ts'], 0, of)).toEqual([]);
});

test('suggestLessonPaths keeps model paths the evidence supports, else the narrowest scope the edits show', () => {
  const touched = { edited: ['src/db/pool.ts', 'src/db/query.ts', 'src/api/orders.ts'], fixed: ['src/db/pool.ts'] };
  // the model's own globs survive when they cover a file the session edited
  expect(suggestLessonPaths(['src/db/**', 'docs/**'], touched)).toEqual(['src/db/**']);
  // none supported: the files edited to fix it
  expect(suggestLessonPaths(['docs/**'], touched)).toEqual(['src/db/pool.ts']);
  // many fix files in one folder: that folder
  const many = { edited: [], fixed: ['src/db/a.ts', 'src/db/b.ts', 'src/db/c.ts', 'src/db/d.ts'] };
  expect(suggestLessonPaths([], many)).toEqual(['src/db/**']);
  // fixes everywhere: no narrower scope than the project
  const spread = { edited: [], fixed: ['a.ts', 'b/b.ts', 'c/c.ts', 'd/d.ts'] };
  expect(suggestLessonPaths([], spread)).toEqual([]);
  // no fix edits: what was edited before the feedback
  expect(suggestLessonPaths([], { edited: ['src/x.ts'], fixed: [] })).toEqual(['src/x.ts']);
  // no evidence at all: the model's paths, cleaned
  expect(suggestLessonPaths(['./src/y.ts', '/abs/z.ts', '../up.ts'], { edited: [], fixed: [] })).toEqual(['src/y.ts']);
});

test('touchedAround splits a session\'s edits into before the feedback and the fix after it', () => {
  const f = (path: string, first: string | null, last: string | null, edited = true) => ({ path, read: !edited, edited, firstEditAt: first, lastEditAt: last });
  expect(touchedAround([
    f('a.ts', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z'),
    f('b.ts', '2026-10-01T10:00:00.000Z', '2026-10-01T10:05:00.000Z'),
    f('c.ts', '2026-10-01T10:05:00.000Z', '2026-10-01T10:06:00.000Z'),
    f('d.ts', null, null, false),
  ], '2026-10-01T12:02:00+02:00')).toEqual({ edited: ['a.ts', 'b.ts'], fixed: ['b.ts', 'c.ts'] });
});

test('isGitCommit spots a git commit inside a shell command, and nothing else', () => {
  for (const c of ['git commit -m "x"', 'git add . && git commit -am fix', 'cd /r; git -C /r commit --amend', 'git -c user.name=a commit', 'git --no-pager commit']) expect(isGitCommit(c), c).toBe(true);
  for (const c of ['git status', 'git log --grep commit', 'echo git commit', 'gh pr view', 'git commit-tree abc', 'npm run commit']) expect(isGitCommit(c), c).toBe(false);
});

test('sessionWork counts the edits and commits a session made, and when; reading and other commands are not work', () => {
  const calls: ToolCall[] = [
    { name: 'Read', ts: '2026-10-01T09:00:00Z', filePath: '/r/a.ts' },
    { name: 'Bash', ts: '2026-10-01T09:01:00Z', command: 'git diff' },
    { name: 'Grep', ts: '2026-10-01T09:02:00Z' },
  ];
  expect(sessionWork(calls)).toEqual({ edits: 0, commits: 0, firstAt: null, lastAt: null });
  const work: ToolCall[] = [
    ...calls,
    { name: 'Edit', ts: '2026-10-01T10:00:00+02:00', filePath: '/r/a.ts' },
    { name: 'Write', ts: '2026-10-01T09:30:00Z', filePath: '/r/b.ts' },
    { name: 'MultiEdit', ts: 'not a time', filePath: '/r/c.ts' },
    { name: 'NotebookEdit', ts: '2026-10-01T09:40:00Z', filePath: '/r/n.ipynb' },
    { name: 'Delete', ts: '2026-10-01T09:45:00Z', filePath: '/r/d.ts' },
    { name: 'Bash', ts: '2026-10-01T11:00:00Z', command: 'git commit -m done' },
  ];
  expect(sessionWork(work)).toEqual({ edits: 5, commits: 1, firstAt: '2026-10-01T08:00:00.000Z', lastAt: '2026-10-01T11:00:00.000Z' });
});

test('isCodeLang: docs, data and config are not code; parsed and other programming languages are', () => {
  for (const l of ['typescript', 'python', 'go', 'gdscript', 'rb', 'java', 'sh', 'sql', 'tf', 'css']) expect(isCodeLang(l)).toBe(true);
  for (const l of ['md', 'mdx', 'json', 'yaml', 'yml', 'toml', 'gitignore', 'example', 'godot', 'dockerfile', 'makefile', 'txt']) expect(isCodeLang(l)).toBe(false);
});

function fakeReads(files: { path: string; lang: string; commits: number }[], missesOn: string[] = []): CodeGraphReads {
  const none = async () => [];
  return {
    mapFiles: async (_k, paths) => files.filter((f) => !paths || paths.includes(f.path)).map((f) => ({ path: f.path, lang: f.lang, hash: 'h', loc: 1, isTest: false, churn: { commits: f.commits, lastTs: '2026-10-01' } })),
    symbolsOf: none,
    importsOf: none,
    importersOf: async (_k, paths) => new Map(paths.map((p) => [p, []])),
    testsOf: none,
    importerCounts: async () => new Map(),
    missesOn: async () => missesOn.map((path, i) => ({ missId: `m${i}`, missed: 'x', cause: 'other', causeExplanation: '', feedbackId: 'f', feedbackText: '', sessionId: 's', ts: '2026-10-01', lessonId: null, path, fixedHere: false }) as never),
    edgesTouching: async () => ({ imports: [], tests: [] }),
    approvedLessons: none,
    currentFacts: none,
  };
}

test('hotspots: a busy manifest with no miss scores 0, below quiet code; a miss makes any file count', async () => {
  const files = [{ path: 'deploy/api.yaml', lang: 'yaml', commits: 60 }, { path: 'docs/a.md', lang: 'md', commits: 30 }, { path: 'src/a.ts', lang: 'typescript', commits: 1 }];
  const h = await codeGraphViews(fakeReads(files)).hotspots('demo', 10);
  expect(h.map((x) => [x.path, x.score])).toEqual([['src/a.ts', 1], ['deploy/api.yaml', 0], ['docs/a.md', 0]]);
  const withMiss = await codeGraphViews(fakeReads(files, ['docs/a.md'])).hotspots('demo', 10);
  expect(withMiss[0]).toMatchObject({ path: 'docs/a.md', misses: 1 });
  expect(withMiss[0].score).toBeGreaterThan(4);
});
