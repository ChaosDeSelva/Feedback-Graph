import { describe, expect, test } from 'vitest';
import { ABSENT, factSnapshot, LESSON_SIGNAL_COUNTS, LOOP_ACTOR, lessonFingerprint, lessonSnapshot, type Activity, type Decision, type DecisionNote, type Lesson, type LessonDetail, type LessonSignals, type StoredFact } from '@fb/core';
import { MODEL_FACT_WHY } from '../../postmortem/lessonCheck.ts';
import { activity, fakeContext, observedAs } from '../testing/context.ts';
import { score } from '../policy.ts';
import { overlap, plannedFactId, recordFact, SAME_STATEMENT, words } from './record_fact.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: 'Cents', rule: 'Amounts are stored in integer cents in src/money.ts', appliesWhen: 'editing payments', scope: 'project',
  paths: ['src/money.ts'], status: 'proposed', source: 'postmortem', cause: 'context_missing', missId: `miss:${id}`, createdAt: '2026-10-01T00:00:00.000Z',
  decidedAt: null, decidedBy: null, decisionNote: null, checks: [{ name: 'looks-like-a-fact', why: 'states how the code is' }], checksVersion: 6, ...o,
});
const signals = (lessonId: string, o: Partial<LessonSignals['counts']> = {}, lastOwnerTouch: string | null = null): LessonSignals => ({
  lessonId, counts: { ...Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, 0])), ...o } as LessonSignals['counts'], lastServed: null, lastOwnerTouch, updatedAt: '2026-11-01T00:00:00Z',
});

type Setup = {
  lessons?: Lesson[];
  missed?: string | null;
  sig?: Record<string, LessonSignals>;
  decided?: Decision[];
  entries?: Activity[];
  history?: Activity[];
  notes?: Record<string, Partial<DecisionNote>[]>;
  facts?: Partial<StoredFact>[];
  inScope?: (k: string | null) => boolean;
};
function ctxOf(s: Setup) {
  const lessons = s.lessons ?? [];
  const asked: string[] = [];
  const ctx = fakeContext({
    now: NOW,
    entries: s.entries ?? [],
    signals: s.sig,
    inScope: s.inScope,
    store: {
      knowledge: {
        listLessons: async (f: { flag?: string }) => lessons.filter((l) => (l.checks ?? []).some((c) => c.name === f.flag)),
        lessonDetail: async (id: string) => {
          const l = lessons.find((x) => x.id === id);
          return l ? ({ lesson: l, miss: s.missed === null ? null : { id: l.missId, missed: s.missed ?? 'kept dollars as floats' } } as unknown as LessonDetail) : null;
        },
      },
      decisions: {
        forTarget: async (id: string) => (s.decided ?? []).filter((d) => d.targets.some((t) => t.id === id)),
        notes: async (id: string) => (s.notes?.[id] ?? []).map((n, i) => ({ id: `dnote:${id}:${i}`, decisionId: id, ts: '2026-11-01T00:00:00Z', by: 'you', verdict: null, reason: null, text: '', ...n })) as DecisionNote[],
      },
      activity: {
        list: async (q: { kind?: string }) => { asked.push(q.kind ?? ''); return (s.history ?? []).filter((e) => e.kind === q.kind); },
      },
      facts: {
        listFacts: async (q: { origin?: string }) => (s.facts ?? []).filter((f) => f.origin === q.origin) as StoredFact[],
      },
    },
  });
  return { ...ctx, asked };
}

