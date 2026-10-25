import { expect, test } from 'vitest';
import { ProviderUnavailableError, STRICT_JSON, type ActivityInput, type LlmProvider, type RelevanceUpdate, type UnscoredFact } from '@fb/core';
import { scoreFacts, ScoringPacer, type ScoreDeps } from './score.ts';

const fact = (id: string, statement: string, projectKey = 'shop'): UnscoredFact => ({ id, projectKey, kind: 'config', statement, path: 'README.md', why: 'w' });

function deps(todo: UnscoredFact[], answer: (user: string) => unknown, over: Partial<ScoreDeps> = {}) {
  const set: RelevanceUpdate[][] = [];
  const activity: ActivityInput[] = [];
  const asked: { system: string; user: string; cwd?: string }[] = [];
  const llm: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async (t) => { asked.push(t); return answer(t.user); } };
  const d: ScoreDeps = {
    facts: {
      unscoredFacts: async (q) => todo.filter((f) => q.projectKeys.includes(f.projectKey)).slice(0, q.limit),
      setFactRelevance: async (u) => { set.push(u); return u.length; },
    },
    llm,
    projects: () => ['shop'],
    activity: { record: async (a) => { activity.push(a); } },
    ...over,
  };
  return { d, set, activity, asked };
}

test('scoreFacts asks once for a batch of unscored facts and stores each score as the model\'s', async () => {
  const t = deps([fact('f1', 'Set up the profiler app on your machine'), fact('f2', 'Every query is scoped by orgId')], () => ({ scores: [{ n: 1, relevance: 0.1 }, { n: 2, relevance: 0.95 }] }));
  expect(await t.d.facts.unscoredFacts({ projectKeys: ['shop'], limit: 9 })).toHaveLength(2);
  const r = await scoreFacts(t.d);
  expect(r).toEqual({ scored: 2 });
  expect(t.asked).toHaveLength(1);
  // 40 short score objects fit in 1024 tokens even pretty-printed; a runaway answer stops there.
  expect((t.asked[0] as { maxTokens?: number }).maxTokens).toBe(1024);
  expect(t.asked[0].user).toContain('1. [config] README.md: Set up the profiler app');
  expect(t.asked[0].system).toMatch(/external tool/);
  expect(t.set[0]).toEqual([{ id: 'f1', relevance: 0.1, by: 'model' }, { id: 'f2', relevance: 0.95, by: 'model' }]);
  expect(t.activity[0]).toMatchObject({ kind: 'facts_scored', actor: 'ollama:gemma4', projectKey: 'shop', subject: 'scored 2 facts for everyday relevance' });
});

test('an answer of the wrong shape is asked again once, more strictly', async () => {
  const replies: unknown[] = [{ scores: 'all high' }, { scores: [{ n: 1, relevance: 0.5 }] }];
  const t = deps([fact('f1', 'Every query is scoped by orgId')], () => replies.shift());
  expect(await scoreFacts(t.d)).toEqual({ scored: 1 });
  expect(t.asked[1].system).toContain(STRICT_JSON);
});

test('scoreFacts only reads the selected projects, and does nothing when there is nothing to score', async () => {
  const t = deps([fact('x', 'other', 'elsewhere')], () => { throw new Error('should not ask'); });
  expect(await scoreFacts(t.d)).toEqual({ scored: 0 });
  expect(t.set).toEqual([]);
});

test('a fact the model skipped stays unscored for the next round; numbers it invents are ignored or clamped', async () => {
  const t = deps([fact('f1', 'a'), fact('f2', 'b')], () => ({ scores: [{ n: 2, relevance: 4 }, { n: 7, relevance: 0.3 }] }));
  expect(await scoreFacts(t.d)).toEqual({ scored: 1 });
  expect(t.set[0]).toEqual([{ id: 'f2', relevance: 1, by: 'model' }]);
});

test('an unavailable model is reported, not thrown, and nothing is stored', async () => {
  const t = deps([fact('f1', 'a')], () => { throw new ProviderUnavailableError('ECONNREFUSED'); });
  expect(await scoreFacts(t.d)).toEqual({ scored: 0, unavailable: expect.stringContaining('ECONNREFUSED') });
  expect(t.set).toEqual([]);
});

test('the facts go to the model as data in an empty folder, redacted', async () => {
  const key = `ghp_${'D'.repeat(36)}`;
  const t = deps([fact('f1', `token is ${key}`)], () => ({ scores: [] }));
  await scoreFacts(t.d);
  expect(t.asked[0].user).not.toContain(key);
});

test('ScoringPacer waits a while after a round that scored nothing or could not ask, so an idle worker never calls the model every cycle', async () => {
  let calls = 0;
  let answer: { scored: number; unavailable?: string } = { scored: 3 };
  const pacer = new ScoringPacer(async () => { calls++; return answer; }, 10 * 60_000);
  const t0 = 1_000_000;
  expect(await pacer.tick(t0)).toBe(3);
  expect(await pacer.tick(t0 + 1)).toBe(3);
  answer = { scored: 0 };
  expect(await pacer.tick(t0 + 2)).toBe(0);
  expect(await pacer.tick(t0 + 60_000)).toBe(0);
  expect(calls).toBe(3);
  answer = { scored: 0, unavailable: 'down' };
  expect(await pacer.tick(t0 + 2 + 10 * 60_000)).toBe(0);
  expect(await pacer.tick(t0 + 3 + 10 * 60_000)).toBe(0);
  expect(calls).toBe(4);
  answer = { scored: 2 };
  expect(await pacer.tick(t0 + 3 + 20 * 60_000)).toBe(2);
  // A round that throws pauses too.
  const failing = new ScoringPacer(async () => { calls++; throw new Error('boom'); }, 1000);
  expect(await failing.tick(t0)).toBe(0);
  expect(await failing.tick(t0 + 10)).toBe(0);
});
