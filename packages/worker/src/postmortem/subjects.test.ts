import { expect, test } from 'vitest';
import type { ActivityInput, UnsortedMiss } from '@fb/core';
import { MISS_SUBJECT_CURSOR, MISS_SUBJECT_VERSION, sortOldMisses } from './subjects.ts';

const miss = (id: string, feedbackText: string, rule: string | null, commentPath: string | null = null, projectKey = 'demo', paths: string[] = []): UnsortedMiss => ({ missId: id, projectKey, feedbackText, rule, commentPath, paths });

function fakes(misses: UnsortedMiss[], processed: UnsortedMiss[] = [], cursor: string | null = null) {
  const set: [string, 'process' | null][] = [];
  const activity: ActivityInput[] = [];
  const cursors = new Map<string, string>(cursor ? [[MISS_SUBJECT_CURSOR, cursor]] : []);
  const page = (list: UnsortedMiss[]) => async (q: { limit: number; afterId?: string | null }) => list.filter((m) => !q.afterId || m.missId > q.afterId).slice(0, q.limit);
  return {
    set, activity, cursors,
    deps: {
      knowledge: {
        missesWithoutSubject: page(misses),
        processMisses: page(processed),
        setMissSubject: async (id: string, subject: 'process' | null) => { set.push([id, subject]); return true; },
      },
      cursors: { getCursor: async (k: string) => cursors.get(k) ?? null, setCursor: async (k: string, v: string) => { cursors.set(k, v); } },
      activity: { record: async (a: ActivityInput) => { activity.push(a); } },
    },
  };
}

test('old misses about how the work was handled become process misses, once per rule version, counted per project', async () => {
  const misses = [
    miss('miss:a', 'you merged it back to main, it was supposed to stay on its own branch', 'Keep work on its own branch and never merge to main unless asked'),
    miss('miss:b', "this isn't good enough, filter server-side", 'Filter search on the server in api/search.ts'),
    // A review comment on a file stays on it, whatever it says.
    miss('miss:c', 'this commit should not touch the schema', 'Do not change schema.sql in a feature commit', 'db/schema.sql'),
    // Feedback about git with a lesson about the code: still about the code.
    miss('miss:d', 'you pushed a broken build', 'Run pnpm test before changing pipeline.ts'),
    miss('miss:e', 'you opened the PR against main, I said the release branch', 'Open pull requests against the release branch', null, 'shop'),
    // A complaint about the code said of a PR, and a lesson with a file: about the code.
    miss('miss:f', 'This PR breaks login on token expiry', 'Before opening a PR, test token expiry in auth/session.ts'),
    miss('miss:g', 'you merged before I could look', 'Never merge without asking', null, 'demo', ['src/api.ts']),
  ];
  const { set, activity, cursors, deps } = fakes(misses);
  expect(await sortOldMisses(deps)).toEqual({ marked: 2, restored: 0 });
  expect(set).toEqual([['miss:a', 'process'], ['miss:e', 'process']]);
  expect(activity.map((a) => [a.kind, a.projectKey, a.targets])).toEqual([['misses_reclassified', 'demo', ['miss:a']], ['misses_reclassified', 'shop', ['miss:e']]]);
  expect(activity[0].details).toMatchObject({ subject: 'process', count: 1, version: MISS_SUBJECT_VERSION });
  expect(cursors.get(MISS_SUBJECT_CURSOR)).toBe(`v${MISS_SUBJECT_VERSION}`);
  expect(await sortOldMisses(deps)).toBeNull();
});

test('misses the first rule marked process that are about the code get their files back; true process misses stay', async () => {
  const processed = [
    miss('miss:f', 'This PR breaks login on token expiry', 'Before opening a PR, test token expiry in auth/session.ts'),
    miss('miss:a', 'you merged it back to main, it was supposed to stay on its own branch', 'Keep work on its own branch and never merge to main unless asked'),
  ];
  const { set, activity, cursors, deps } = fakes([], processed, 'v1');
  expect(await sortOldMisses(deps)).toEqual({ marked: 0, restored: 1 });
  // Back to no subject: tied again to the files its session edited (they are read from the session, not stored on it).
  expect(set).toEqual([['miss:f', null]]);
  expect(activity).toEqual([expect.objectContaining({ kind: 'misses_reclassified', projectKey: 'demo', targets: ['miss:f'], details: expect.objectContaining({ subject: null, count: 1, version: MISS_SUBJECT_VERSION }) })]);
  expect(cursors.get(MISS_SUBJECT_CURSOR)).toBe(`v${MISS_SUBJECT_VERSION}`);
});

test('a process miss the post-mortem marked under the first rule is checked too, even when the sort never ran', async () => {
  const { set, deps } = fakes([], [miss('miss:f', 'This PR breaks login on token expiry', 'Before opening a PR, test token expiry in auth/session.ts')]);
  expect(await sortOldMisses(deps)).toEqual({ marked: 0, restored: 1 });
  expect(set).toEqual([['miss:f', null]]);
});

test('v3: an instruction about git ("don\'t push a PR yet") whose lesson carries the session\'s files is detached from them, once', async () => {
  const tenFiles = Array.from({ length: 10 }, (_, i) => `web/src/chat/f${i}.ts`);
  const misses = [
    miss('miss:i', "keep this on its own branch, don't push a PR yet", 'Do not push until the developer has looked', null, 'demo', tenFiles),
    miss('miss:n', "keep it on its own branch, don't push a PR yet", null),
    miss('miss:b', "this isn't good enough, filter server-side", 'Filter search on the server in api/search.ts', null, 'demo', ['api/search.ts']),
  ];
  const { set, activity, cursors, deps } = fakes(misses, [], 'v2');
  expect(MISS_SUBJECT_VERSION).toBe(3);
  expect(await sortOldMisses(deps)).toEqual({ marked: 2, restored: 0 });
  expect(set).toEqual([['miss:i', 'process'], ['miss:n', 'process']]);
  expect(activity).toEqual([expect.objectContaining({ kind: 'misses_reclassified', projectKey: 'demo', targets: ['miss:i', 'miss:n'], details: expect.objectContaining({ subject: 'process', version: 3 }) })]);
  expect(cursors.get(MISS_SUBJECT_CURSOR)).toBe('v3');
  expect(await sortOldMisses(deps)).toBeNull();
});
