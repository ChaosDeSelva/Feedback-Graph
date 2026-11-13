import { LOOP_POLICY_VERSION, LOOP_TYPE_INFO, lessonSnapshot, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { createApp } from './app.ts';

/** The approve score over a real store, on each backend: the calls and calibration it reads, and sort=score. */
const OWNER = 'score-int-owner-token-0123456789abcdef';
const T0 = '2026-11-01T00:00:00.000Z';
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));

describeStores('approve score api', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });
  const app = () => createApp(store.graph, {
    auth: { ownerToken: OWNER },
    knowledge: store.knowledge,
    loop: {
      decisions: store.decisions, cursors: store.docs, activity: store.activity, lessonDetail: (id) => store.knowledge.lessonDetail(id),
      config: { mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0.2, types: null },
    },
    intakeReview: { intake: store.intake, facts: store.facts, embed: async (t) => t.map(() => vec(2)), activity: store.activity },
  });
  const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' };
  const get = async (a: ReturnType<typeof app>, path: string) => (await a.request(path, { headers: owner })).json();

  test('lessons and decisions: a calibrated approve call scores high, sort=score orders by it, detail carries it', async () => {
    const add = async (id: string, checks: { name: 'risky-command' | 'bad-path'; why: string }[] = []) => {
      await store.knowledge.upsertLesson({
        id, projectKey: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing the API', scope: 'project',
        paths: ['src/api.ts'], status: 'proposed', source: 'memory', embedding: vec(1), checks,
      });
      return (await store.knowledge.lessonDetail(id))!.lesson;
    };
    const [called, risky] = [await add('lesson:score-call'), await add('lesson:score-risky', [{ name: 'risky-command', why: 'curl | sh' }])];
    await add('lesson:score-plain', [{ name: 'bad-path', why: 'no such file' }]);
    for (const l of [called, risky]) {
      await store.decisions.propose({
        type: 'approve_lesson', projectKey: 'demo', targets: [{ kind: 'lesson', id: l.id, role: 'primary' }],
        before: [lessonSnapshot(l)], after: [lessonSnapshot({ ...l, status: 'approved', decidedAt: T0, decidedBy: 'loop:1' })],
        evidence: [{ kind: 'lesson', id: l.id, role: 'target', weight: 1, observedAt: T0 }], features: {}, score: 0.9,
        confidence: { p: 0.9, lower: 0.8, n: 30, band: 4 }, tier: 'A', mode: 'propose', rationale: 'repeats', model: 'deterministic', policyVersion: LOOP_POLICY_VERSION, status: 'proposed',
      });
    }
    await store.decisions.bumpCalibration({ type: 'approve_lesson', band: 4, policyVersion: LOOP_POLICY_VERSION, prior: LOOP_TYPE_INFO.approve_lesson.prior, alpha: 60, beta: 2, n: 62 });
    const a = app();
    const rows = (await get(a, '/api/lessons?status=proposed&project=demo&sort=score')) as { id: string; score: number; scoreWhy: string }[];
    const mine = rows.filter((r) => r.id.startsWith('lesson:score-'));
    expect(mine.map((r) => r.id)).toEqual(['lesson:score-call', 'lesson:score-plain', 'lesson:score-risky']);
    expect(mine[0].score).toBeGreaterThanOrEqual(7);
    expect(mine[0].scoreWhy).toContain('loop proposes approve_lesson: you kept 60 of 62 in its band (p .91)');
    expect(mine[2]).toMatchObject({ score: 2 });
    expect(mine[2].scoreWhy).toMatch(/^2\.0 · flagged risky-command; /);
    expect((await get(a, `/api/lessons/${encodeURIComponent(called.id)}`)).lesson.score).toBe(mine[0].score);
    const decisions = (await get(a, '/api/decisions?status=proposed&type=approve_lesson&sort=score')) as { approveScore: number; score: number }[];
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    expect(decisions.every((d) => d.approveScore >= 7 && d.score === 0.9)).toBe(true);
  });

  test('claims and questions: scored from extraction confidence and flags; sort=score orders the page', async () => {
    const docId = await store.docs.upsertDoc({ projectKey: 'demo', source: 'intake', ref: 'score.md', title: 'score', url: null }, [{ text: 'notes', embedding: vec(9) }]);
    await store.intake.upsertMeta({ docId, kind: 'notes', format: 'md', occurredAt: '2026-11-10', origin: 'test', private: true, participants: [] });
    const { version } = (await store.intake.nextWindow(docId))!;
    const draft = (statement: string, confidence: number, flags: ('quote-fuzzy')[] = []) => ({
      type: 'fact' as const, statement, quote: statement, speakerId: null, span: null, assertedAt: null, confidence,
      scope: { area: null, files: [] }, about: 'x', due: null, flags, embedding: vec(5),
    });
    await store.intake.saveWindow(docId, { window: 0, version, claims: [draft('low', 0.1), draft('high', 0.95), draft('fuzzy', 0.99, ['quote-fuzzy'])], questions: [{ text: 'who owns it?', kind: 'needs_owner', quote: null, askedBy: null }] });
    const a = app();
    const claims = (await get(a, `/api/claims?source=${encodeURIComponent(docId)}&sort=score`)) as { statement: string; score: number; scoreWhy: string }[];
    expect(claims.map((c) => c.statement)).toEqual(['high', 'fuzzy', 'low']);
    expect(claims[1].scoreWhy).toMatch(/^5\.0 · flagged quote-fuzzy; extraction 99% sure$/);
    const detail = await get(a, `/api/claims/${encodeURIComponent((await store.intake.listClaims({ docId })).find((c) => c.statement === 'low')!.id)}`);
    expect(detail.claim.score).toBeLessThan(5);
    // No loop call proposes assigning or closing it: nothing to approve yet.
    const questions = await get(a, `/api/questions?source=${encodeURIComponent(docId)}&sort=score`);
    expect(questions).toEqual([expect.objectContaining({ text: 'who owns it?', score: null, scoreWhy: null })]);
  });
});
