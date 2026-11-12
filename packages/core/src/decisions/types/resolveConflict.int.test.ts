import { beforeAll, expect, test } from 'vitest';
import { resolutionDecision, ResolveRefusal } from '../../conflicts/resolve.ts';
import type { LessonInput } from '../../graph/knowledge.ts';
import { claimFingerprint } from '../../intake/records.ts';
import type { Store } from '../../store.ts';
import { describeStores } from '../../testing/index.ts';
import type { Claim, ClaimDraft, Conflict, ConflictSide, Decision, DecisionInput, TargetSnapshot } from '../../types.ts';
import { decisionExecutor, type DecisionExecutor } from '../executor.ts';
import { ABSENT, factFingerprint, lessonFingerprint, TargetChangedError } from '../record.ts';
import { lessonSnapshot, snapshotTarget } from '../snapshot.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const embed = async (texts: string[]) => texts.map((_, i) => vec(200 + i));
const draft = (statement: string, over: Partial<ClaimDraft> = {}): ClaimDraft => ({
  type: 'decision', statement, quote: statement, speakerId: null, span: { utt: 0, start: 0, end: statement.length }, assertedAt: '2026-11-10T10:00:00.000Z',
  confidence: 0.9, scope: { area: 'retries', files: ['src/retry.ts'] }, about: 'retry timeout', due: null, flags: [], embedding: vec(1), ...over,
});