describe('recordFact: a lesson that states a fact', () => {
  test('a proposed lesson flagged looks-like-a-fact becomes the loop\'s fact, as the Lessons page converts it, and is rejected', async () => {
    const l = lesson('lesson:a');
    const r = await recordFact.candidates(ctxOf({ lessons: [l], sig: { 'lesson:a': signals('lesson:a', { served: 5 }) } }));
    expect(r).toMatchObject({ scanned: 1, skipped: {} });
    const [c] = r.candidates;
    const id = plannedFactId(`lesson|lesson:a|${lessonFingerprint(l)}`);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(c.targets).toEqual([{ kind: 'lesson', id: 'lesson:a', role: 'primary' }, { kind: 'fact', id, role: 'created' }]);
    expect(c.before).toEqual([lessonSnapshot(l), { kind: 'fact', id, fields: {}, fingerprint: ABSENT }]);
    expect(c.after).toEqual([
      lessonSnapshot({ ...l, status: 'rejected', decidedAt: new Date(NOW).toISOString(), decidedBy: LOOP_ACTOR, decisionNote: 'converted to a fact' }),
      factSnapshot({ id, projectKey: 'demo', kind: 'convention', statement: l.rule, path: 'src/money.ts', lines: null, why: 'From the lesson "Cents": kept dollars as floats', relevance: 0.8, relevanceBy: LOOP_ACTOR, current: true }),
    ]);
    expect(c.features).toEqual({ factLike: 1, modelSaid: 0, standing: 0, approved: 0, served: 0.25 });
    expect(c.evidence.map((e) => e.role)).toEqual(['check looks-like-a-fact']);
    expect(c.proposeOnly).toBeUndefined();
    expect(c.subject).toBe('lesson "Cents" becomes a convention fact');
  });

  test('the model said so too, the lesson is approved and global with an origin, no miss: features and why follow', async () => {
    const l = lesson('lesson:g', { status: 'approved', projectKey: null, origin: 'demo', scope: 'global', checks: [{ name: 'looks-like-a-fact', why: MODEL_FACT_WHY }] });
    const [c] = (await recordFact.candidates(ctxOf({ lessons: [l], missed: null }))).candidates;
    expect(c.features).toMatchObject({ modelSaid: 1, approved: 1 });
    expect(c.after[1].fields).toMatchObject({ projectKey: 'demo', why: 'From the lesson "Cents"' });
    expect(c.rationale).toContain('the post-mortem model said so too');
    const proposed = (await recordFact.candidates(ctxOf({ lessons: [lesson('lesson:a')] }))).candidates[0];
    expect(score(recordFact, c.features)).toBeGreaterThan(score(recordFact, { ...proposed.features, modelSaid: 0, approved: 1 }));
  });

  test('floors and never-target rules: a rule that no longer states a fact, no project, decided lessons, manual, other projects, decided on this text', async () => {
    const l = lesson('lesson:a');
    const on = (fp: string, type = 'record_fact') => ({ type, targets: [{ kind: 'lesson', id: 'lesson:a', role: 'primary' }], before: [{ kind: 'lesson', id: 'lesson:a', fields: {}, fingerprint: fp }] }) as unknown as Decision;
    const r = await recordFact.candidates(ctxOf({
      lessons: [
        lesson('lesson:imp', { rule: 'Store amounts in cents in src/money.ts' }),
        lesson('lesson:none', { projectKey: null, origin: null }),
        lesson('lesson:rej', { status: 'rejected' }),
        lesson('lesson:man', { source: 'manual' }),
        lesson('lesson:oth', { projectKey: 'other' }),
        l,
      ],
      inScope: (k) => k !== 'other',
      decided: [on(lessonFingerprint(l))],
    }));
    expect(r).toEqual({ candidates: [], scanned: 5, skipped: { below_floor: 2, never_target: 1, out_of_scope: 1, already_decided: 1 } });
    // A decision on older text, or another type's, does not count.
    expect((await recordFact.candidates(ctxOf({ lessons: [l], decided: [on('older'), on(lessonFingerprint(l), 'reword_lesson')] }))).candidates).toHaveLength(1);
  });

  test('an approved rule written as an imperative is never turned into a fact, whoever flagged it', async () => {
    const flagged = [{ name: 'looks-like-a-fact' as const, why: MODEL_FACT_WHY }];
    const r = await recordFact.candidates(ctxOf({ lessons: [
      lesson('lesson:a', { status: 'approved', checks: flagged, rule: 'Amounts are stored in integer cents in src/money.ts. Don\u2019t use floats for them.' }),
      lesson('lesson:b', { status: 'approved', checks: flagged, rule: 'Amounts are stored in cents, so you must never divide them before display.' }),
      lesson('lesson:c', { status: 'approved', checks: flagged, rule: 'Always remember that amounts in src/money.ts are integer cents.' }),
    ] }));
    expect(r.candidates.map((c) => c.targets[0].id)).toEqual(['lesson:c']);
    expect(r.skipped).toEqual({ below_floor: 2 });
  });

  test('the owner touched it in the last 14 days: proposed at most', async () => {
    const [c] = (await recordFact.candidates(ctxOf({ lessons: [lesson('lesson:a')], sig: { 'lesson:a': signals('lesson:a', {}, '2026-11-08T00:00:00Z') } }))).candidates;
    expect(c.proposeOnly).toMatch(/last 14 days/);
  });
});

