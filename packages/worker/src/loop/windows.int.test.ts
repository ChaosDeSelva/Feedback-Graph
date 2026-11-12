import { beforeAll, expect, test } from 'vitest';
import { decisionExecutor, lessonSnapshot, missLinkSnapshot, type Decision, type Lesson, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { LABEL_WINDOW_DAYS, labelUntouched } from './calibrate.ts';
import { checkBreaker } from './engine.ts';

const T0 = '2026-11-01T00:00:00.000Z';

/** The loop's reads over many decisions of one type, on each backend: none may look only at the newest page. */
describeStores('learning loop windows over many decisions', (h) => {
  let s: Store;
  beforeAll(() => { s = h.store; });

  /** n link_misses decisions the loop applied, oldest first. */
  async function appliedLinks(n: number, tag: string): Promise<Decision[]> {
    const out: Decision[] = [];
    for (let i = 0; i < n; i++) {
      const from = `miss:${tag}f${i}`, to = `miss:${tag}t${i}`;
      const { decision } = await s.decisions.propose({
        type: 'link_misses', projectKey: 'demo', targets: [{ kind: 'miss', id: from, role: 'primary' }, { kind: 'miss', id: to, role: 'keeper' }],
        before: [missLinkSnapshot(from, to, false)], after: [missLinkSnapshot(from, to, true)], evidence: [{ kind: 'miss', id: to, role: 'repeat of', weight: 1, observedAt: T0 }],
        features: {}, score: 0.9, confidence: { p: 0.8, lower: 0.56, n: 0, band: 4 }, tier: 'H', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
      });
      await s.decisions.markApplying(decision.id);
      await s.decisions.markApplied(decision.id, decision.after);
      await s.decisions.markStatus(decision.id, { status: 'applied', from: ['applied'], by: 'loop:1' });
      out.push(decision);
      await new Promise((r) => setTimeout(r, 2));
    }
    return out;
  }
  const rollBack = (d: Decision) => s.decisions.markStatus(d.id, { status: 'rolled_back', from: ['applied'], by: 'you', rollback: { at: new Date().toISOString(), by: 'you', reason: null, note: null, cascade: [] } });

  test('the breaker counts rollbacks made in its window whenever their decisions were made: three of a type\'s oldest trip it', async () => {
    const ds = await appliedLinks(55, 'b');
    for (const d of ds.slice(0, 3)) await rollBack(d);
    const b = await checkBreaker({ store: s, cursors: s.docs } as never, 'link_misses', Date.now());
    expect(b).toMatchObject({ tripped: true, reason: '3 rollbacks in 7 days' });
  }, 120_000);

  test('labelUntouched reads every applied auto decision, not only the newest page: all 505 are labelled kept in one pass', async () => {
    const ds = await appliedLinks(505, 'k');
    const label = () => labelUntouched({ decisions: s.decisions, activity: s.activity, signals: async () => null, changed: async () => null, now: Date.now() + 15 * 86_400_000 });
    expect(await label()).toEqual({ kept: 505, overridden: 0 });
    // Each is marked labelled in the store, so the next pass reads none of them.
    expect(await s.decisions.list({ unlabelled: true, limit: 1000 })).not.toContainEqual(expect.objectContaining({ id: ds[0].id }));
    expect(await label()).toEqual({ kept: 0, overridden: 0 });
  }, 300_000);

  test('a lesson the decision made unservable needs no serving to be kept; one never served leaves the list, unlabelled, after its window', async () => {
    const day = 86_400_000;
    const x = decisionExecutor(s);
    const vec = Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0));
    const applied: Record<string, string> = {};
    for (const [type, approved, after] of [
      ['reject_lesson', false, { status: 'rejected' }], ['retire_lesson', true, { status: 'revoked' }], ['rank_weight', true, { servingWeight: 0.9 }],
    ] as const) {
      const id = `lesson:un-${type}`;
      await s.knowledge.upsertLesson({ id, projectKey: 'demo', title: 't', rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['src/a.ts'], status: 'proposed', source: 'postmortem', embedding: vec });
      if (approved) await s.knowledge.updateLesson(id, { status: 'approved' }, { by: 'you' });
      const l = (await s.knowledge.lessonDetail(id))!.lesson;
      const left: Lesson = { ...l, ...after, ...('status' in after && { decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'by the loop' }) };
      const { decision } = await s.decisions.propose({
        type, projectKey: 'demo', targets: [{ kind: 'lesson', id, role: 'primary' }], before: [lessonSnapshot(l)], after: [lessonSnapshot(left)],
        evidence: [{ kind: 'lesson', id, role: 'e', weight: 1, observedAt: T0 }], features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 10, band: 4 },
        tier: type === 'reject_lesson' ? 'A' : 'H', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
      });
      await x.apply(decision, { by: 'loop:1' });
      applied[type] = decision.id;
    }
    const ours = new Set(Object.values(applied));
    const checked: string[] = [];
    // Nothing served: the rank_weight lesson (approved, so servable) waits; the rejected and revoked ones are kept.
    const label = (days: number) => labelUntouched({
      decisions: s.decisions, activity: s.activity, now: Date.now() + days * day, signals: async () => null,
      changed: (d) => { if (ours.has(d.id)) checked.push(d.type); return x.changed(d); },
    });
    await label(20);
    expect(checked.toSorted()).toEqual(['rank_weight', 'reject_lesson', 'retire_lesson']);
    const waiting = async () => (await s.decisions.list({ status: ['applied'], mode: 'auto', unlabelled: true, limit: 1000 })).filter((d) => ours.has(d.id)).map((d) => d.type);
    expect(await waiting()).toEqual(['rank_weight']);
    checked.length = 0;
    await label(20);
    expect(checked).toEqual(['rank_weight']);
    // Past its window: checked once more, then never again, with no label counted.
    checked.length = 0;
    expect(await label(LABEL_WINDOW_DAYS + 1)).toMatchObject({ overridden: 0 });
    expect(checked).toEqual(['rank_weight']);
    expect(await waiting()).toEqual([]);
    checked.length = 0;
    await label(LABEL_WINDOW_DAYS + 2);
    expect(checked).toEqual([]);
    expect((await s.decisions.get(applied.rank_weight))!.status).toBe('applied');
  }, 120_000);
});