describeStores('resolve_conflict', (h) => {
  let s: Store;
  let x: DecisionExecutor;
  beforeAll(() => {
    s = h.store;
    x = decisionExecutor(s, { embed });
  });
  let seq = 0;

  /** Two claims from one source; `accepted` ones are given to agents as a fact (origin claim), as the review route files them. */
  const claims = async (texts: string[], accepted: boolean[] = []) => {
    const ref = `call-${++seq}.vtt`;
    const docId = await s.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref, title: ref, url: null }, [{ text: texts.join('\n'), embedding: vec(9) }]);
    await s.intake.upsertMeta({ docId, kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'sync', private: true, participants: [] });
    const { version } = (await s.intake.nextWindow(docId))!;
    await s.intake.saveWindow(docId, { window: 0, version, claims: texts.map((t, i) => draft(t, { embedding: vec(10 + i) })), questions: [] });
    const out: Claim[] = [];
    for (const [i, c] of (await s.intake.listClaims({ docId })).sort((p, q) => p.id.localeCompare(q.id)).entries()) {
      if (!accepted[i]) { out.push(c); continue; }
      await s.intake.decideClaim(c.id, { status: 'accepted' }, { by: 'you' });
      const fact = await s.facts.addOwnerFact('shop', { kind: 'decision', statement: c.statement, path: 'src/retry.ts', lines: null, confidence: 1, why: 'Ana, call', relevance: 0.55, embedding: vec(30 + i) }, 'you', null, { origin: 'claim' });
      out.push((await s.intake.decideClaim(c.id, { factId: fact.id }, { by: 'you' }))!);
    }
    return out;
  };
  const claimSide = (c: Claim): ConflictSide => ({ kind: 'claim', id: c.id, fingerprint: claimFingerprint(c), assertedAt: c.assertedAt });
  const open = async (a: ConflictSide, b: ConflictSide) => (await s.intake.openConflict({
    kind: 'disagreement', projectKey: 'shop', a, b, signals: [],
    judge: { relation: 'contradicts', aQuote: 'a', bQuote: 'b', explanation: 'they differ', confidence: 0.9, model: 'ollama:test' },
  })).conflict;
  const lesson = async (id: string, over: Partial<LessonInput> = {}) => {
    await s.knowledge.upsertLesson({
      id, projectKey: 'shop', title: `title ${id}`, rule: 'Retries wait 60 seconds', appliesWhen: 'changing retries', scope: 'project',
      paths: ['src/retry.ts'], status: 'approved', source: 'memory', embedding: vec(40), ...over,
    });
    return (await s.knowledge.lessonDetail(id))!.lesson;
  };
  const fact = (statement: string) => s.facts.addOwnerFact('shop', { kind: 'convention', statement, path: 'src/retry.ts', lines: null, confidence: 1, why: 'w', relevance: 0.6, embedding: vec(50 + ++seq) }, 'you');
  const fps = (list: TargetSnapshot[]) => Promise.all(list.map(async (b) => (await snapshotTarget(s, b)).fingerprint));
  const resolve = async (k: Conflict, r: Parameters<typeof resolutionDecision>[2]) => {
    const { decision } = await s.decisions.propose(await resolutionDecision(s, k, r, { by: 'you' }));
    return x.apply(decision, { by: 'you' });
  };

  test('A is true: the losing claim is superseded and the fact it had become closed, linked to the winner; rollback restores it all exactly', async () => {
    const [a, b] = await claims(['Retries wait 30 seconds', 'Retries wait 60 seconds'], [true, true]);
    const k = await open(claimSide(a), claimSide(b));
    const d = await resolve(k, { choice: 'a', note: 'the 60 s figure was the old config' });
    expect(d).toMatchObject({ type: 'resolve_conflict', author: 'owner', status: 'applied', tier: 'P', decidedBy: 'you' });
    expect(d.targets).toEqual([
      { kind: 'conflict', id: k.id, role: 'primary' }, { kind: 'claim', id: b.id, role: 'merged' }, { kind: 'fact', id: b.factId, role: 'merged' }, { kind: 'claim', id: a.id, role: 'keeper' },
    ]);
    expect(await s.intake.claim(b.id)).toMatchObject({ status: 'superseded', decidedBy: 'you', factId: b.factId });
    expect((await s.facts.fact(b.factId!))!.current).toBe(false);
    expect(await s.intake.claim(a.id)).toEqual(a);
    expect((await s.facts.fact(a.factId!))!.current).toBe(true);
    expect(await s.intake.conflict(k.id)).toMatchObject({
      status: 'resolved', resolvedBy: 'you', decisionId: d.id, resolution: { choice: 'a', note: 'the 60 s figure was the old config', reason: null, createdFactId: null },
    });
    expect((await s.intake.supersessions([b.id, b.factId!])).map((l) => [l.from.id, l.to.id, l.conflictId])).toEqual(expect.arrayContaining([[b.id, a.id, k.id], [b.factId, a.id, k.id]]));
    // The owner's decision is not the loop's: not counted among its decisions.
    expect((await s.decisions.count({ author: 'loop', type: 'resolve_conflict' }, [])).reduce((n, c) => n + c.n, 0)).toBe(0);
    expect((await s.decisions.count({ author: 'owner', type: 'resolve_conflict' }, [])).reduce((n, c) => n + c.n, 0)).toBeGreaterThan(0);

    const back = await x.rollback(d, { by: 'you', cascade: 'apply' }) as Decision;
    expect(back.status).toBe('rolled_back');
    expect(await fps(d.before)).toEqual(d.before.map((b) => b.fingerprint));
    expect(await s.intake.claim(b.id)).toEqual(b);
    expect((await s.facts.fact(b.factId!))!.current).toBe(true);
    expect(await s.intake.conflict(k.id)).toMatchObject({ status: 'open', resolution: null, resolvedBy: null, resolvedAt: null, decisionId: null });
    expect(await s.intake.supersessions([b.id, b.factId!])).toEqual([]);

    // Choosing again after the rollback is a new decision, and may choose the other side.
    const again = await resolve((await s.intake.conflict(k.id))!, { choice: 'b' });
    expect(again.id).not.toBe(d.id);
    expect(await s.intake.claim(a.id)).toMatchObject({ status: 'superseded' });
  });

  test('B is true over a lesson a loop reword changed: the lesson is superseded, rolling back the reword undoes the resolution first', async () => {
    const l = await lesson(`lesson:r${++seq}`);
    // The loop rewords the lesson (as reword_lesson plans it), applied on its own.
    const reworded = { ...l, rule: 'Retries wait 60 seconds between attempts' };
    const reword: DecisionInput = {
      type: 'reword_lesson', projectKey: 'shop', targets: [{ kind: 'lesson', id: l.id, role: 'primary' }], before: [lessonSnapshot(l)], after: [lessonSnapshot(reworded)],
      evidence: [{ kind: 'lesson', id: l.id, role: 'because', weight: 1, observedAt: '2026-11-01T00:00:00.000Z' }], features: {}, score: 0.9,
      confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 }, tier: 'A', mode: 'auto', rationale: 'clearer', model: 'deterministic', policyVersion: 1, status: 'proposed',
    };
    const rw = await x.apply((await s.decisions.propose(reword)).decision, { by: 'loop:1' });
    const now = (await s.knowledge.lessonDetail(l.id))!.lesson;
    const f = await fact('Retries wait 30 seconds');
    const k = await open({ kind: 'lesson', id: l.id, fingerprint: lessonFingerprint(now), assertedAt: null }, { kind: 'fact', id: f.id, fingerprint: factFingerprint({ ...f, current: true }), assertedAt: f.createdAt });
    const d = await resolve(k, { choice: 'b' });
    expect(d.dependsOn).toEqual([rw.id]);
    expect((await s.knowledge.lessonDetail(l.id))!.lesson).toMatchObject({ status: 'superseded', rule: 'Retries wait 60 seconds between attempts', decidedBy: 'you' });
    expect((await s.facts.fact(f.id))!.current).toBe(true);
    expect((await s.intake.supersessions([l.id])).map((x) => [x.from.kind, x.to.kind])).toEqual([['lesson', 'fact']]);

    // Rolling back the reword undoes the resolution built on it first (the cascade), then the reword.
    const plan = await x.rollback(rw, { by: 'you', cascade: 'preview' });
    expect('cascade' in plan && plan.cascade.map((c) => c.id)).toEqual([d.id]);
    await x.rollback(rw, { by: 'you', cascade: 'apply' });
    expect((await s.knowledge.lessonDetail(l.id))!.lesson).toMatchObject({ status: 'approved', rule: 'Retries wait 60 seconds', decidedBy: l.decidedBy ?? null });
    expect(lessonFingerprint((await s.knowledge.lessonDetail(l.id))!.lesson)).toBe(lessonFingerprint(l));
    expect(await s.intake.conflict(k.id)).toMatchObject({ status: 'open', resolution: null });
    expect(await s.intake.supersessions([l.id])).toEqual([]);
    expect((await s.decisions.get(d.id))!.status).toBe('rolled_back');
  });

  test('both partly with a reconciled statement: an owner fact is made, both sides superseded by it; rollback closes it and restores both', async () => {
    const [a] = await claims(['Retries wait 30 seconds on reads'], [false]);
    const f = await fact('Retries wait 60 seconds on writes');
    const k = await open(claimSide(a), { kind: 'fact', id: f.id, fingerprint: factFingerprint({ ...f, current: true }), assertedAt: f.createdAt });
    await expect(resolutionDecision(s, k, { choice: 'both' }, { by: 'you' })).rejects.toThrow(ResolveRefusal);
    await expect(resolutionDecision(s, k, { choice: 'a', statement: 'x' }, { by: 'you' })).rejects.toThrow(/only with both partly/);
    const d = await resolve(k, { choice: 'both', note: 'reads and writes differ', statement: 'Reads retry after 30 s, writes after 60 s' });
    const made = d.targets.find((t) => t.role === 'created')!;
    expect(await s.facts.fact(made.id)).toMatchObject({ statement: 'Reads retry after 30 s, writes after 60 s', current: true, origin: 'you', projectKey: 'shop' });
    expect(await s.intake.claim(a.id)).toMatchObject({ status: 'superseded' });
    expect((await s.facts.fact(f.id))!.current).toBe(false);
    expect((await s.intake.supersessions([made.id])).map((l) => l.from.id).sort()).toEqual([a.id, f.id].sort());
    expect((await s.intake.conflict(k.id))!.resolution).toEqual({ choice: 'both', note: 'reads and writes differ', reason: null, createdFactId: made.id });

    await x.rollback(d, { by: 'you', cascade: 'apply' });
    expect((await s.facts.fact(made.id))!.current).toBe(false);
    expect(await snapshotTarget(s, made)).toMatchObject({ fingerprint: ABSENT });
    expect(await s.intake.claim(a.id)).toEqual(a);
    expect((await s.facts.fact(f.id))!.current).toBe(true);
    expect(await s.intake.supersessions([made.id, a.id, f.id])).toEqual([]);
    expect((await s.intake.conflict(k.id))!.status).toBe('open');
  });

  test('both partly with only a note keeps both sides; not a conflict dismisses it; neither touches a side', async () => {
    const [a, b] = await claims(['Use Redis for the cache', 'Use Memcached for the cache'], [true, false]);
    const k = await open(claimSide(a), claimSide(b));
    const d = await resolve(k, { choice: 'both', note: 'Redis in prod, Memcached in tests' });
    expect(d.targets).toEqual([{ kind: 'conflict', id: k.id, role: 'primary' }]);
    expect(await s.intake.claim(a.id)).toEqual(a);
    expect(await s.intake.claim(b.id)).toEqual(b);
    expect(await s.intake.conflict(k.id)).toMatchObject({ status: 'resolved', resolution: { choice: 'both', note: 'Redis in prod, Memcached in tests' } });
    await expect(resolutionDecision(s, (await s.intake.conflict(k.id))!, { choice: 'none', reason: 'scope' }, { by: 'you' })).rejects.toThrow(/resolved already/);
    await x.rollback(d, { by: 'you', cascade: 'apply' });

    await expect(resolutionDecision(s, (await s.intake.conflict(k.id))!, { choice: 'none' }, { by: 'you' })).rejects.toThrow(/needs a reason/);
    const none = await resolve((await s.intake.conflict(k.id))!, { choice: 'none', reason: 'scope' });
    expect(await s.intake.conflict(k.id)).toMatchObject({ status: 'dismissed', resolution: { choice: 'none', reason: 'scope', note: null } });
    await x.rollback(none, { by: 'you', cascade: 'apply' });
    expect(await s.intake.conflict(k.id)).toMatchObject({ status: 'open', resolution: null });
  });

  test('a loser changed after the decision was built is not written over: the decision is overridden and nothing changes', async () => {
    const [a, b] = await claims(['Ship on the 12th', 'Ship in January'], [false, false]);
    const k = await open(claimSide(a), claimSide(b));
    const { decision } = await s.decisions.propose(await resolutionDecision(s, k, { choice: 'a' }, { by: 'you' }));
    const edited = (await s.intake.decideClaim(b.id, { statement: 'Ship in late January' }, { by: 'you' }))!;
    await expect(x.apply(decision, { by: 'you' })).rejects.toThrow(TargetChangedError);
    expect((await s.decisions.get(decision.id))!.status).toBe('overridden');
    expect(await s.intake.claim(b.id)).toEqual(edited);
    expect((await s.intake.conflict(k.id))!.status).toBe('open');
  });
});
