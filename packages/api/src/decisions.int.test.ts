import { candidateSnapshot, decisionExecutor, lessonFingerprint, lessonSnapshot, snapshotTargets, syncBundle, type Decision, type DecisionInput, type Lesson, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { createApp } from './app.ts';

/** The learning loop's routes over a real store and the real executor, on each backend. */

const OWNER = 'loop-int-owner-token-0123456789abcdef';
const T0 = '2026-11-01T00:00:00.000Z';
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));

describeStores('learning loop api', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  const app = () => createApp(store.graph, {
    auth: { ownerToken: OWNER },
    loop: {
      decisions: store.decisions, cursors: store.docs, activity: store.activity, lessonDetail: (id) => store.knowledge.lessonDetail(id),
      config: { mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0.2, types: null },
      exec: decisionExecutor(store, { embed: async (t) => t.map(() => vec(3)) }),
    },
  });
  const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true', 'content-type': 'application/json' };
  const post = (a: ReturnType<typeof app>, path: string, body: unknown) => a.request(path, { method: 'POST', headers: owner, body: JSON.stringify(body) });
  const lesson = async (id: string) => {
    await store.knowledge.upsertLesson({
      id, projectKey: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing the API', scope: 'project',
      paths: ['src/api.ts'], status: 'proposed', source: 'memory', embedding: vec(1),
    });
    return (await store.knowledge.lessonDetail(id))!.lesson;
  };
  const approveDecision = async (l: Lesson, over: Partial<DecisionInput> = {}) => (await store.decisions.propose({
    type: 'approve_lesson', projectKey: 'demo', targets: [{ kind: 'lesson', id: l.id, role: 'primary' }],
    before: [lessonSnapshot(l)], after: [lessonSnapshot({ ...l, status: 'approved', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'the loop approved it' })],
    evidence: [{ kind: 'lesson', id: l.id, role: 'target', weight: 1, observedAt: T0 }], features: {}, score: 0.9,
    confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 }, tier: 'A', mode: 'propose', rationale: 'repeated twice', model: 'deterministic', policyVersion: 1, status: 'proposed', ...over,
  })).decision;

  test('approve applies through the executor, rollback previews and restores, and every step is in the audit log and the live events', async () => {
    const a = app();
    const l = await lesson('lesson:int1');
    const d = await approveDecision(l);
    const list = await (await a.request('/api/decisions?status=proposed')).json();
    expect(list.map((x: Decision) => x.id)).toContain(d.id);
    const detail = await (await a.request(`/api/decisions/${encodeURIComponent(d.id)}`)).json();
    expect(detail.current).toEqual(d.before);
    expect(detail.evidence[0]).toMatchObject({ kind: 'lesson', label: 'title lesson:int1', projectKey: 'demo' });

    const approved = await post(a, `/api/decisions/${encodeURIComponent(d.id)}/approve`, { expect: 'proposed' });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: 'applied', decidedBy: 'you' });
    expect((await store.knowledge.lessonDetail(l.id))!.lesson.status).toBe('approved');

    const preview = await post(a, `/api/decisions/${encodeURIComponent(d.id)}/rollback`, { expect: 'applied', cascade: 'preview' });
    expect(await preview.json()).toEqual({ cascade: [], blocked: [] });
    const back = await post(a, `/api/decisions/${encodeURIComponent(d.id)}/rollback`, { expect: 'applied', reason: 'wording' });
    expect(await back.json()).toMatchObject({ status: 'rolled_back', rollback: { by: 'you', reason: 'wording' } });
    expect((await store.knowledge.lessonDetail(l.id))!.lesson).toMatchObject({ status: 'proposed', decidedBy: null });

    const events = await (await a.request('/api/loop/events')).json();
    expect(events.events.filter((e: { decisionId: string | null }) => e.decisionId === d.id).map((e: { kind: string; status: string }) => [e.kind, e.status]))
      .toEqual([['decision_applied', 'applied'], ['decision_rolled_back', 'rolled_back']]);
    const after = await (await a.request(`/api/loop/events?after=${events.next}`)).json();
    expect(after).toEqual({ events: [], next: events.next, gap: false });
  });

  test('a rollback after the owner changed the target is refused and the decision overridden; Restore anyway writes before over the change', async () => {
    const a = app();
    const l = await lesson('lesson:int2');
    const d = await approveDecision(l);
    await post(a, `/api/decisions/${encodeURIComponent(d.id)}/approve`, { expect: 'proposed' });
    await store.knowledge.updateLesson(l.id, { title: 'the owner reworded it' }, { by: 'you' });
    const refused = await post(a, `/api/decisions/${encodeURIComponent(d.id)}/rollback`, { expect: 'applied' });
    expect(refused.status).toBe(409);
    expect((await store.decisions.get(d.id))!.status).toBe('overridden');
    const detail = await (await a.request(`/api/decisions/${encodeURIComponent(d.id)}`)).json();
    expect(detail.current[0].fields.title).toBe('the owner reworded it');
    const restored = await post(a, `/api/decisions/${encodeURIComponent(d.id)}/rollback`, { expect: 'overridden', restoreAnyway: true });
    expect(restored.status).toBe(200);
    expect((await store.knowledge.lessonDetail(l.id))!.lesson).toMatchObject({ title: 'title lesson:int2', status: 'proposed' });
    const kinds = (await store.activity.list({ target: d.id, limit: 10 })).map((e) => [e.kind, e.details.action]).reverse();
    expect(kinds).toEqual([['decision_applied', 'approve'], ['decision_made', 'overridden'], ['decision_rolled_back', 'restore_anyway']]);
  });

  test('a later decision on the target recorded without the dependency: the rollback is refused naming it, and nothing is overridden or labelled', async () => {
    const a = app();
    const x = decisionExecutor(store);
    const l0 = await lesson('lesson:int-chain');
    const step = async (type: Decision['type'], l: Lesson, patch: Partial<Lesson>) => x.apply((await store.decisions.propose({
      type, projectKey: 'demo', targets: [{ kind: 'lesson', id: l.id, role: 'primary' }], before: [lessonSnapshot(l)], after: [lessonSnapshot({ ...l, ...patch })],
      evidence: [{ kind: 'lesson', id: l.id, role: type, weight: 1, observedAt: T0 }], features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 },
      tier: 'H', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
    })).decision, { by: 'loop:1' });
    const rw = await step('rank_weight', l0, { servingWeight: 0.9 });
    const rt = await step('retire_lesson', (await store.knowledge.lessonDetail(l0.id))!.lesson, { status: 'revoked', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'retired' });
    // The preview answers the same, and does not mark it overridden.
    const p = await post(a, `/api/decisions/${encodeURIComponent(rw.id)}/rollback`, { expect: 'applied', cascade: 'preview' });
    expect(p.status).toBe(409);
    expect(await p.json()).toMatchObject({ error: expect.stringContaining(`by ${rt.id}, still applied`), blocked: [{ id: rt.id }] });
    expect((await store.decisions.get(rw.id))!.status).toBe('applied');
    const r = await post(a, `/api/decisions/${encodeURIComponent(rw.id)}/rollback`, { expect: 'applied', reason: 'wrong_evidence' });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ blocked: [{ id: rt.id }] });
    expect((await store.decisions.get(rw.id))!.status).toBe('applied');
    expect(await store.activity.list({ target: rw.id, limit: 10 })).toEqual([]);
  });

  test('your revoke on the Lessons page overrides a held loop decision on the lesson: logged as yours, and the sync sends the revoke', async () => {
    const a = createApp(store.graph, {
      auth: { ownerToken: OWNER }, knowledge: store.knowledge, activity: store.activity,
      loop: {
        decisions: store.decisions, cursors: store.docs, activity: store.activity, lessonDetail: (id) => store.knowledge.lessonDetail(id),
        config: { mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0, types: null },
        exec: decisionExecutor(store),
      },
    });
    const l0 = await lesson('lesson:int-held');
    await store.knowledge.updateLesson(l0.id, { status: 'approved' }, { by: 'you' });
    const l = (await store.knowledge.lessonDetail(l0.id))!.lesson;
    const { decision } = await store.decisions.propose({
      type: 'rank_weight', projectKey: 'demo', targets: [{ kind: 'lesson', id: l.id, role: 'primary' }], before: [lessonSnapshot(l)], after: [lessonSnapshot({ ...l, servingWeight: 0.9 })],
      evidence: [{ kind: 'lesson', id: l.id, role: 'w', weight: 1, observedAt: T0 }], features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 },
      tier: 'H', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
    });
    await decisionExecutor(store).apply(decision, { by: 'loop:1', syncHoldUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    const r = await a.request(`/api/lessons/${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: owner, body: JSON.stringify({ status: 'revoked' }) });
    expect(r.status).toBe(200);
    expect((await store.decisions.get(decision.id))!).toMatchObject({ status: 'overridden', decidedBy: 'you' });
    expect((await store.activity.list({ target: decision.id, limit: 5 }))[0]).toMatchObject({ kind: 'decision_made', actor: 'you', details: { status: 'overridden', action: 'overridden' } });
    const bundle = (await syncBundle(store.portability, 'demo', { fingerprint: '', lessons: [l.id], misses: [], docs: [], files: [], remote: null }))!;
    expect(bundle.lessons.find((x) => x.id === l.id)?.status).toBe('revoked');
  });

  test('a double-clicked rollback: one rolls it back, the other is a clean 409, and the decision ends rolled back with its target restored', async () => {
    const a = app();
    const x = decisionExecutor(store);
    for (let i = 0; i < 15; i++) {
      const l0 = await lesson(`lesson:dbl${i}`);
      await store.knowledge.updateLesson(l0.id, { status: 'approved' }, { by: 'you' });
      const l = (await store.knowledge.lessonDetail(l0.id))!.lesson;
      const d = await approveDecision(l, { type: 'retire_lesson', after: [lessonSnapshot({ ...l, status: 'revoked', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'retired' })] });
      await x.apply(d, { by: 'loop:1' });
      const both = await Promise.all([0, 1].map(() => post(a, `/api/decisions/${encodeURIComponent(d.id)}/rollback`, { expect: 'applied' })));
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await store.decisions.get(d.id))!.status).toBe('rolled_back');
      expect(lessonFingerprint((await store.knowledge.lessonDetail(l.id))!.lesson)).toBe(d.before[0].fingerprint);
      expect((await store.activity.list({ target: d.id, limit: 10 })).filter((e) => e.details.status === 'overridden')).toEqual([]);
    }
  }, 120_000);

  test('you decide an Inbox item the loop proposed to triage: the proposal is expired, not left waiting for an approve that would fail', async () => {
    const a = app();
    const turns = [0, 1].map((i) => ({ uuid: `tri-t${i}`, sessionId: 'tri', ts: `2026-10-01T10:0${i}:00Z`, index: i, text: `turn ${i}`, precedingAssistantText: '', precedingToolCalls: [] }));
    await store.graph.upsertSession({ key: 'demo', name: 'demo', repoPath: '/w/demo' }, { sessionId: 'tri', sourceFile: 'f', cwd: '/w/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[1].ts, turns, toolCalls: [] }, []);
    await store.graph.saveClassification('tri-t1', { label: 'pushback', confidence: 0.9, summary: 's', signals: [] }, true);
    const targets = [{ kind: 'candidate' as const, id: 'tri-t1', role: 'primary' as const }];
    const { decision } = await store.decisions.propose({
      type: 'triage_inbox', projectKey: 'demo', targets, before: await snapshotTargets(store, targets), after: [candidateSnapshot({ id: 'tri-t1', status: 'confirmed', note: null, decidedBy: null })],
      evidence: [{ kind: 'candidate', id: 'tri-t1', role: 'classifier 0.9', weight: 1, observedAt: T0 }], features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 },
      tier: 'P', mode: 'propose', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
    });
    const r = await a.request('/api/candidates/tri-t1/decision', { method: 'POST', headers: owner, body: JSON.stringify({ status: 'confirmed' }) });
    expect(r.status).toBe(204);
    expect((await store.decisions.get(decision.id))!).toMatchObject({ status: 'expired', decidedBy: 'you' });
    expect((await store.activity.list({ target: decision.id, limit: 5 }))[0]).toMatchObject({ kind: 'decision_made', details: { status: 'expired' } });
  });

  test('reject and notes against the store (redacted), the loop state, pause and resume', async () => {
    const a = app();
    const l = await lesson('lesson:int3');
    const d = await approveDecision(l, { policyVersion: 2 });
    expect(await (await post(a, `/api/decisions/${encodeURIComponent(d.id)}/reject`, { expect: 'proposed', note: 'not yet', reason: 'not_now' })).json()).toMatchObject({ status: 'rejected', decidedBy: 'you' });
    const note = await post(a, `/api/decisions/${encodeURIComponent(d.id)}/notes`, { text: 'token ghp_' + 'A1b2'.repeat(9), verdict: 'disagree', reason: 'wording' });
    expect(note.status).toBe(201);
    expect((await note.json()).text).not.toMatch(/ghp_A1b2/);
    expect((await (await a.request(`/api/decisions/${encodeURIComponent(d.id)}`)).json()).notes.map((n: { verdict: string }) => n.verdict)).toEqual(['disagree', 'disagree']);
    const s = await (await a.request('/api/loop', { headers: { authorization: `Bearer ${OWNER}` } })).json();
    expect(s).toMatchObject({ mode: 'auto', effectiveMode: 'auto', capped: null, policyVersion: 1 });
    const paused = await (await a.request('/api/loop/pause', { method: 'POST', headers: owner, body: '{}' })).json();
    expect(paused).toMatchObject({ effectiveMode: 'off', capped: 'paused' });
    await a.request('/api/loop/resume', { method: 'POST', headers: owner, body: '{}' });
  });

  test('a hidden project stays hidden: no page header for its matches, since as an instant, and no track record of its global lesson or its entries', async () => {
    const a = createApp(store.graph, {
      auth: { ownerToken: OWNER },
      shown: async () => ({ keys: ['demo'], has: (k: string) => k === 'demo' }) as never,
      loop: { decisions: store.decisions, cursors: store.docs, activity: store.activity, lessonDetail: (id) => store.knowledge.lessonDetail(id), config: { mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0.2, types: null } },
    });
    const read = { authorization: `Bearer ${OWNER}` };
    const shown = await approveDecision(await lesson('lesson:shown'));
    for (const i of [1, 2]) {
      const l = await lesson(`lesson:secret${i}`);
      await approveDecision(l, { projectKey: 'secret-proj', rationale: 'HIDDEN-RATIONALE-zebra' });
    }
    const page = await a.request('/api/decisions?q=HIDDEN-RATIONALE-zebra&limit=1', { headers: read });
    expect(await page.json()).toEqual([]);
    expect(page.headers.get('x-next-offset')).toBeNull();
    const createdAt = (await store.decisions.get(shown.id))!.createdAt;
    const at = Date.parse(createdAt) - 60_000;
    const iso = (offsetMin: number) => {
      const t = new Date(at + offsetMin * 60_000).toISOString().slice(0, 19);
      const sign = offsetMin < 0 ? '-' : '+';
      const h = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0');
      return `${t}${sign}${h}:00`;
    };
    for (const since of [new Date(at).toISOString().replace('.000Z', 'Z'), iso(-480), iso(480)]) {
      const rows = await (await a.request(`/api/decisions?since=${encodeURIComponent(since)}`, { headers: read })).json();
      expect(rows.map((x: { id: string }) => x.id), since).toEqual([shown.id]);
    }
    expect((await a.request(`/api/decisions?since=${encodeURIComponent('2026-11-01T00:00:00+99:00')}`, { headers: read })).status).toBe(400);

    await store.knowledge.upsertLesson({
      id: 'lesson:hid-t1', projectKey: 'secret-proj', title: 'HIDDEN GLOBAL LESSON TITLE', rule: 'rule', appliesWhen: 'editing the API', scope: 'project',
      paths: [], status: 'approved', source: 'memory', embedding: vec(2),
    });
    // Made global: no project, learned in secret-proj (its origin).
    await store.knowledge.updateLesson('lesson:hid-t1', { scope: 'global' }, { by: 'you' });
    await store.knowledge.upsertLesson({
      id: 'lesson:glob', projectKey: 'demo', title: 'Global', rule: 'rule', appliesWhen: 'editing the API', scope: 'project',
      paths: [], status: 'approved', source: 'memory', embedding: vec(4),
    });
    // Made global: no project, learned in demo (its origin).
    await store.knowledge.updateLesson('lesson:glob', { scope: 'global' }, { by: 'you' });
    await store.activity.record({ kind: 'context_served', actor: 'agent', projectKey: 'secret-proj', subject: 'HIDDEN SERVED SUBJECT', why: 'w', details: { sessionId: 'hid-sess' }, targets: ['lesson:hid-t1', 'lesson:glob'] });
    await store.activity.record({ kind: 'context_served', actor: 'agent', projectKey: 'demo', subject: 'context for checkout', why: 'w', details: { sessionId: 'sess-1' }, targets: ['lesson:glob'] });
    expect((await store.knowledge.lessonDetail('lesson:hid-t1'))!.lesson).toMatchObject({ projectKey: null, origin: 'secret-proj' });
    expect((await a.request('/api/loop/lessons/lesson:hid-t1/track', { headers: read })).status).toBe(404);
    const t = await (await a.request('/api/loop/lessons/lesson:glob/track', { headers: read })).json();
    expect(JSON.stringify(t)).not.toMatch(/HIDDEN|hid-sess/);
    expect(t.timeline.map((e: { kind: string; sessionId: string | null }) => [e.kind, e.sessionId])).toEqual([['served', 'sess-1']]);
  });
});
