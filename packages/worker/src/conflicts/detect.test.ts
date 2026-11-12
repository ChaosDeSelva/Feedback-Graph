import { CONFLICT_MIN_COSINE, ModelOutputError, type ConflictSideInfo, type JsonTask, type LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { IntakeBudgetSpent } from '../intake/budget.ts';
import { candidatePairs, detectFor, emptyTally, sameButValuesDiffer, type ConflictSink, type DetectDeps, type Neighbour } from './detect.ts';
import { JUDGE_SYSTEM } from './judge.ts';

const side = (id: string, text: string, over: Partial<ConflictSideInfo> = {}): ConflictSideInfo => ({
  ref: { kind: 'claim', id }, projectKey: 'shop', text, citable: [text], about: 'retry timeout', area: null, files: [], assertedAt: '2026-11-02T10:00:00Z',
  speaker: 'person:ana', owner: false, type: 'fact', due: null, docId: `doc:${id}`, fingerprint: `fp:${id}`, ...over,
});
const A = side('a', 'The retry timeout is 30 seconds.');
const B = side('b', 'The retry timeout is 60 seconds.', { speaker: 'person:bo', assertedAt: '2026-11-09T10:00:00Z' });

/** A judge answering from a table by the pair's texts; it records what it was asked. */
function judge(answer: (t: JsonTask) => unknown): LlmProvider & { asked: JsonTask[] } {
  const asked: JsonTask[] = [];
  return { id: 'fake:judge', agentic: false, vision: false, asked, json: async (t) => { asked.push(t); return answer(t); } };
}
const contradicts = { explanation: 'the timeouts differ', relation: 'contradicts', aQuote: '30 seconds', bQuote: '60 seconds', confidence: 0.9 };

function harness(ns: Neighbour[], llm: LlmProvider | null) {
  const memo = new Map<string, string>();
  const found: { conflicts: Parameters<ConflictSink['conflict']>[0][]; questions: string[][]; links: string[][] } = { conflicts: [], questions: [], links: [] };
  const deps: DetectDeps = {
    neighbours: async () => ns, linked: () => false, llm,
    memo: { get: async (k) => memo.get(k) ?? null, set: async (k, v) => void memo.set(k, v) },
    sink: {
      conflict: async (c) => { found.conflicts.push(c); return true; },
      question: async (a, b) => void found.questions.push([a.ref.id, b.ref.id]),
      link: async (a, b, r) => void found.links.push([a.ref.id, b.ref.id, r]),
    },
  };
  return { deps, found, memo };
}

test('a contradiction cited from both sides opens a disagreement, with the pre-filter signals; judged once', async () => {
  const llm = judge(() => contradicts);
  const h = harness([{ side: B, cosine: 0.8 }], llm);
  const t = emptyTally();
  await detectFor(A, h.deps, t);
  expect(h.found.conflicts).toEqual([expect.objectContaining({ kind: 'disagreement', a: A, b: B, judge: expect.objectContaining({ aQuote: '30 seconds', bQuote: '60 seconds' }) })]);
  expect(h.found.conflicts[0].signals.map((s) => s.family)).toEqual(['number']);
  expect(llm.asked[0].system).toBe(JUDGE_SYSTEM);
  expect(llm.asked[0].user).toContain('--- begin untrusted document');
  expect(llm.asked[0].user).not.toContain('person:');
  // The same pair again: memoised, no second call.
  await detectFor(A, h.deps, t);
  expect(llm.asked).toHaveLength(1);
  expect(t).toMatchObject({ sides: 2, pairs: 2, judged: 1, memoised: 1, conflicts: 1 });
});

test('an answer that does not cite both sides is dropped and counted judge_uncited', async () => {
  const h = harness([{ side: B, cosine: 0.8 }], judge(() => ({ ...contradicts, bQuote: '90 seconds' })));
  const t = emptyTally();
  await detectFor(A, h.deps, t);
  expect(h.found.conflicts).toEqual([]);
  expect(t).toMatchObject({ judged: 1, uncited: 1, conflicts: 0 });
});

test('a newer decision by the same speaker is a supersession, the older side first', async () => {
  const older = side('o', 'Decision: cap each batch at 500 rows.', { type: 'decision', about: 'batch cap' });
  const newer = side('n', 'Decision: raise the batch cap to 2000 rows.', { type: 'decision', about: 'batch cap', assertedAt: '2026-11-16T10:00:00Z' });
  const h = harness([{ side: older, cosine: 0.9 }], judge(() => ({ ...contradicts, aQuote: 'raise the batch cap to 2000 rows', bQuote: 'cap each batch at 500 rows' })));
  await detectFor(newer, h.deps, emptyTally());
  expect(h.found.conflicts).toEqual([expect.objectContaining({ kind: 'supersession', a: older, b: newer, judge: expect.objectContaining({ aQuote: 'cap each batch at 500 rows' }) })]);
});

test('a contradiction inside one source is a question; same and refines are links', async () => {
  const sibling = { ...B, docId: A.docId };
  const h = harness([{ side: sibling, cosine: 0.8 }], judge(() => contradicts));
  await detectFor(A, h.deps, emptyTally());
  expect(h.found).toMatchObject({ conflicts: [], questions: [['a', 'b']] });
  const r = harness([{ side: side('r', 'The retry timeout is 30 seconds, with jitter.'), cosine: 0.9 }], judge(() => ({ ...contradicts, relation: 'refines', bQuote: 'with jitter' })));
  await detectFor(A, r.deps, emptyTally());
  expect(r.found.links).toEqual([['a', 'r', 'refines']]);
});

test('the same words are a duplicate with no model call; a pair with no signal under the judge cosine is never judged', async () => {
  const llm = judge(() => contradicts);
  const h = harness([{ side: side('d', 'the retry timeout is 30 seconds'), cosine: 0.99 }, { side: side('q', 'Retry timeouts are logged.'), cosine: 0.8 }], llm);
  const t = emptyTally();
  await detectFor(A, h.deps, t);
  expect(h.found.links).toEqual([['a', 'd', 'same']]);
  expect(llm.asked).toHaveLength(0);
  expect(t).toMatchObject({ pairs: 2, judged: 0 });
});

test('candidates: under the minimum cosine, outside the scope or the side itself are left out, and at most five go on', () => {
  const near = (i: number, cosine: number) => ({ side: side(`n${i}`, `The retry timeout is ${i} seconds.`), cosine });
  const ns = [near(1, CONFLICT_MIN_COSINE - 0.01), { side: { ...B, projectKey: 'billing' }, cosine: 0.95 }, { side: A, cosine: 1 }, ...[2, 3, 4, 5, 6, 7].map((i) => near(i, 0.9 - i / 100))];
  expect(candidatePairs(A, ns, () => false).map((n) => n.side.ref.id)).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
});

test('a spent budget stops the round unmemoised; an unusable answer skips the pair', async () => {
  const spent = harness([{ side: B, cosine: 0.8 }], { id: 'fake', agentic: false, vision: false, json: async () => { throw new IntakeBudgetSpent(60, 'spent'); } });
  const t = emptyTally();
  await detectFor(A, spent.deps, t);
  expect(t.spent).toBe(true);
  expect(spent.memo.size).toBe(0);
  const bad = harness([{ side: B, cosine: 0.8 }], { id: 'fake', agentic: false, vision: false, json: async () => { throw new ModelOutputError('cut', ''); } });
  const u = emptyTally();
  await detectFor(A, bad.deps, u);
  expect(u).toMatchObject({ unusable: 1, judged: 0, spent: false });
});

test('"same" while the pre-filter read different values is a contradiction the judge misread', () => {
  const v = { relation: 'same' as const, aQuote: 'five minutes', bQuote: '120 seconds', explanation: 'both say the timeout', confidence: 0.5 };
  const numbers = [{ family: 'number' as const, key: 'time', a: ['five minutes'], b: ['120 seconds'], why: 'numbers differ: five minutes vs 120 seconds (300 vs 120 seconds)' }];
  expect(sameButValuesDiffer(v, numbers)).toMatchObject({ relation: 'contradicts', explanation: expect.stringContaining('300 vs 120 seconds') });
  expect(sameButValuesDiffer(v, [])).toBe(v);
  expect(sameButValuesDiffer({ ...v, relation: 'refines' }, numbers).relation).toBe('refines');
});
