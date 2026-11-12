import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityInput, Lesson, LessonCheck } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { checkLessonsAgainstMap } from './codeChanged.ts';

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'ledger', origin: 'ledger', title: id, rule: 'Round amounts with roundCents before display', appliesWhen: 'w', scope: 'project',
  paths: ['web/src/format.ts'], status: 'approved', source: 'postmortem', cause: 'implementation_error', missId: null, createdAt: 't', decidedAt: 't',
  checks: [], checksVersion: 11, triggers: { paths: ['web/src/*.ts'], patterns: [], symbols: ['roundCents'] }, ...over,
});
const map = (symbols: [name: string, path: string][]) => ({ symbols: symbols.map(([name, path]) => ({ name, path })) });

async function repoWith(files: string[]) {
  const repo = await mkdtemp(join(tmpdir(), 'fg-code-changed-'));
  for (const f of files) {
    await mkdir(join(repo, f, '..'), { recursive: true });
    await writeFile(join(repo, f), '');
  }
  return repo;
}

function setup(lessons: Lesson[], files: string[]) {
  const saved = new Map<string, LessonCheck[]>();
  const activity: ActivityInput[] = [];
  const deps = (repo: string) => ({
    k: {
      listLessons: async () => lessons.map((l) => (saved.has(l.id) ? { ...l, checks: saved.get(l.id)! } : l)),
      setLessonChecks: async (id: string, c: LessonCheck[]) => { saved.set(id, c); return true; },
    },
    repoFiles: async () => files,
    activity: { record: async (a: ActivityInput) => void activity.push(a) },
    repo,
  });
  return { saved, activity, deps };
}

describe('approved lessons are re-checked when the code map is rebuilt', () => {
  test('a path, a trigger glob or a named function that vanished is flagged; status untouched; it clears once the code is back', async () => {
    const files = ['web/src/format.ts', 'web/src/money.ts'];
    const repo = await repoWith(files);
    const kept = lesson('kept');
    const moved = lesson('moved', { paths: ['web/src/old.ts'], triggers: { paths: ['web/legacy/*.ts'], patterns: [], symbols: [] } });
    const renamed = lesson('renamed');
    const other = lesson('other', { projectKey: 'web', origin: 'web', paths: ['nowhere.ts'] });
    const s = setup([kept, moved, renamed, other], files);
    const before = map([['roundCents', 'web/src/format.ts']]);
    const after = map([['roundToCents', 'web/src/format.ts']]);
    const r = await checkLessonsAgainstMap(s.deps(repo), { key: 'ledger', repoPath: repo }, before, after);
    expect(r).toEqual({ flagged: ['kept', 'moved', 'renamed'], cleared: [] });
    expect(s.saved.get('moved')![0].why).toMatch(/path `web\/src\/old\.ts` is not in the repository now; its trigger `web\/legacy\/\*\.ts` matches no file now; `roundCents` is gone from the code/);
    expect(s.saved.get('kept')![0]).toMatchObject({ name: 'code-changed', why: expect.stringMatching(/`roundCents` is gone from the code\. Edit, keep or revoke it$/) });
    expect(s.saved.has('other')).toBe(false);
    expect(s.activity[0]).toMatchObject({ kind: 'lessons_checked', projectKey: 'ledger', targets: ['kept', 'moved', 'renamed'] });
    // The next rebuild has no roundCents either: still flagged, not logged again. Once it is back, the flag goes.
    expect(await checkLessonsAgainstMap(s.deps(repo), { key: 'ledger', repoPath: repo }, after, after)).toEqual({ flagged: [], cleared: [] });
    expect(s.saved.get('kept')!.map((c) => c.name)).toEqual(['code-changed']);
    const back = map([['roundCents', 'web/src/format.ts']]);
    expect((await checkLessonsAgainstMap(s.deps(repo), { key: 'ledger', repoPath: repo }, after, back)).cleared).toEqual(['kept', 'renamed']);
    expect(s.saved.get('kept')).toEqual([]);
    await rm(repo, { recursive: true });
  });

  test('a named function moved to another file is flagged; a name the code never defined (a library\'s) is not', async () => {
    const files = ['web/src/format.ts', 'web/src/money.ts'];
    const repo = await repoWith(files);
    const s = setup([lesson('a', { rule: 'Round with roundCents, never Math.round or asyncio.to_thread' })], files);
    await checkLessonsAgainstMap(s.deps(repo), { key: 'ledger', repoPath: repo }, map([['roundCents', 'web/src/format.ts']]), map([['roundCents', 'web/src/money.ts']]));
    expect(s.saved.get('a')![0].why).toMatch(/moved to other files: `roundCents` \(now in web\/src\/money\.ts\)/);
    expect(s.saved.get('a')![0].why).not.toMatch(/to_thread/);
    await rm(repo, { recursive: true });
  });

  test('a path through a symlinked folder is there', async () => {
    const repo = await repoWith(['libs/shared/format.ts']);
    await symlink('libs/shared', join(repo, 'shared'));
    const s = setup([lesson('l', { paths: ['shared/format.ts'], triggers: null, rule: 'Format with care' })], ['libs/shared/format.ts', 'shared']);
    expect(await checkLessonsAgainstMap(s.deps(repo), { key: 'ledger', repoPath: repo }, map([]), map([]))).toEqual({ flagged: [], cleared: [] });
    await rm(repo, { recursive: true });
  });
});
