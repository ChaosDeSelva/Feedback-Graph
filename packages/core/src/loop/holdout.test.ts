import { expect, test } from 'vitest';
import type { LessonSignalsRow } from '../store.ts';
import { LESSON_SIGNAL_COUNTS, type LessonSignalCount } from '../types.ts';
import { holdoutEligible, holdoutReport, holdoutWire, inHoldout, lessonHeldOut, loopHoldout, proportion, readHoldout, wilson } from './holdout.ts';

const counts = (c: Partial<Record<LessonSignalCount, number>> = {}) =>
  ({ ...Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, 0])), ...c }) as Record<LessonSignalCount, number>;
const row = (lessonId: string, c: Partial<Record<LessonSignalCount, number>>, o: Partial<LessonSignalsRow> = {}): LessonSignalsRow => ({
  lessonId, counts: counts(c), lastServed: null, lastOwnerTouch: null, updatedAt: '', projectKey: 'p', source: 'postmortem', status: 'approved', run: null, sandbox: false, ...o,
});
/** The first n lesson ids that are (or are not) in a 0.2 holdout. */
const ids = (held: boolean, n: number) => {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (inHoldout(`lesson:${i}`, 0.2) === held) out.push(`lesson:${i}`);
  return out;
};

test('wilson: the textbook interval, [0, 1] with no trials, and it narrows as n grows', () => {
  const w = wilson(5, 10);
  expect(w.lower).toBeCloseTo(0.2366, 4);
  expect(w.upper).toBeCloseTo(0.7634, 4);
  expect(wilson(0, 0)).toEqual({ lower: 0, upper: 1 });
  expect(wilson(0, 5).lower).toBe(0);
  expect(wilson(5, 5).upper).toBe(1);
  expect(wilson(80, 100).upper - wilson(80, 100).lower).toBeLessThan(wilson(4, 5).upper - wilson(4, 5).lower);
  expect(proportion(0, 0)).toEqual({ k: 0, n: 0, rate: 0, ciLow: 0, ciHigh: 1 });
  expect(proportion(1, 4)).toMatchObject({ k: 1, n: 4, rate: 0.25 });
});

test('inHoldout: a fixed hash, about the share asked, and raising the share only adds lessons', () => {
  const all = Array.from({ length: 10_000 }, (_, i) => `lesson:${i}`);
  const held = all.filter((id) => inHoldout(id, 0.2));
  expect(held.length / all.length).toBeGreaterThan(0.18);
  expect(held.length / all.length).toBeLessThan(0.22);
  expect(all.filter((id) => inHoldout(id, 0.2))).toEqual(held);
  for (const id of all.filter((x) => inHoldout(x, 0.1))) expect(inHoldout(id, 0.2)).toBe(true);
  expect(all.some((id) => inHoldout(id, 0))).toBe(false);
});

test('holdoutEligible: never your lessons, the demo or a run', () => {
  expect(holdoutEligible(row('l', {}))).toBe(true);
  expect(holdoutEligible(row('l', {}, { source: 'memory' }))).toBe(true);
  expect(holdoutEligible(row('l', {}, { source: 'manual' }))).toBe(false);
  expect(holdoutEligible(row('l', {}, { source: 'demo' }))).toBe(false);
  expect(holdoutEligible(row('l', {}, { run: 'r1' }))).toBe(false);
  expect(holdoutEligible(row('l', {}, { sandbox: true }))).toBe(false);
  // A lesson as the stores return it (run and sandbox absent unless set).
  const [held] = ids(true, 1);
  const [free] = ids(false, 1);
  expect(lessonHeldOut({ id: held, source: 'postmortem' }, 0.2)).toBe(true);
  expect(lessonHeldOut({ id: held, source: 'manual' }, 0.2)).toBe(false);
  expect(lessonHeldOut({ id: held, source: 'postmortem', sandbox: true }, 0.2)).toBe(false);
  expect(lessonHeldOut({ id: free, source: 'postmortem' }, 0.2)).toBe(false);
  expect(lessonHeldOut({ id: held, source: 'postmortem' }, 0)).toBe(false);
});

