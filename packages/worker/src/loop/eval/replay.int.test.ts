import { beforeAll, expect, test } from 'vitest';
import type { Lesson, Store, TargetSnapshot } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import type { LoopCandidate, LoopType } from '../plugin.ts';
import { linkMisses } from '../types/link_misses.ts';
import { seedReplayDemo } from './demo.ts';
import { readLog, runReplay } from './index.ts';
import { NO_SPLIT } from './score.ts';

const snap = (l: Lesson, status: string): TargetSnapshot => ({ kind: 'lesson', id: l.id, fields: { status }, fingerprint: status });

/** A type that would approve every lesson proposed at the cut, and one that would confirm every pending Inbox item. */
const approveAll: LoopType = {
  type: 'approve_lesson', weights: { bias: 0 },
  async candidates(ctx) {
    const proposed = await ctx.store.knowledge.listLessons({ status: 'proposed' });
    return {
      scanned: proposed.length, skipped: {},
      candidates: proposed.map((l): LoopCandidate => ({
        projectKey: l.projectKey, targets: [{ kind: 'lesson', id: l.id, role: 'primary' }], before: [snap(l, l.status)], after: [snap(l, 'approved')],
        evidence: [{ kind: 'lesson', id: l.id, role: 'proposed', weight: 1, observedAt: l.createdAt }], features: {}, subject: l.title, rationale: 'all of them',
      })),
    };
  },
};
const confirmAll: LoopType = {
  type: 'triage_inbox', weights: { bias: 0 },
  async candidates(ctx) {
    const pending = await ctx.store.graph.listCandidates({ status: 'pending' });
    return {
      scanned: pending.length, skipped: {},
      candidates: pending.map((c): LoopCandidate => ({
        projectKey: c.projectKey, targets: [{ kind: 'candidate', id: c.id, role: 'primary' }], before: [],
        after: [{ kind: 'candidate', id: c.id, fields: { status: 'confirmed' }, fingerprint: 'f' }],
        evidence: [{ kind: 'candidate', id: c.id, role: 'pending', weight: 1, observedAt: c.createdAt }], features: {}, subject: c.id, rationale: 'all of them',
      })),
    };
  },
};

describeStores('learning loop replay', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  test('the loop at the cut sees the store as it was then; its calls are scored against what the owner did after; nothing is written', async () => {
    const { t0, project } = await seedReplayDemo(store);
    const logBefore = (await readLog(store.activity)).length;
    const { cuts, report } = await runReplay({ store, types: [linkMisses, approveAll, confirmAll] }, { cuts: [t0], horizonMs: null, split: { projects: [project], months: [] } });
    const [cut] = cuts;

    // At the cut: the lessons approved, rejected and edited after it were still proposed; the late miss did not exist.
    const approve = cut.decisions.filter((d) => d.decision.type === 'approve_lesson');
    expect(approve.map((d) => [d.decision.targets[0].id, d.verdict]).sort()).toEqual([
      ['lesson:rd-2-t1', 'unlabelled'], ['lesson:rd-3-t1', 'agree'], ['lesson:rd-4-t1', 'agree'], ['lesson:rd-5-t1', 'contradict'],
    ]);
    expect(cut.decisions.find((d) => d.decision.type === 'triage_inbox')).toMatchObject({ verdict: 'agree' });
    const links = cut.decisions.filter((d) => d.decision.type === 'link_misses');
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((d) => d.verdict === 'unlabelled' && !JSON.stringify(d.decision.targets).includes('rd-6'))).toBe(true);
    expect(cut.decisions.every((d) => d.heldOut && d.decision.status === 'observed')).toBe(true);

    // The owner's later actions: two approvals and a rejection (all the loop's calls), the edit, the Inbox decision.
    expect(cut.actions.map((a) => [a.action.kind, a.caught]).sort()).toEqual([
      ['approved', true], ['approved', true], ['edited_text', false], ['inbox_confirmed', true], ['rejected', false],
    ]);
    expect(report.tuning).toEqual([]);
    expect(report.heldOut.find((s) => s.type === 'approve_lesson')).toMatchObject({ decisions: 4, agree: 2, contradict: 1, unlabelled: 1, precision: { k: 2, n: 3 }, recall: { k: 2, n: 2 } });

    // The restored store is only read.
    expect(await store.decisions.list({})).toEqual([]);
    expect((await readLog(store.activity)).length).toBe(logBefore);
    expect((await store.knowledge.lessonDetail('lesson:rd-3-t1'))?.lesson.status).toBe('approved');
  });
});
