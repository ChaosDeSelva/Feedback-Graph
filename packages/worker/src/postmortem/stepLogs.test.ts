import { ProviderUnavailableError, type Lesson, type LessonDetail, type PostMortem, type PostMortemInput } from '@fb/core';
import { expect, test } from 'vitest';
import type { PostMortemTrace } from './postmortem.ts';
import { runPostmortems, type PostmortemStepDeps } from './step.ts';

/** The lesson calls a post-mortem may make, answering as for a store with nothing to say; a test overrides what it watches. */
const LESSON_STORE = {
  lessonDetail: async () => null,
  updateLesson: async () => ({ unscoped: false }),
  setLessonChecks: async () => true,
  similarLessons: async () => [],
} satisfies Partial<PostmortemStepDeps['k']>;

const input = (id: string) => ({ feedbackId: id, projectKey: 'shop' }) as PostMortemInput;
const pm = { missed: 'm', causeExplanation: 'c', cause: 'code_not_read', lesson: { title: 't', rule: 'r', appliesWhen: 'w' } } as PostMortem;

function deps(over: Omit<Partial<PostmortemStepDeps>, 'k'> & { k?: Partial<PostmortemStepDeps['k']> } = {}) {
  const logs: [string, object | undefined][] = [];
  const checks: [string, unknown][] = [];
  const d: PostmortemStepDeps = {
    postmortem: async () => pm,
    embed: async (t) => t.map(() => [1]),
    batch: 2,
    log: (m, x) => logs.push([m, x]),
    ...over,
    k: {
      ...LESSON_STORE,
      feedbackNeedingPostmortem: async () => [input('a')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }),
      setLessonChecks: async (id, c) => { checks.push([id, c]); return true; },
      ...over.k,
    },
  };
  return { d, logs, checks };
}

test('a saved post-mortem is logged; one discarded because its feedback went is logged as discarded', async () => {
  const saved = deps();
  await runPostmortems(saved.d);
  expect(saved.logs).toEqual([['postmortem saved', { feedbackId: 'a', cause: 'code_not_read' }]]);
  const gone = deps({ k: { savePostmortem: async () => false } });
  await runPostmortems(gone.d);
  expect(gone.logs).toEqual([['post-mortem discarded: its feedback was removed or its decision undone', { feedbackId: 'a' }]]);
});

test('a duplicate found for a lesson with no checks yet becomes its only check, and its trace says so', async () => {
  const trace = { lessonFlags: [] } as unknown as PostMortemTrace;
  const t = deps({
    postmortem: async () => ({ ...pm, trace }),
    k: { similarLessons: async () => [{ id: 'lesson:old', status: 'approved', createdAt: '2026-10-01T00:00:00Z', cosine: 0.97 }] },
  });
  await runPostmortems(t.d);
  expect(t.checks).toEqual([['lesson:a', [expect.objectContaining({ name: 'duplicate-of', of: 'lesson:old' })]]]);
  expect(trace.lessonFlags).toEqual([expect.objectContaining({ name: 'duplicate-of' })]);
});

test("a no-miss post-mortem flags the owner's lesson that has never been checked", async () => {
  const t = deps({
    postmortem: async () => ({ ...pm, noMiss: 'Nothing was missed.' }),
    k: { lessonDetail: async (id) => ({ lesson: { id, status: 'approved', proposedAs: null, checks: null } as unknown as Lesson }) as LessonDetail },
  });
  await runPostmortems(t.d);
  expect(t.checks).toEqual([['lesson:a', [{ name: 'no-miss', why: expect.stringContaining('Nothing was missed.') }]]]);
});

test('an unavailable model pauses the batch and is logged', async () => {
  const t = deps({ postmortem: async () => { throw new ProviderUnavailableError('ollama is down'); } });
  expect(await runPostmortems(t.d)).toMatchObject({ unavailable: 'ollama is down' });
  expect(t.logs).toEqual([['postmortem model unavailable, pausing until next cycle', { feedbackId: 'a', reason: 'ollama is down', inARow: 0, providerHealthy: false }]]);
});