test('holdoutReport compares the served eligible lessons on each side of the hash', () => {
  const [c1, c2] = ids(true, 2);
  const [t1, t2, t3, t4] = ids(false, 4);
  const rows = [
    row(c1, { served: 10, addressed: 1, notApplicable: 3, cannotTell: 1, repeatServed: 1 }),
    row(c2, { served: 5, notAddressed: 1, gapsFixed: 1 }),
    row(t1, { served: 10, addressed: 4, notAddressed: 2, gapsFixed: 2, notApplicable: 1 }),
    row(t2, { served: 6, addressed: 1, repeatUnserved: 1 }),
    // Not counted: never served, yours, a run's.
    row(t3, { addressed: 9 }),
    row(t4, { served: 9, addressed: 9 }, { source: 'manual' }),
    row('lesson:run', { served: 9, notApplicable: 9 }, { run: 'r' }),
  ];
  const r = holdoutReport(rows, 0.2)!;
  expect(r.share).toBe(0.2);
  expect(r.control).toMatchObject({
    lessons: 2, served: 15,
    repeat: { k: 1, n: 2, rate: 0.5 },
    helpful: { k: 2, n: 5, rate: 0.4 },
    gapsFixed: { k: 1, n: 15 },
    notApplicable: { k: 4, n: 6 },
  });
  expect(r.treated).toMatchObject({
    lessons: 2, served: 16,
    repeat: { k: 1, n: 2 },
    helpful: { k: 7, n: 8 },
    gapsFixed: { k: 2, n: 16 },
    notApplicable: { k: 1, n: 8 },
  });
  expect(r.treated.helpful.ciLow).toBeCloseTo(wilson(7, 8).lower, 10);

  expect(holdoutWire(r)).toEqual({
    share: 0.2,
    treated: { lessons: 2, repeatRate: 0.5, helpfulRate: 7 / 8, ciLow: r.treated.helpful.ciLow, ciHigh: r.treated.helpful.ciHigh },
    control: { lessons: 2, repeatRate: 0.5, helpfulRate: 0.4, ciLow: r.control.helpful.ciLow, ciHigh: r.control.helpful.ciHigh },
  });
});

test('no comparison without a holdout or without a served lesson on both sides', async () => {
  const [c] = ids(true, 1);
  const [t] = ids(false, 1);
  expect(holdoutReport([row(c, { served: 1 }), row(t, { served: 1 })], 0)).toBeNull();
  expect(holdoutReport([row(c, { served: 1 })], 0.2)).toBeNull();
  expect(holdoutReport([row(t, { served: 1 }), row(c, { served: 0 })], 0.2)).toBeNull();
  expect(holdoutWire(null)).toBeNull();

  const seen: unknown[] = [];
  const d = { listSignals: async (f?: { projectKeys?: string[] }) => { seen.push(f); return [row(c, { served: 1 }), row(t, { served: 2, addressed: 1 })]; } };
  expect(await readHoldout(d, 0)).toBeNull();
  expect(seen).toEqual([]);
  expect(await loopHoldout(d, 0.2, { projectKeys: ['p'] })).toMatchObject({ share: 0.2, treated: { lessons: 1, helpfulRate: 1 }, control: { lessons: 1, helpfulRate: 0 } });
  expect(seen).toEqual([{ projectKeys: ['p'] }]);

  // A per-project check: the hidden project's lessons leave the comparison, global ones stay.
  const scoped = { listSignals: async () => [row(c, { served: 1 }, { projectKey: 'hidden' }), row(t, { served: 2 }), row(c, { served: 3, addressed: 1 }, { projectKey: null })] };
  const r = await readHoldout(scoped, 0.2, { shows: async (k) => k !== 'hidden' });
  expect(r?.control).toMatchObject({ lessons: 1, served: 3 });
  expect(await readHoldout(scoped, 0.2)).toMatchObject({ control: { lessons: 2, served: 4 } });
});
