import { expect, test } from 'vitest';
import type { PatternReport } from '../graph/insights.ts';
import type { LessonSignalsRow } from '../store.ts';
import type { DecisionCount, DecisionCountFilter, DecisionCountKey } from '../decisions/record.ts';
import { LESSON_SIGNAL_COUNTS, type LessonSignalCount } from '../types.ts';
import { loopMetrics, readLoopMetrics } from './metrics.ts';

// 2026-11-11 is a Wednesday of ISO week 46.
const NOW = Date.parse('2026-11-11T12:00:00Z');
const counts = (c: Partial<Record<LessonSignalCount, number>>) =>
  ({ ...Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, 0])), ...c }) as Record<LessonSignalCount, number>;
const row = (lessonId: string, c: Partial<Record<LessonSignalCount, number>>, o: Partial<LessonSignalsRow> = {}): LessonSignalsRow => ({
  lessonId, counts: counts(c), lastServed: null, lastOwnerTouch: null, updatedAt: '', projectKey: 'p', source: 'postmortem', status: 'approved', run: null, sandbox: false, ...o,
});
const patterns = (o: Partial<PatternReport> = {}): PatternReport => ({
  causes: [], repeatGroups: [], preDone: { checks: 10, withGaps: 3, gapsFound: 5 },
  weekly: [{ week: '2026-W30', feedback: 50, repeats: 40 }, { week: '2026-W44', feedback: 6, repeats: 2 }, { week: '2026-W46', feedback: 4, repeats: 1 }],
  ...o,
});

test('loopMetrics: repeat rate in the window, checks that caught a gap, gaps fixed per serving, noise, proposals per week, rollbacks per type', () => {
  const m = loopMetrics({
    now: NOW, weeks: 3,
    patterns: patterns(),
    signals: [
      row('lesson:a', { served: 10, gapsFixed: 2, addressed: 3, notApplicable: 2, cannotTell: 1 }),
      row('lesson:b', { served: 5, notAddressed: 1, gapsFixed: 1, notApplicable: 1 }),
      row('lesson:mine', { served: 100, notApplicable: 100 }, { source: 'manual' }),
    ],
    // As DecisionsStore.count groups them: proposals by the week made (one outside the window), applied by type and status.
    proposals: [{ createdWeek: '2026-W45', n: 1 }, { createdWeek: '2026-W46', n: 1 }, { createdWeek: '2026-W40', n: 1 }],
    applied: [{ type: 'link_misses', status: 'rolled_back', n: 1 }, { type: 'link_misses', status: 'applied', n: 1 }, { type: 'retire_lesson', status: 'applied', n: 1 }],
  });
  expect(m.since).toBe('2026-W44');
  expect(m.weeks).toBe(3);
  expect(m.repeatRate).toMatchObject({ k: 3, n: 10, rate: 0.3, weekly: [{ week: '2026-W44', feedback: 6, repeats: 2 }, { week: '2026-W46', feedback: 4, repeats: 1 }] });
  expect(m.checksCaughtGap).toMatchObject({ k: 3, n: 10, rate: 0.3 });
  expect(m.gapsFixedPerServed).toMatchObject({ k: 3, n: 15, rate: 0.2 });
  expect(m.notApplicableShare).toMatchObject({ k: 4, n: 8, rate: 0.5 });
  expect(m.proposalsPerWeek).toEqual([{ week: '2026-W44', proposals: 0 }, { week: '2026-W45', proposals: 1 }, { week: '2026-W46', proposals: 1 }]);
  expect(m.rollbackRate.find((r) => r.type === 'link_misses')).toMatchObject({ rolledBack: 1, of: 2, rate: { rate: 0.5 } });
  expect(m.rollbackRate.find((r) => r.type === 'retire_lesson')).toMatchObject({ rolledBack: 0, of: 1 });
  expect(m.rollbackRate.find((r) => r.type === 'approve_lesson')).toMatchObject({ rolledBack: 0, of: 0, rate: { rate: 0, ciLow: 0, ciHigh: 1 } });
});

test('readLoopMetrics counts the window in the store, for the projects a viewer may see', async () => {
  const seen: Record<string, unknown>[] = [];
  const s = {
    insights: { patterns: async (q: unknown) => { seen.push({ patterns: q }); return patterns({ weekly: [] }); } },
    decisions: {
      listSignals: async (q?: unknown) => { seen.push({ signals: q }); return [row('lesson:a', { served: 4, gapsFixed: 1 })]; },
      count: async (f: DecisionCountFilter, by: readonly DecisionCountKey[]): Promise<DecisionCount[]> => {
        seen.push({ count: f, by });
        return by.includes('createdWeek') ? [{ createdWeek: '2026-W46', n: 2 }] : [{ type: 'link_misses', status: 'rolled_back', n: 1 }, { type: 'link_misses', status: 'applied', n: 3 }];
      },
    },
  };
  const m = await readLoopMetrics(s, { now: NOW, projectKeys: ['p'] });
  expect(m.weeks).toBe(8);
  expect(m.proposalsPerWeek.reduce((a, w) => a + w.proposals, 0)).toBe(2);
  expect(m.rollbackRate.find((r) => r.type === 'link_misses')).toMatchObject({ rolledBack: 1, of: 4 });
  expect(m.repeatRate).toMatchObject({ k: 0, n: 0 });
  expect(m.gapsFixedPerServed).toMatchObject({ k: 1, n: 4 });
  // Made in the window and a week before it; applied from the Monday its first week (2026-W39) starts.
  expect(seen).toEqual([
    { patterns: { projectKeys: ['p'] } }, { signals: { projectKeys: ['p'] } },
    { count: { since: '2026-09-09T12:00:00.000Z', projectKeys: ['p'], mode: 'propose', author: 'loop' }, by: ['createdWeek'] },
    { count: { since: '2026-09-09T12:00:00.000Z', projectKeys: ['p'], appliedSince: '2026-09-21T00:00:00.000Z', author: 'loop' }, by: ['type', 'status'] },
  ]);
  seen.length = 0;
  await readLoopMetrics(s, { now: NOW, weeks: 2 });
  expect(seen[0]).toEqual({ patterns: {} });
  expect(seen[2]).toEqual({ count: { since: '2026-10-21T12:00:00.000Z', mode: 'propose', author: 'loop' }, by: ['createdWeek'] });
});
