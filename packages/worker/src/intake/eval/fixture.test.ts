import { fileURLToPath } from 'node:url';
import { conflictPrefilter } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { fixtureProblems, loadIntakeFixture, type IntakeFixture } from './fixture.ts';
import { scoreIntakeRun, type PredictedRun } from './score.ts';

const DIR = fileURLToPath(new URL('../../../../../fixtures/intake', import.meta.url));

describe('the intake fixture', async () => {
  const f = await loadIntakeFixture(DIR);
  const e = f.expected;

  test('holds together: eight sources in every format, a notes file and a hostile one', () => {
    expect(fixtureProblems(f)).toEqual([]);
    expect(e.sources).toHaveLength(8);
    expect(new Set(e.sources.map((s) => s.format))).toEqual(new Set(['vtt', 'srt', 'txt', 'md']));
    expect(e.sources.some((s) => s.kind === 'notes')).toBe(true);
    expect(e.mustDrop.map((d) => d.reason).sort()).toEqual(['fabricated', 'injection', 'injection']);
  });

  test('plants every contradiction the release bar measures', () => {
    const by = (expect_: string) => e.contradictions.filter((c) => c.expect === expect_);
    expect(new Set(by('disagreement').map((c) => c.family))).toEqual(new Set(['number', 'negation', 'date', 'version', 'alternative']));
    expect(by('supersession')).toHaveLength(1);
    expect(by('none').map((c) => c.relation).sort()).toEqual(['refines', 'same']);
    expect(by('question')).toHaveLength(1);
    const sides = e.contradictions.flatMap((c) => [c.a, c.b]);
    expect(sides).toContain('lesson:L1');
    expect(sides).toContain('fact:F1');
  });

  test('a same-speaker reversal is the same Person, later, on a decision', () => {
    const r = e.contradictions.find((c) => c.expect === 'supersession')!;
    const [a, b] = [r.a, r.b].map((id) => e.claims.find((c) => c.id === id)!);
    const when = (src: string) => e.sources.find((s) => s.id === src)!.occurredAt;
    expect(a.speaker).toBe(b.speaker);
    expect(b.type).toBe('decision');
    expect(when(b.source) > when(a.source)).toBe(r.newer === 'b');
  });

  // The pre-filters must let every planted conflict through to the judge, and the planted non-conflicts must not trip them.
  test('each planted contradiction trips its pre-filter family; the refinement and the duplicate trip none', () => {
    const sideOf = (ref: string) => {
      const lesson = e.seeds.lessons.find((l) => `lesson:${l.id}` === ref);
      if (lesson) return { text: lesson.rule, assertedAt: lesson.decidedAt };
      const fact = e.seeds.facts.find((x) => `fact:${x.id}` === ref);
      if (fact) return { text: fact.statement, assertedAt: fact.createdAt };
      const c = e.claims.find((x) => x.id === ref)!;
      return { text: c.quote, assertedAt: e.sources.find((s) => s.id === c.source)!.occurredAt };
    };
    for (const c of e.contradictions) {
      const r = conflictPrefilter(sideOf(c.a), sideOf(c.b));
      if (c.family) expect(r.signals.map((s) => s.family), c.id).toContain(c.family);
      else expect(r.signals, c.id).toEqual([]);
    }
  });

  test('a run that finds exactly what is expected passes the release bar', () => {
    const own = (ref: string) => (ref.includes(':') ? ref : `p/${ref}`);
    const run: PredictedRun = {
      model: 'fake:expected',
      claims: e.claims.filter((c) => !c.optional).map((c) => ({ ...c, id: `p/${c.id}` })),
      questions: e.questions.filter((q) => !q.optional).map((q) => ({ id: `p/${q.id}`, source: q.source, kind: q.kind, askedBy: q.askedBy, quote: q.quotes[0].quote, span: q.quotes[0].span })),
      conflicts: e.contradictions.filter((c) => c.expect === 'disagreement' || c.expect === 'supersession').map((c) => ({
        a: own(c.a), b: own(c.b), kind: c.expect as 'disagreement' | 'supersession', newer: c.newer ? own(c.newer === 'a' ? c.a : c.b) : null,
      })),
      relations: e.contradictions.filter((c) => c.relation).map((c) => ({ a: own(c.a), b: own(c.b), relation: c.relation! })),
      dropped: { injection: 2, unquoted: 1 }, judge: { answers: 10, uncited: 0 },
      cost: { extract: { calls: 9, seconds: 1 }, judge: { calls: 10, seconds: 1 } },
    };
    const s = scoreIntakeRun(f, run);
    expect(s.claims.precision.rate).toBe(1);
    expect(s.claims.recall.rate).toBe(1);
    expect(s.conflictRecall.rate).toBe(1);
    expect(s.supersessionAccuracy.rate).toBe(1);
    expect(s.falseConflicts).toEqual([]);
    expect(s.fabricatedKept).toEqual([]);
    expect(s.bar.pass).toBe(true);
  });
});

describe('fixtureProblems', () => {
  const base = (): IntakeFixture => ({
    texts: new Map([['s1', 'Ana: hello there.']]),
    expected: {
      version: 1, owner: 'O',
      sources: [{ id: 's1', file: 'f', kind: 'notes', format: 'txt', projectKey: null, occurredAt: '2026-11-01T00:00:00Z', participants: [], origin: 'o', private: false }],
      seeds: { lessons: [], facts: [] },
      claims: [{ id: 'c1', source: 's1', type: 'fact', speaker: 'Ana', quote: 'hello there.', span: { start: 5, end: 17 } }],
      questions: [], mustDrop: [], contradictions: [],
    },
  });
  test('a sound fixture has none', () => expect(fixtureProblems(base())).toEqual([]));
  test('a span that does not hold its quote, an unknown source or side, a duplicate id, and incomplete expectations are named', () => {
    const f = base();
    f.expected.claims.push({ id: 'c1', source: 's9', type: 'fact', speaker: null, quote: 'x', span: { start: 0, end: 1 } });
    f.expected.claims.push({ id: 'c2', source: 's1', type: 'fact', speaker: null, quote: 'hello', span: { start: 0, end: 5 } });
    f.expected.contradictions.push({ id: 'k1', family: null, a: 'c1', b: 'lesson:L9', expect: 'supersession' });
    f.expected.contradictions.push({ id: 'k2', family: null, a: 'c1', b: 'c2', expect: 'none' });
    expect(fixtureProblems(f)).toEqual([
      'duplicate id c1',
      'c1: unknown source s9',
      'c2: span 0-5 of s1 is "Ana: ", not "hello"',
      'k1: unknown side lesson:L9',
      'k1: a supersession names the newer side',
      'k2: a planted non-conflict names its relation',
    ]);
  });
});
