import { describe, expect, test } from 'vitest';
import { issueKeyPattern, type Lesson, type RelatedMiss } from '@fb/core';
import { checkBeforeDone, type ContextDeps } from './context.ts';

const lesson = (id = 'lesson:a'): Lesson => ({ id, projectKey: 'demo', title: 'No console', rule: 'Do not use console.log', appliesWhen: 'editing app', scope: 'project', paths: ['src/app.ts'], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' });
const deps = (extra: Partial<ContextDeps> = {}): ContextDeps => ({ roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]], k: { searchLessons: async () => [{ lesson: lesson(), score: .9 }], missesNaming: async () => [], relatedMisses: async () => [], createManualFeedback: async () => 'f1', recordPreDoneCheck: async () => {} }, judge: async () => [], ...extra });

describe('past misses that name the work\'s ticket, beyond the six judged', () => {
  const miss = (missId: string, missed: string): RelatedMiss => ({ missId, missed, feedbackText: '', cause: 'requirement_unstated', sessionId: 's', ts: 't', score: .5 });
  const reply = async (misses: RelatedMiss[]) => {
    const d = deps({
      k: {
        ...deps().k, searchLessons: async () => [], relatedMisses: async () => [],
        // Like the stores: a text match over every miss, at most k.
        missesNaming: async ({ keys, k }) => misses.filter((m) => new RegExp(issueKeyPattern(keys), 'i').test(m.missed)).slice(0, k),
      },
      judge: async (_work, lessons) => lessons.map((hit) => ({ lessonId: hit.lesson.id, status: 'not_applicable' as const, why: 'n/a' })),
    });
    return (await checkBeforeDone({ project: 'demo', task: 'Fixes APP-14', summary: 'fixed the export' }, d)).markdown;
  };

  test('one left over is named, in the singular', async () => {
    const text = await reply(Array.from({ length: 7 }, (_, i) => miss(`m${i}`, `APP-14 broke the export ${i}`)));
    expect(text).toContain('Not judged: 1 more past miss names APP-14 (the 6 nearest this work, one per key in turn, were): m6.');
  });

  test('a full text match says "or more" and lists ten of the rest', async () => {
    const text = await reply(Array.from({ length: 60 }, (_, i) => miss(`m${String(i).padStart(2, '0')}`, `APP-14 broke the export ${i}`)));
    expect(text).toContain('Not judged: 44 or more past misses name APP-14');
    expect(text).toContain('m06, m07, m08, m09, m10, m11, m12, m13, m14, m15, ….');
  });
});

describe('a lost Activity entry for a check that never learned its project', () => {
  const lost = async (q: { project?: string; cwd?: string }) => {
    const logged: [string, Record<string, unknown> | undefined][] = [];
    const refused = async (): Promise<never> => { throw new Error('Failed to connect to server'); };
    const d = deps({ checkTimeoutMs: 300, inScope: refused, activity: { record: refused }, log: (msg, extra) => { logged.push([msg, extra as Record<string, unknown>]); } });
    await expect(checkBeforeDone({ ...q, task: 'edit src/app.ts', summary: 'changed it' }, d)).rejects.toThrow('Failed to connect');
    return logged.find(([msg]) => msg === 'predone_check activity entry not written')?.[1];
  };

  test('is logged under the project it asked for, else its folder', async () => {
    expect(await lost({ project: 'demo' })).toMatchObject({ project: 'demo', status: 'failed', error: 'Failed to connect to server' });
    expect(await lost({ cwd: '/projects/demo' })).toMatchObject({ project: '/projects/demo', status: 'failed' });
  });
});
