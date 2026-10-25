import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { junkPathReason, repoHas, validateLessonPaths } from './paths.ts';

test('repoHas looks in the repository on disk; no repository known is not a reason to drop a path', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fg-paths-'));
  await mkdir(join(repo, 'api'));
  await writeFile(join(repo, 'api/search.ts'), '');
  expect(await repoHas(repo, 'api/search.ts')).toBe(true);
  expect(await repoHas(repo, 'api')).toBe(true);
  expect(await repoHas(repo, 'api/gone.ts')).toBe(false);
  expect(await repoHas(repo, '../etc/passwd')).toBe(false);
  expect(await repoHas(null, 'api/gone.ts')).toBe(true);
  expect(await repoHas(join(repo, 'not-mounted'), 'api/gone.ts')).toBe(true);
});

const repo = new Set(['src/webapp/core/src/tasks/tasks-page.tsx', 'src/webapp/core/src/upload/constants.ts', 'api/search.ts', 'api/db.ts', 'cmd/migrate/main.go', 'src/fido/notion-page-form.tsx']);
const exists = async (p: string) => repo.has(p) || [...repo].some((f) => f.startsWith(`${p}/`));

describe('junkPathReason', () => {
  test('instruction files, PR refs, bare identifiers, home or absolute paths and malformed globs are not lesson paths', () => {
    expect(junkPathReason('src/webapp/AGENTS.md')).toMatch(/instruction file/);
    expect(junkPathReason('CLAUDE.md')).toMatch(/instruction file/);
    expect(junkPathReason('acme/shop#13513')).toMatch(/pull request/);
    expect(junkPathReason('github/acme/shop#14254')).toMatch(/pull request/);
    expect(junkPathReason('handleUpload')).toMatch(/identifier/);
    expect(junkPathReason('~/.config/acme/settings.json')).toMatch(/repository/);
    expect(junkPathReason('/Users/me/acme/api/search.ts')).toMatch(/repository/);
    expect(junkPathReason('https://github.com/acme/shop/pull/3')).toMatch(/repository/);
    expect(junkPathReason('src/{a,b')).toMatch(/malformed/);
    expect(junkPathReason('src/***/x.ts')).toMatch(/malformed/);
    expect(junkPathReason('src/my file.ts')).toMatch(/malformed/);
  });

  test('repo paths, bare file names and globs pass', () => {
    for (const p of ['api/search.ts', 'tasks-page.tsx', 'src/**', 'src/**/*.test.ts', 'Makefile', 'docs/README.md']) expect(junkPathReason(p), p).toBeNull();
  });
});

describe('validateLessonPaths', () => {
  test('a review comment: the commented file is in the set; junk and unsupported paths go', async () => {
    const r = await validateLessonPaths(['src/fido/AGENTS.md', 'api/search.ts', 'src/webapp/core/src/settings/users/**'], { commentPath: 'api/search.ts', named: '', touched: { edited: [], fixed: [] }, exists });
    expect(r.paths).toEqual(['api/search.ts']);
    expect(r.dropped.map((d) => d.path)).toEqual(['src/fido/AGENTS.md', 'src/webapp/core/src/settings/users/**']);
  });

  test('a review comment whose lesson names other files: the commented file is added; a file the comment names may stay', async () => {
    const r = await validateLessonPaths(['api/db.ts'], { commentPath: 'api/search.ts', named: 'see api/db.ts for the pool', touched: { edited: [], fixed: [] }, exists });
    expect(r.paths).toEqual(['api/search.ts', 'api/db.ts']);
  });

  test('bare file names and partial paths resolve to the one known file they name, else drop', async () => {
    const touched = { edited: ['src/webapp/core/src/tasks/tasks-page.tsx'], fixed: ['src/webapp/core/src/upload/constants.ts'] };
    const r = await validateLessonPaths(['tasks-page.tsx', 'core/src/upload/constants.ts', 'missing.tsx'], { named: '', touched, exists, transcript: true });
    expect(r.paths).toEqual(['src/webapp/core/src/tasks/tasks-page.tsx', 'src/webapp/core/src/upload/constants.ts']);
    expect(r.dropped).toEqual([{ path: 'missing.tsx', why: expect.stringMatching(/bare file name/) }]);
  });

  test('a path that is not in the repository is dropped', async () => {
    const r = await validateLessonPaths(['api/search.ts', 'api/gone.ts', 'web/**'], { named: '', touched: { edited: ['api/search.ts'], fixed: [] }, exists, transcript: true });
    expect(r.paths).toEqual(['api/search.ts']);
    expect(r.dropped.map((d) => d.path)).toEqual(['api/gone.ts', 'web/**']);
  });

  test('a review or issue comment with no file: only paths the comment, its diff or the session evidence; never the session edits as a fallback', async () => {
    const touched = { edited: ['src/webapp/core/src/tasks/tasks-page.tsx'], fixed: [] };
    const r = await validateLessonPaths(['cmd/migrate/main.go', 'api/db.ts'], { named: 'Atlas partial hashes in cmd/migrate/main.go', touched, exists });
    expect(r.paths).toEqual(['cmd/migrate/main.go']);
    const none = await validateLessonPaths(['api/db.ts'], { named: 'this races', touched, exists });
    expect(none.paths).toEqual([]);
  });

  test('a transcript: the model paths the repo has stand; with none, the files edited to fix it, never everything edited', async () => {
    const touched = { edited: ['api/db.ts', 'cmd/migrate/main.go'], fixed: ['api/search.ts'] };
    expect((await validateLessonPaths(['src/fido/notion-page-form.tsx'], { named: '', touched, exists, transcript: true })).paths).toEqual(['src/fido/notion-page-form.tsx']);
    expect((await validateLessonPaths(['handleUpload'], { named: '', touched, exists, transcript: true })).paths).toEqual(['api/search.ts']);
    expect((await validateLessonPaths([], { named: '', touched: { edited: ['api/db.ts'], fixed: [] }, exists, transcript: true })).paths).toEqual([]);
  });

  test('a global lesson keeps the clean paths the model gave; no repository to check them against', async () => {
    const r = await validateLessonPaths(['**/*.sql', 'AGENTS.md'], { named: '', touched: { edited: [], fixed: [] }, global: true });
    expect(r.paths).toEqual(['**/*.sql']);
  });

  test('without a repository to look in, existence is not checked', async () => {
    const r = await validateLessonPaths(['api/other.ts'], { named: '', touched: { edited: ['api/other.ts'], fixed: [] }, transcript: true });
    expect(r.paths).toEqual(['api/other.ts']);
  });
});
