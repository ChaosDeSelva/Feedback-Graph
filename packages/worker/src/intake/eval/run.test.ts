import type { LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { IntakeExpected, type IntakeFixture } from './fixture.ts';
import { meteredProvider, runIntakeEval, type EvalClaimSide, type IntakeEvalPipeline } from './run.ts';

const llm = (fail = false): LlmProvider => ({ id: 'fake:model', agentic: false, json: async () => { if (fail) throw new Error('down'); return {}; } });
/** A clock that moves 2 s on every reading. */
const ticking = () => {
  let t = 0;
  return () => (t += 2000);
};

test('meteredProvider counts every call and its seconds, failed calls included', async () => {
  const cost = { calls: 0, seconds: 0 };
  const m = meteredProvider(llm(), cost, ticking());
  await m.json({ system: '', user: '', schema: {} });
  await expect(meteredProvider(llm(true), cost, ticking()).json({ system: '', user: '', schema: {} })).rejects.toThrow('down');
  expect(cost).toEqual({ calls: 2, seconds: 4 });
  expect(m.id).toBe('fake:model');
});

const fixture: IntakeFixture = {
  texts: new Map([['late', 'Bo: Ship in January.'], ['early', 'Ana: Ship on 12 December.']]),
  expected: IntakeExpected.parse({
    version: 1, owner: 'Jules',
    sources: [
      { id: 'late', file: 'b.txt', kind: 'transcript', format: 'txt', projectKey: 'p', occurredAt: '2026-11-16T00:00:00Z', participants: ['Bo'], origin: 'call', private: true },
      { id: 'early', file: 'a.txt', kind: 'transcript', format: 'txt', projectKey: 'p', occurredAt: '2026-11-04T00:00:00Z', participants: ['Ana'], origin: 'call', private: true },
    ],
    seeds: { lessons: [], facts: [] }, claims: [], questions: [], mustDrop: [], contradictions: [],
  }),
};

test('runIntakeEval extracts sources oldest first, detects over every claim, and meters each phase apart', async () => {
  const seen: string[] = [];
  let detected: EvalClaimSide[] = [];
  const pipeline: IntakeEvalPipeline = {
    async extract(source, model) {
      seen.push(`${source.id}:${source.text}`);
      await model.json({ system: '', user: source.text, schema: {} });
      const quote = source.text.slice(source.text.indexOf(' ') + 1);
      return {
        claims: [{ id: 'c1', type: 'plan', speaker: source.participants[0], quote, span: { start: source.text.indexOf(quote), end: source.text.length } }],
        questions: [{ id: 'q1', kind: 'unanswered', askedBy: null, quote, span: { start: 0, end: 3 } }],
        dropped: { unquoted: 1 },
      };
    },
    async detect(input, model) {
      detected = input.claims;
      await model.json({ system: '', user: 'judge', schema: {} });
      await model.json({ system: '', user: 'judge', schema: {} });
      return {
        conflicts: [{ a: 'early/c1', b: 'late/c1', kind: 'disagreement' }], relations: [],
        questions: [{ id: 'cq', source: 'late', kind: 'contradictory', askedBy: null, quote: 'x', span: { start: 0, end: 1 } }],
        judge: { answers: 2, uncited: 1 },
      };
    },
  };
  const run = await runIntakeEval(fixture, pipeline, llm(), { now: ticking() });
  expect(seen).toEqual(['early:Ana: Ship on 12 December.', 'late:Bo: Ship in January.']);
  expect(detected.map((c) => [c.id, c.source, c.projectKey, c.assertedAt])).toEqual([
    ['early/c1', 'early', 'p', '2026-11-04T00:00:00Z'], ['late/c1', 'late', 'p', '2026-11-16T00:00:00Z'],
  ]);
  expect(run.model).toBe('fake:model');
  expect(run.claims.map((c) => Object.keys(c).sort())).toEqual([['id', 'quote', 'source', 'span', 'speaker', 'type'], ['id', 'quote', 'source', 'span', 'speaker', 'type']]);
  expect(run.questions.map((q) => q.id)).toEqual(['early/q1', 'late/q1', 'cq']);
  expect(run.dropped).toEqual({ unquoted: 2 });
  expect(run.judge).toEqual({ answers: 2, uncited: 1 });
  expect(run.cost).toEqual({ extract: { calls: 2, seconds: 4 }, judge: { calls: 2, seconds: 4 } });
});