describe('recordFact: a standing fact from what the owner said more than once', () => {
  const noted = (decisionId: string, o: Partial<Activity> = {}) => activity('decision_noted', { actor: 'you', details: { decisionId }, targets: [decisionId], ...o });
  const edited = (lessonId: string, rule: string, o: Partial<Activity> = {}) => activity('lesson_decided', { actor: 'you', details: { changed: { rule: { from: 'x', to: rule } } }, targets: [lessonId], ...o });
  const SAID = 'Orders are stored in integer cents in the orders table.';

  test('a new note saying what an earlier edit said: one proposal, the loop\'s fact under the project, the evidence both entries', async () => {
    const now = noted('dec:1');
    const before = edited('lesson:x', SAID);
    const ctx = ctxOf({ entries: [now], history: [before, now], notes: { 'dec:1': [{ text: `Wrong evidence. ${SAID.replace('Orders', 'All orders')}` }] } });
    const r = await recordFact.candidates(ctx);
    expect(r.skipped).toEqual({});
    const [c] = r.candidates;
    expect(c.targets).toEqual([{ kind: 'fact', id: expect.any(String), role: 'created' }]);
    expect(c.before[0].fingerprint).toBe(ABSENT);
    expect(c.after[0].fields).toMatchObject({ projectKey: 'demo', kind: 'convention', statement: SAID.replace('Orders', 'All orders'), path: '.', relevance: 0.8, relevanceBy: LOOP_ACTOR, current: true });
    expect(c.after[0].fields.why).toBe('You said this 2 times: in a note on a loop decision; editing lesson:x');
    expect(c.evidence.map((e) => [e.id, e.role])).toEqual([[now.id, 'owner note'], [before.id, 'owner edit']]);
    expect(c.features).toMatchObject({ standing: 0.5, factLike: 1 });
    expect(c.proposeOnly).toMatch(/your words/);
    expect(ctx.asked).toEqual(['decision_noted', 'lesson_decided']);
  });

  test('no new owner statement this round: nothing is read; once, an operator, or other projects: no call', async () => {
    const quiet = ctxOf({ entries: [activity('context_served')] });
    expect(await recordFact.candidates(quiet)).toEqual({ candidates: [], scanned: 0, skipped: {} });
    expect(quiet.asked).toEqual([]);
    // Said once (the same lesson edited twice counts once).
    const once = edited('lesson:x', SAID);
    expect((await recordFact.candidates(ctxOf({ entries: [once], history: [once, edited('lesson:x', SAID)] }))).skipped).toEqual({ below_floor: 1 });
    // An operator's edit is not the owner's.
    expect((await recordFact.candidates(ctxOf({ entries: [edited('lesson:y', SAID, { actor: 'operator:codex' })], history: [once] }))).scanned).toBe(0);
    // Another project's.
    const other = edited('lesson:z', SAID, { projectKey: 'other' });
    expect((await recordFact.candidates(ctxOf({ entries: [other], history: [once, other] }))).skipped).toEqual({ below_floor: 1 });
    expect((await recordFact.candidates(ctxOf({ entries: [other], history: [once, other, edited('lesson:w', SAID, { projectKey: 'other' })], inScope: (k) => k !== 'other' }))).skipped).toEqual({ out_of_scope: 1 });
  });

  test('a rule the owner edited that says what to do is not a statement, though a sentence of it states a fact', async () => {
    const now = noted('dec:1');
    const rules = [`Use the money helpers. ${SAID}`, `${SAID} Never write floats there.`, `${SAID.slice(0, -1)}, so callers must round first.`];
    for (const rule of rules) {
      const before = edited('lesson:x', rule);
      const r = await recordFact.candidates(ctxOf({ entries: [now], history: [before, now], notes: { 'dec:1': [{ text: SAID }] } }));
      expect(r.candidates, rule).toEqual([]);
    }
  });

  test('instructions, short or wordless sentences, and notes by someone else are not statements', async () => {
    const e = noted('dec:1');
    const r = await recordFact.candidates(ctxOf({
      entries: [e, edited('lesson:a', 'Store amounts in cents in src/money.ts'), edited('lesson:b', 'It is.'), activity('lesson_decided', { actor: 'you', details: { changed: {} }, targets: ['lesson:c'] }), noted('dec:np', { projectKey: null })],
      history: [e],
      notes: { 'dec:1': [{ text: SAID, by: 'operator:codex' }, { text: 'Is ok and are fine' }] },
    }));
    expect(r).toEqual({ candidates: [], scanned: 0, skipped: {} });
  });

  test('already a fact (yours or the loop\'s), already decided, or twice in one round: no new call', async () => {
    const a = edited('lesson:a', SAID);
    const b = edited('lesson:b', SAID);
    const twice = await recordFact.candidates(ctxOf({ entries: [a, b], history: [a, b] }));
    expect(twice.candidates).toHaveLength(1);
    expect(twice.skipped).toEqual({ already_decided: 1 });
    const id = twice.candidates[0].targets[0].id;
    expect((await recordFact.candidates(ctxOf({ entries: [a], history: [a, b], decided: [{ targets: [{ kind: 'fact', id }] } as unknown as Decision] }))).skipped).toEqual({ already_decided: 1 });
    expect((await recordFact.candidates(ctxOf({ entries: [a], history: [a, b], facts: [{ origin: 'you', statement: 'Orders are stored in integer cents in the orders table' }] }))).skipped).toEqual({ already_a_fact: 1 });
    expect((await recordFact.candidates(ctxOf({ entries: [a], history: [a, b], facts: [{ origin: 'loop', statement: SAID }] }))).skipped).toEqual({ already_a_fact: 1 });
    expect((await recordFact.candidates(ctxOf({ entries: [a], history: [a, b], facts: [{ origin: 'loop', statement: 'Payments retry twice' }] }))).candidates).toHaveLength(1);
  });

  test('recheck: an observed conversion or standing fact keeps its call while its floors hold; else it no longer holds', async () => {
    const l = lesson('lesson:a');
    const [conversion] = (await recordFact.candidates(ctxOf({ lessons: [l] }))).candidates;
    const now = noted('dec:1');
    const [standing] = (await recordFact.candidates(ctxOf({ entries: [now], history: [edited('lesson:x', SAID), now], notes: { 'dec:1': [{ text: SAID.replace('Orders', 'All orders') }] } }))).candidates;
    const observed = [observedAs('record_fact', conversion), observedAs('record_fact', standing)];
    const again = await recordFact.recheck!(ctxOf({ lessons: [l], decided: observed }), observed);
    expect(again[0]).toMatchObject({ targets: conversion.targets, before: conversion.before, after: conversion.after });
    expect(again[1]).toMatchObject({ targets: standing.targets, after: standing.after, proposeOnly: expect.stringMatching(/your words/) });
    const fact = { origin: 'you', statement: SAID } as Partial<StoredFact>;
    expect(await recordFact.recheck!(ctxOf({ lessons: [lesson('lesson:a', { checks: [] })], facts: [fact] }), observed)).toEqual(['no_longer_holds', 'already_a_fact']);
    expect(await recordFact.recheck!(ctxOf({ lessons: [l], inScope: () => false }), observed)).toEqual(['out_of_scope', 'out_of_scope']);
  });

  test('a note read once even when two entries name its decision', async () => {
    const n1 = noted('dec:1');
    const n2 = noted('dec:1');
    const r = await recordFact.candidates(ctxOf({ entries: [n1, n2], history: [n1, n2], notes: { 'dec:1': [{ text: SAID }] } }));
    expect(r).toEqual({ candidates: [], scanned: 1, skipped: { below_floor: 1 } });
  });

  test('words and overlap', () => {
    expect([...words('The Orders are stored in src/money.ts, always.')]).toEqual(['orders', 'stored', 'src/money.ts']);
    expect(overlap(words('orders stored cents'), words('orders stored cents table'))).toBe(0.75);
    expect(overlap(new Set(), new Set())).toBe(0);
    expect(SAME_STATEMENT).toBeLessThan(0.75);
  });
});
