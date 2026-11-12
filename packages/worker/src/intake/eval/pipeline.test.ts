import type { JsonTask, LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import type { IntakeSeeds } from './fixture.ts';
import { detectOverFixture } from './pipeline.ts';
import type { EvalClaimSide } from './run.ts';

const at = (axis: number) => Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0.05));
/** Timeouts on one axis, the cutover on another, anything else apart. */
const embed = async (texts: string[]) => texts.map((t) => at(/time out|timeout/i.test(t) ? 1 : /cutover/i.test(t) ? 2 : 5));
/** Cites the first line of each fenced statement; contradicts unless they are about the dashboard. */
const judge = (): LlmProvider & { calls: number } => {
  const m = {
    id: 'fake:judge', agentic: false, calls: 0,
    json: async (t: JsonTask) => {
      m.calls++;
      const [a, b] = [...t.user.matchAll(/--- begin untrusted document [^\n]*---\n([^\n]*)/g)].map((x) => x[1]);
      return { explanation: 'they differ', relation: 'contradicts', aQuote: a, bQuote: b };
    },
  };
  return m;
};
const claim = (id: string, source: string, statement: string, over: Partial<EvalClaimSide> = {}): EvalClaimSide => ({
  id, source, type: 'fact', speaker: 'Ana', quote: statement, span: { start: 0, end: statement.length }, statement, about: '', projectKey: 'p', assertedAt: '2026-11-02T10:00:00Z', ...over,
});
const seeds: IntakeSeeds = {
  lessons: [],
  facts: [{ id: 'F1', projectKey: 'p', origin: 'model', kind: 'config', statement: 'Import jobs time out after 120 seconds.', path: 'src/import/config.ts', lines: null, confidence: 0.9, why: 'w', relevance: null, createdAt: '2026-10-28T09:00:00Z' }],
};

test('detection over the fixture: claims against the seeds and earlier claims; a pair in one source is a question', async () => {
  const claims = [
    claim('s1/c1', 's1', 'Import jobs time out after five minutes.', { about: 'import job timeout' }),
    claim('s2/c1', 's2', 'The cutover is on Monday the 23rd.', { about: 'cutover date', assertedAt: '2026-11-09T10:00:00Z' }),
    claim('s2/c2', 's2', 'The cutover is on Wednesday the 25th.', { about: 'cutover date', speaker: 'Bo', assertedAt: '2026-11-09T10:00:00Z' }),
    claim('s2/c3', 's2', 'The dashboard has a dark theme.', { about: 'dashboard', assertedAt: '2026-11-09T10:00:00Z' }),
  ];
  const llm = judge();
  const d = await detectOverFixture({ claims, seeds, owner: 'Jules' }, llm, embed);
  expect(d.conflicts).toEqual([{ a: 's1/c1', b: 'fact:F1', kind: 'disagreement', newer: null }]);
  expect(d.questions).toEqual([expect.objectContaining({ source: 's2', kind: 'contradictory', quote: 'The cutover is on Wednesday the 25th.' })]);
  expect(d.judge).toEqual({ answers: 2, uncited: 0 });
  expect(llm.calls).toBe(2);
});
