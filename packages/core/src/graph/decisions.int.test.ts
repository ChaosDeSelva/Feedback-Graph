import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { decisionId } from '../decisions/record.ts';
import { setRedactionArchive, type RedactionOriginal } from '../redactionArchive.ts';
import type { DecisionsStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { GraphRepo } from './repo.ts';
import { LESSON_SIGNAL_COUNTS, type DecisionInput, type LessonSignalCount } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const SECRET = `ghp_${'A1b2'.repeat(9)}`;

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  type: 'link_misses', projectKey: 'demo',
  targets: [{ kind: 'miss', id: 'miss:a', role: 'primary' }, { kind: 'miss', id: 'miss:b', role: 'keeper' }],
  before: [], after: [],
  evidence: [{ kind: 'miss', id: 'miss:b', role: 'repeat of', weight: 0.9, observedAt: '2026-11-01T00:00:00.000Z' }],
  features: { cosine: 0.93 }, score: 0.8, confidence: { p: 0.8, lower: 0.7, n: 3, band: 3 }, tier: 'H', mode: 'propose',
  rationale: 'the misses repeat', model: 'deterministic', policyVersion: 1, status: 'proposed', ...over,
});
const counts = (n: number) => Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, n])) as Record<LessonSignalCount, number>;

describeStores('DecisionsStore', (h) => {
  let d: DecisionsStore;
  beforeAll(() => {
    d = h.store.decisions;
  });
  afterEach(() => setRedactionArchive(undefined));

  const lesson = (id: string, status: 'proposed' | 'approved' = 'proposed') => h.store.knowledge.upsertLesson({
    id, projectKey: 'demo', title: 'Use the gateway', rule: 'Call the API through the gateway', appliesWhen: 'calling the API',
    scope: 'project', paths: ['src/api.ts'], status, source: 'memory', embedding: vec(1),
  });
  const misses = async (...ids: string[]) => {
    for (const [i, id] of ids.entries()) await h.probe.seedEmbedded({ kind: 'Miss', id, missed: `missed ${id}`, causeExplanation: 'c', embedding: vec(i) });
  };

  test('propose stores the decision under its content-addressed id; proposing it again is a no-op that returns it', async () => {
    const first = await d.propose(input({ dependsOn: ['dec:earlier', 'dec:earlier'] }));
    expect(first.created).toBe(true);
    expect(first.decision).toEqual({
      ...input(), id: decisionId(input({ dependsOn: ['dec:earlier'] })), status: 'proposed', dependsOn: ['dec:earlier'], createdAt: expect.any(String), appliedAt: null,
      decidedAt: null, decidedBy: null, supersededBy: null, rollback: null, ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null, author: 'loop',
    });
    expect(first.decision.id).toMatch(/^dec:[0-9a-f]{64}$/);
    // Recomputed weights, a new rationale and the same targets in another order: the same decision.
    const again = await d.propose(input({
      rationale: 'reworded', targets: [...input().targets].reverse(), dependsOn: ['dec:earlier'],
      evidence: [{ ...input().evidence[0], weight: 0.5, observedAt: '2026-11-02T00:00:00.000Z' }],
    }));
    expect(again).toEqual({ created: false, decision: first.decision });
    expect(await h.probe.count('Decision')).toBe(1);
    // Other evidence, another policy version, or building on other decisions: other decisions.
    expect((await d.propose(input({ evidence: [] }))).created).toBe(true);
    expect((await d.propose(input({ dependsOn: ['dec:other'] }))).created).toBe(true);
    expect((await d.propose(input({ policyVersion: 2 }))).created).toBe(true);
    expect(await d.get('dec:none')).toBeNull();
  });

  test('two rounds proposing the same decision at once store it once', async () => {
    const results = await Promise.all([1, 2, 3].map(() => d.propose(input())));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await h.probe.count('Decision')).toBe(1);
  });

  test('an observed decision needs no project and no model, and keeps targets of every kind', async () => {
    const targets = [
      { kind: 'lesson', id: 'lesson:x', role: 'merged' }, { kind: 'fact', id: 'fact:x', role: 'created' },
      { kind: 'candidate', id: 'cand:x', role: 'primary' }, { kind: 'project', id: 'demo', role: 'primary' },
    ] as const;
    const { decision } = await d.propose(input({ projectKey: null, model: null, status: 'observed', mode: 'observe', targets: [...targets], features: {} }));
    expect(decision).toMatchObject({ projectKey: null, model: null, status: 'observed', mode: 'observe', targets, features: {} });
    for (const t of targets) expect((await d.forTarget(t.id)).map((x) => x.id)).toEqual([decision.id]);
  });

  test('list by idPrefix finds the decisions whose id starts with it, and only those', async () => {
    const a = (await d.propose(input({ policyVersion: 11 }))).decision.id;
    const b = (await d.propose(input({ policyVersion: 12 }))).decision.id;
    expect((await d.list({ idPrefix: a.slice(0, 20) })).map((x) => x.id)).toEqual([a]);
    expect((await d.list({ idPrefix: 'dec:' })).map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(await d.list({ idPrefix: 'dec:zz' })).toEqual([]);
  });

  test('loopChanged names the ids an applied decision the loop made holds in its after, and no other', async () => {
    const snapshot = (id: string) => ({ kind: 'miss' as const, id, fields: { repeats: 'miss:b' }, fingerprint: 'a'.repeat(64) });
    const apply = async (o: Partial<DecisionInput>, by: string, after: string[]) => {
      const { decision: { id } } = await d.propose(input(o));
      await d.markApplying(id, { by });
      await d.markApplied(id, after.map(snapshot));
      return id;
    };
    await apply({ policyVersion: 1 }, 'loop:1', ['miss:a']); // miss:b is its keeper: a target, not changed
    await apply({ policyVersion: 2, targets: [{ kind: 'miss', id: 'miss:c', role: 'primary' }] }, 'you', ['miss:c']);
    await apply({ policyVersion: 3, targets: [{ kind: 'miss', id: 'miss:d', role: 'primary' }] }, 'loop:1', ['miss:d']);
    await d.markStatus((await d.forTarget('miss:d'))[0]!.id, { status: 'rolled_back', from: ['applied'], by: 'you' });
    await d.propose(input({ policyVersion: 4, targets: [{ kind: 'miss', id: 'miss:e', role: 'primary' }] }));
    expect((await d.loopChanged(['miss:a', 'miss:b', 'miss:c', 'miss:d', 'miss:e', 'miss:none', 'miss:a'])).sort()).toEqual(['miss:a']);
    expect(await d.loopChanged([])).toEqual([]);
  });

  test('markApplying and markApplied are compare-and-set; inFlight lists what a crash left applying', async () => {
    const { decision: { id } } = await d.propose(input());
    const after = [{ kind: 'miss' as const, id: 'miss:a', fields: { repeats: 'miss:b' }, fingerprint: 'a'.repeat(64) }];
    expect(await d.markApplied(id, after)).toBe(false); // not applying
    expect(await d.markApplying(id)).toBe(true);
    expect(await d.markApplying(id)).toBe(false);
    expect((await d.inFlight()).map((x) => x.id)).toEqual([id]);
    expect(await d.markApplied(id, after, { syncHoldUntil: '2026-12-01T00:00:00.000Z' })).toBe(true);
    expect(await d.markApplied(id, after)).toBe(false);
    expect(await d.get(id)).toMatchObject({ status: 'applied', after, appliedAt: expect.any(String), syncHoldUntil: '2026-12-01T00:00:00.000Z' });
    expect(await d.inFlight()).toEqual([]);
    expect(await d.markApplying(id)).toBe(false);
    expect(await d.markApplying('dec:none')).toBe(false);

    const observed = (await d.propose(input({ status: 'observed', policyVersion: 9 }))).decision.id;
    expect(await d.markApplying(observed)).toBe(true);
    expect(await d.markApplied(observed, [])).toBe(true);
    expect((await d.get(observed))!.syncHoldUntil).toBeNull();
  });

  test('of racing markApplying calls exactly one wins', async () => {
    const { decision: { id } } = await d.propose(input());
    expect((await Promise.all([1, 2, 3, 4, 5].map(() => d.markApplying(id)))).filter(Boolean)).toHaveLength(1);
  });

  test('markStatus moves only from the given statuses, records who decided, and keeps the rollback; ratify needs applied', async () => {
    const { decision: { id } } = await d.propose(input());
    expect(await d.ratify(id, 'you')).toBe(false);
    expect(await d.markStatus(id, { status: 'rolled_back', from: ['applied'], by: 'you' })).toBe(false);
    expect(await d.markStatus(id, { status: 'expired', from: ['proposed'] })).toBe(true);
    expect(await d.get(id)).toMatchObject({ status: 'expired', decidedAt: null, decidedBy: null });
    expect(await d.markStatus(id, { status: 'proposed', from: ['expired'], by: 'loop:1' })).toBe(true);
    expect(await d.markApplying(id)).toBe(true);
    expect(await d.markApplied(id, [])).toBe(true);
    expect(await d.ratify(id, 'you')).toBe(true);
    expect(await d.get(id)).toMatchObject({ ratifiedBy: 'you', ratifiedAt: expect.any(String), decidedBy: 'loop:1' });
    const rollback = { at: '2026-11-03T00:00:00.000Z', by: 'you', reason: 'too_broad' as const, note: `it leaked ${SECRET}`, cascade: ['dec:later'] };
    expect(await d.markStatus(id, { status: 'rolled_back', from: ['applied'], by: 'you', rollback, supersededBy: 'dec:next' })).toBe(true);
    const rolled = (await d.get(id))!;
    expect(rolled).toMatchObject({ status: 'rolled_back', decidedBy: 'you', supersededBy: 'dec:next', rollback: { ...rollback, note: 'it leaked [REDACTED]' } });
    expect(rolled.decidedAt).not.toBeNull();
    // A later move without a rollback or a successor keeps them.
    expect(await d.markStatus(id, { status: 'overridden', from: ['rolled_back'] })).toBe(true);
    expect(await d.get(id)).toMatchObject({ status: 'overridden', decidedBy: 'you', supersededBy: 'dec:next', rollback: { cascade: ['dec:later'] } });
    expect(await d.markStatus(id, { status: 'rolled_back', from: ['overridden'], rollback: { ...rollback, note: null } })).toBe(true);
    expect((await d.get(id))!.rollback!.note).toBeNull();
  });

  test('markStatus with a call: the decision is recorded with the mode, score and confidence the loop made it with again', async () => {
    const { decision: { id } } = await d.propose(input({ mode: 'observe', status: 'observed' }));
    const call = { mode: 'auto' as const, score: 0.9, confidence: { p: 0.92, lower: 0.85, n: 7, band: 4 } };
    expect(await d.markStatus(id, { status: 'observed', from: ['observed'], call })).toBe(true);
    expect(await d.get(id)).toMatchObject({ status: 'observed', ...call });
    expect((await d.list({ mode: 'auto', band: 4 })).map((x) => x.id)).toEqual([id]);
    // A move without a call keeps them.
    expect(await d.markStatus(id, { status: 'proposed', from: ['observed'] })).toBe(true);
    expect(await d.get(id)).toMatchObject({ status: 'proposed', ...call });
  });

  test('list filters by status, type, project, mode, band, target, age and text, newest first, and pages', async () => {
    const ids = [];
    for (const [i, over] of ([
      { type: 'link_misses', status: 'proposed', projectKey: 'demo', mode: 'propose' },
      { type: 'retire_lesson', status: 'observed', projectKey: 'shop', mode: 'observe', targets: [{ kind: 'lesson', id: 'lesson:Zed', role: 'primary' }], rationale: 'Never HELPED in 60 days' },
      { type: 'link_misses', status: 'proposed', projectKey: 'shop', mode: 'auto', confidence: { p: 0.95, lower: 0.9, n: 30, band: 4 } },
    ] as Partial<DecisionInput>[]).entries()) {
      const { decision } = await d.propose(input({ ...over, policyVersion: i }));
      await h.probe.setDecisionCreatedAt([decision.id], `2026-11-0${i + 1}T00:00:00.000Z`);
      ids.push(decision.id);
    }
    const [a, b, c] = ids;
    expect((await d.list()).map((x) => x.id)).toEqual([c, b, a]);
    expect((await d.list({ status: ['observed', 'applied'] })).map((x) => x.id)).toEqual([b]);
    expect((await d.list({ type: 'link_misses' })).map((x) => x.id)).toEqual([c, a]);
    expect((await d.list({ projectKey: 'shop' })).map((x) => x.id)).toEqual([c, b]);
    expect((await d.list({ mode: 'auto' })).map((x) => x.id)).toEqual([c]);
    expect((await d.list({ band: 3 })).map((x) => x.id)).toEqual([b, a]);
    expect((await d.list({ target: 'lesson:Zed' })).map((x) => x.id)).toEqual([b]);
    expect((await d.list({ since: '2026-11-02T00:00:00.000Z' })).map((x) => x.id)).toEqual([c, b]);
    expect((await d.list({ until: '2026-11-02T00:00:00.000Z' })).map((x) => x.id)).toEqual([a]);
    expect((await d.list({ since: '2026-11-02T00:00:00.000Z', until: '2026-11-03T00:00:00.000Z' })).map((x) => x.id)).toEqual([b]);
    // since / until are instants on every backend: the same time with any offset finds the same decisions.
    for (const [since, until] of [['2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z'], ['2026-11-01T16:00:00-08:00', '2026-11-02T16:00:00-08:00'], ['2026-11-02T08:00:00+08:00', '2026-11-03T08:00:00+08:00']]) {
      expect((await d.list({ since })).map((x) => x.id), since).toEqual([c, b]);
      expect((await d.list({ since, until })).map((x) => x.id), until).toEqual([b]);
    }
    expect((await d.list({ q: 'helped' })).map((x) => x.id)).toEqual([b]);
    expect((await d.list({ q: 'ZED' })).map((x) => x.id)).toEqual([b]);
    expect((await d.list({ q: 'miss:B' })).map((x) => x.id)).toEqual([c, a]);
    expect((await d.list({ q: '100%' })).map((x) => x.id)).toEqual([]);
    expect((await d.list({ limit: 2 })).map((x) => x.id)).toEqual([c, b]);
    expect((await d.list({ limit: 2, offset: 2 })).map((x) => x.id)).toEqual([a]);
    expect((await d.forTarget('miss:a')).map((x) => x.id)).toEqual([c, a]);
    expect(await d.forTarget('miss:none')).toEqual([]);
    // projectKeys: only those projects' decisions, and those of none; a hidden match never fills a page.
    const none = (await d.propose(input({ projectKey: null, policyVersion: 9 }))).decision.id;
    await h.probe.setDecisionCreatedAt([none], '2026-10-01T00:00:00.000Z');
    expect((await d.list({ projectKeys: ['demo'] })).map((x) => x.id)).toEqual([a, none]);
    expect((await d.list({ projectKeys: [] })).map((x) => x.id)).toEqual([none]);
    expect((await d.list({ projectKeys: ['shop'], q: 'miss:B' })).map((x) => x.id)).toEqual([c, none]);
  });

  test('list by when decisions were applied (appliedSince, newest applied first) and when someone last decided them (decidedSince)', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 15));
    const made: string[] = [];
    for (const v of [1, 2, 3]) made.push((await d.propose(input({ policyVersion: v, status: 'observed' }))).decision.id);
    const apply = async (id: string) => { await d.markApplying(id); await d.markApplied(id, []); await tick(); };
    // Made first, applied last: an observed call the loop applied once it switched to auto.
    await apply(made[2]);
    const mid = new Date().toISOString();
    await tick();
    await apply(made[0]);
    expect((await d.list({ order: 'applied' })).map((x) => x.id)).toEqual([made[0], made[2]]);
    expect((await d.list({ status: ['applied'], appliedSince: mid })).map((x) => x.id)).toEqual([made[0]]);
    expect((await d.list({ appliedSince: mid, order: 'applied', limit: 1 })).map((x) => x.id)).toEqual([made[0]]);
    const later = new Date().toISOString();
    await d.markStatus(made[2], { status: 'rolled_back', from: ['applied'], by: 'you' });
    expect((await d.list({ status: ['rolled_back'], decidedSince: later })).map((x) => x.id)).toEqual([made[2]]);
    expect(await d.list({ decidedSince: new Date(Date.now() + 60_000).toISOString() })).toEqual([]);
  });

  test('count groups what list matches by status, mode, type, applied and week, with list\'s filters, and agrees with list', async () => {
    const made: string[] = [];
    for (const [v, o] of ([
      [1, { status: 'proposed', mode: 'propose' }], [2, { status: 'proposed', mode: 'propose', projectKey: 'shop' }], [3, { status: 'observed', mode: 'observe' }],
      [4, { status: 'proposed', mode: 'propose', type: 'retire_lesson', targets: [{ kind: 'lesson', id: 'lesson:x', role: 'primary' }] }], [5, { status: 'proposed', mode: 'auto', projectKey: null }],
    ] as [number, Partial<DecisionInput>][])) made.push((await d.propose(input({ policyVersion: v, ...o }))).decision.id);
    await d.markApplying(made[4]);
    await d.markApplied(made[4], []);
    await d.markStatus(made[4], { status: 'rolled_back', from: ['applied'], by: 'you' });
    // 2026-11-02 (a Monday: W45, as isoWeek has it) and 2026-11-10 (W46), at the turn of a day in UTC.
    await h.probe.setDecisionCreatedAt(made.slice(0, 2), '2026-11-02T23:59:59.000Z');
    await h.probe.setDecisionCreatedAt(made.slice(2), '2026-11-10T00:00:00.000Z');
    const sorted = (rows: object[]) => rows.map((r) => JSON.stringify(r)).sort();
    expect(await d.count({}, [])).toEqual([{ n: 5 }]);
    expect(await d.count({ status: ['applying'] }, [])).toEqual([{ n: 0 }]);
    expect(sorted(await d.count({}, ['status', 'mode']))).toEqual(sorted([
      { status: 'proposed', mode: 'propose', n: 3 }, { status: 'observed', mode: 'observe', n: 1 }, { status: 'rolled_back', mode: 'auto', n: 1 },
    ]));
    expect(sorted(await d.count({ projectKeys: ['demo'] }, ['type', 'applied']))).toEqual(sorted([
      { type: 'link_misses', applied: false, n: 2 }, { type: 'retire_lesson', applied: false, n: 1 }, { type: 'link_misses', applied: true, n: 1 },
    ]));
    expect(sorted(await d.count({ mode: 'propose' }, ['createdWeek']))).toEqual(sorted([{ createdWeek: '2026-W45', n: 2 }, { createdWeek: '2026-W46', n: 1 }]));
    expect(await d.count({ since: '2026-11-09T16:00:00-08:00', status: ['proposed'] }, [])).toEqual([{ n: 1 }]);
    expect(await d.count({ appliedSince: '2026-01-01T00:00:00Z' }, ['status'])).toEqual([{ status: 'rolled_back', n: 1 }]);
    // The same as counting what list returns.
    for (const f of [{}, { status: ['proposed' as const] }, { projectKeys: ['shop'] }, { since: '2026-11-05T00:00:00Z' }, { type: 'retire_lesson' as const }]) {
      expect((await d.count(f, []))[0].n, JSON.stringify(f)).toBe((await d.list({ ...f, limit: 100 })).length);
    }
  });

  test('list after a decision (keyset) pages in created order as offset does; by any of several targets; applied before', async () => {
    const ids: string[] = [];
    for (let v = 1; v <= 5; v++) ids.push((await d.propose(input({ policyVersion: v, targets: [{ kind: 'miss', id: `miss:t${v % 2}`, role: 'primary' }] }))).decision.id);
    // Two share a createdAt: the id breaks the tie.
    await h.probe.setDecisionCreatedAt(ids.slice(0, 2), '2026-11-01T00:00:00.000Z');
    await h.probe.setDecisionCreatedAt(ids.slice(2), '2026-11-02T00:00:00.000Z');
    const all = (await d.list({ limit: 10 })).map((x) => x.id);
    const pages: string[] = [];
    for (let after: { createdAt: string; id: string } | undefined; ;) {
      const page = await d.list({ limit: 2, ...(after && { after }) });
      pages.push(...page.map((x) => x.id));
      if (page.length < 2) break;
      after = { createdAt: page[1].createdAt, id: page[1].id };
    }
    expect(pages).toEqual(all);
    expect((await d.list({ after: { createdAt: '2026-11-02T00:00:00.000Z', id: '' }, limit: 10 })).map((x) => x.id)).toEqual(all.slice(3));
    expect((await d.list({ targets: ['miss:t0', 'miss:none'], limit: 10 })).map((x) => x.id).sort()).toEqual([ids[1], ids[3]].sort());
    expect(await d.list({ targets: ['miss:none'] })).toEqual([]);
    await d.markApplying(ids[0]);
    await d.markApplied(ids[0], []);
    expect((await d.list({ appliedBefore: new Date(Date.now() + 60_000).toISOString() })).map((x) => x.id)).toEqual([ids[0]]);
    expect(await d.list({ appliedBefore: '2020-01-01T00:00:00Z' })).toEqual([]);
  });

  test('markLabelled marks an applied decision, which list({ unlabelled }) then leaves out; signalsOf reads many lessons\' signals at once', async () => {
    const [a, b] = [(await d.propose(input())).decision.id, (await d.propose(input({ policyVersion: 2 }))).decision.id];
    expect(await d.markLabelled(a)).toBe(false);
    for (const id of [a, b]) { await d.markApplying(id); await d.markApplied(id, []); }
    expect(await d.markLabelled(a)).toBe(true);
    expect((await d.list({ unlabelled: true })).map((x) => x.id)).toEqual([b]);
    expect((await d.list({})).map((x) => x.id).sort()).toEqual([a, b].sort());
    await lesson('lesson:s1');
    await lesson('lesson:s2');
    await d.upsertSignals([{ lessonId: 'lesson:s1', counts: counts(1), lastServed: null, lastOwnerTouch: null }, { lessonId: 'lesson:s2', counts: counts(2), lastServed: null, lastOwnerTouch: null }]);
    const got = await d.signalsOf(['lesson:s1', 'lesson:s2', 'lesson:none']);
    expect(got.map((x) => [x.lessonId, x.counts.served]).sort()).toEqual([['lesson:s1', 1], ['lesson:s2', 2]]);
    expect(got.find((x) => x.lessonId === 'lesson:s1')).toEqual(await d.signals('lesson:s1'));
    expect(await d.signalsOf([])).toEqual([]);
  });

  test('dependents are the decisions that depend on one, newest first', async () => {
    const base = (await d.propose(input())).decision.id;
    const later = (await d.propose(input({ policyVersion: 2, dependsOn: [base] }))).decision.id;
    const last = (await d.propose(input({ policyVersion: 3, dependsOn: [later, base] }))).decision.id;
    await h.probe.setDecisionCreatedAt([later], '2026-11-01T00:00:00.000Z');
    await h.probe.setDecisionCreatedAt([last], '2026-11-02T00:00:00.000Z');
    expect((await d.dependents(base)).map((x) => x.id)).toEqual([last, later]);
    expect((await d.dependents(later)).map((x) => x.id)).toEqual([last]);
    expect((await d.get(last))!.dependsOn).toEqual([later, base]);
    expect(await d.dependents(last)).toEqual([]);
  });

  test('notes are kept oldest first with their verdict and reason, redacted; a note on no decision is refused', async () => {
    const { decision: { id } } = await d.propose(input());
    const one = await d.addNote(id, { by: 'you', text: `wrong: the token ${SECRET} is not evidence`, verdict: 'disagree', reason: 'wrong_evidence' });
    const two = await d.addNote(id, { by: 'operator:codex', text: 'fine by me' });
    expect(one).toEqual({ id: expect.stringMatching(/^dnote:/), decisionId: id, ts: expect.any(String), by: 'you', text: 'wrong: the token [REDACTED] is not evidence', verdict: 'disagree', reason: 'wrong_evidence' });
    expect(two).toMatchObject({ by: 'operator:codex', text: 'fine by me', verdict: null, reason: null });
    expect(await d.notes(id)).toEqual([one, two]);
    expect(await d.notes('dec:none')).toEqual([]);
    expect(await d.addNote('dec:none', { by: 'you', text: 'x' })).toBeNull();
    expect(await h.probe.count('DecisionNote')).toBe(2);
  });

  test('notes written in the same millisecond come back in the order they were written', async () => {
    const { decision: { id } } = await d.propose(input());
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'));
      const written = [];
      for (let i = 0; i < 6; i++) written.push((await d.addNote(id, { by: 'you', text: `note ${i}` }))!.text);
      expect((await d.notes(id)).map((n) => n.text)).toEqual(written);
    } finally {
      vi.useRealTimers();
    }
  });

  test('twenty notes on one decision at once are all kept, each with its own place in the order', async () => {
    const { decision: { id } } = await d.propose(input());
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => d.addNote(id, { by: 'you', text: `note ${i}` })));
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const notes = await d.notes(id);
    expect(notes.map((n) => n.text).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `note ${i}`).sort());
  });

  test('lesson signals are replaced whole per lesson; a lesson that is gone is skipped', async () => {
    await lesson('lesson:s');
    expect(await d.signals('lesson:s')).toBeNull();
    expect(await d.upsertSignals([{ lessonId: 'lesson:s', counts: counts(1), lastServed: '2026-11-01T00:00:00.000Z', lastOwnerTouch: null }, { lessonId: 'lesson:gone', counts: counts(1), lastServed: null, lastOwnerTouch: null }])).toBe(1);
    expect(await d.signals('lesson:s')).toEqual({ lessonId: 'lesson:s', counts: counts(1), lastServed: '2026-11-01T00:00:00.000Z', lastOwnerTouch: null, updatedAt: expect.any(String) });
    expect(await d.upsertSignals([{ lessonId: 'lesson:s', counts: counts(4), lastServed: null, lastOwnerTouch: '2026-11-02T00:00:00.000Z' }])).toBe(1);
    expect(await d.signals('lesson:s')).toMatchObject({ counts: counts(4), lastServed: null, lastOwnerTouch: '2026-11-02T00:00:00.000Z' });
    expect(await d.signals('lesson:gone')).toBeNull();
    expect(await d.upsertSignals([])).toBe(0);
  });

  test('listSignals lists every lesson\'s signals with the lesson\'s project, source and status, by lesson id', async () => {
    await lesson('lesson:b', 'approved');
    await lesson('lesson:a');
    await h.store.knowledge.upsertLesson({
      id: 'lesson:mine', projectKey: null, title: 'Mine', rule: 'r', appliesWhen: 'a', scope: 'global', paths: [], status: 'approved', source: 'manual', embedding: vec(2),
    });
    await h.store.knowledge.upsertLesson({
      id: 'lesson:other', projectKey: 'other', title: 'Other', rule: 'r', appliesWhen: 'a', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: vec(3),
    });
    await lesson('lesson:none');
    await d.upsertSignals(['lesson:b', 'lesson:a', 'lesson:mine', 'lesson:other'].map((lessonId, i) => ({ lessonId, counts: counts(i), lastServed: null, lastOwnerTouch: null })));
    const all = await d.listSignals();
    expect(all.map((r) => r.lessonId)).toEqual(['lesson:a', 'lesson:b', 'lesson:mine', 'lesson:other']);
    expect(all[1]).toEqual({ lessonId: 'lesson:b', counts: counts(0), lastServed: null, lastOwnerTouch: null, updatedAt: expect.any(String), projectKey: 'demo', source: 'memory', status: 'approved', run: null, sandbox: false });
    expect(all[2]).toMatchObject({ lessonId: 'lesson:mine', counts: counts(2), projectKey: null, source: 'manual' });
    expect(all[0]).toMatchObject({ status: 'proposed' });
    expect((await d.listSignals({ projectKeys: ['demo'] })).map((r) => r.lessonId)).toEqual(['lesson:a', 'lesson:b', 'lesson:mine']);
    expect((await d.listSignals({ projectKeys: [] })).map((r) => r.lessonId)).toEqual(['lesson:mine']);
  });

  test('calibration buckets start from the prior, add labels, count concurrent bumps, and are kept per policy version', async () => {
    const bump = (band: number, alpha: number, beta: number, policyVersion = 1) => d.bumpCalibration({ type: 'approve_lesson', band, policyVersion, prior: { alpha: 1, beta: 4 }, alpha, beta, n: 1 });
    expect(await bump(2, 1, 0)).toEqual({ type: 'approve_lesson', band: 2, policyVersion: 1, alpha: 2, beta: 4, n: 1, updatedAt: expect.any(String) });
    expect(await bump(2, 0, 1)).toMatchObject({ alpha: 2, beta: 5, n: 2 });
    await Promise.all([1, 2, 3, 4].map(() => bump(2, 0.5, 0)));
    await bump(0, 0, 1);
    await bump(2, 1, 0, 2);
    expect((await d.calibration('approve_lesson', 1)).map((c) => [c.band, c.alpha, c.beta, c.n])).toEqual([[0, 1, 5, 1], [2, 4, 5, 6]]);
    expect((await d.calibration('approve_lesson', 2)).map((c) => [c.band, c.alpha, c.n])).toEqual([[2, 2, 1]]);
    expect(await d.calibration('reject_lesson', 1)).toEqual([]);
  });

  test('miss links: one per pair, never to itself or a missing miss, listed from either end, and removable', async () => {
    await misses('miss:a', 'miss:b', 'miss:c');
    expect(await d.linkMisses({ from: 'miss:a', to: 'miss:b', decisionId: 'dec:1' })).toBe(true);
    expect(await d.linkMisses({ from: 'miss:a', to: 'miss:b', decisionId: 'dec:2' })).toBe(false);
    expect(await d.linkMisses({ from: 'miss:a', to: 'miss:a', decisionId: 'dec:3' })).toBe(false);
    expect(await d.linkMisses({ from: 'miss:a', to: 'miss:none', decisionId: 'dec:4' })).toBe(false);
    expect(await d.linkMisses({ from: 'miss:c', to: 'miss:a', decisionId: 'dec:5' })).toBe(true);
    const links = await d.missLinks('miss:a');
    expect(links.map((l) => [l.from, l.to, l.decisionId])).toEqual([['miss:a', 'miss:b', 'dec:1'], ['miss:c', 'miss:a', 'dec:5']]);
    expect(links[0].createdAt).toEqual(expect.any(String));
    expect((await d.missLinks('miss:b')).map((l) => l.from)).toEqual(['miss:a']);
    expect(await d.unlinkMisses({ from: 'miss:b', to: 'miss:a' })).toBe(false);
    expect(await d.unlinkMisses({ from: 'miss:a', to: 'miss:b' })).toBe(true);
    expect(await d.missLinks('miss:b')).toEqual([]);
  });

  test('what a decision carries is redacted before it is stored, the original archived; ids and fingerprints stay', async () => {
    const originals: RedactionOriginal[] = [];
    setRedactionArchive(async (r) => { originals.push(r); });
    const snapshot = { kind: 'lesson' as const, id: 'lesson:x', fields: { rule: `export API_TOKEN=${SECRET}` }, fingerprint: 'b'.repeat(64) };
    const { decision } = await d.propose(input({
      rationale: `the rule quotes ${SECRET}`, model: `ollama:${SECRET}`, before: [snapshot], after: [snapshot],
      evidence: [{ kind: 'activity', id: 'act:1', role: `said ${SECRET}`, weight: 1, observedAt: '2026-11-01T00:00:00.000Z' }],
    }));
    await d.markApplying(decision.id);
    await d.markApplied(decision.id, [snapshot]);
    const dump = JSON.stringify(await h.probe.rows('Decision'));
    expect(dump).not.toContain(SECRET);
    const stored = (await d.get(decision.id))!;
    expect(stored.rationale).toBe('the rule quotes [REDACTED]');
    expect(stored.before).toEqual([{ ...snapshot, fields: { rule: 'export API_TOKEN=[REDACTED]' } }]);
    expect(stored.after).toEqual(stored.before);
    expect(stored.evidence[0]).toMatchObject({ id: 'act:1', role: 'said [REDACTED]' });
    expect(originals.map((o) => o.kind)).toEqual(['decision-incoming', 'decision-after-incoming']);
    expect(JSON.stringify(originals)).toContain(SECRET);
  });

  test('redactStoredDecisions applies the current rules to stored decisions and notes, once', async () => {
    await h.probe.seedStaleText({ kind: 'Decision', id: 'dec:stale', text: `the password is hunter2 ${SECRET}`, note: `use ${SECRET}` });
    await h.probe.seedStaleText({ kind: 'Decision', id: 'dec:clean', text: 'nothing secret', note: 'agreed' });
    const rolled = (await d.propose(input())).decision.id;
    await d.markStatus(rolled, { status: 'rolled_back', from: ['proposed'], rollback: { at: '2026-11-01T00:00:00.000Z', by: 'you', reason: null, note: 'kept', cascade: [] } });
    expect(await d.redactStoredDecisions()).toBe(2);
    const dump = JSON.stringify([await h.probe.rows('Decision'), await h.probe.rows('DecisionNote')]);
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain('nothing secret');
    expect((await d.get('dec:stale'))!.before[0]).toMatchObject({ id: 'lesson:stale', fingerprint: 'f'.repeat(64) });
    expect((await d.notes('dec:stale'))[0].text).toBe('use [REDACTED]');
    expect(await d.redactStoredDecisions()).toBe(0);
  });
});

describeStores('DecisionsStore graph edges', (h) => {
  test('a decision is linked to the records it targets and rests on that exist, to the decisions it depends on, and to a key per target id', async () => {
    const d = h.store.decisions;
    for (const [i, id] of ['miss:a', 'miss:b'].entries()) await h.probe.seedEmbedded({ kind: 'Miss', id, missed: id, causeExplanation: 'c', embedding: vec(i) });
    const base = (await d.propose(input({ policyVersion: 0 }))).decision.id;
    const { decision } = await d.propose(input({ dependsOn: [base, 'dec:gone'], targets: [...input().targets, { kind: 'lesson', id: 'lesson:gone', role: 'merged' }] }));
    await d.propose(input({ dependsOn: [base] })); // a matcher adds nothing
    const rows = await (h.store.graph as GraphRepo).run(
      `MATCH (d:Decision {id: $id})-[r]->(n) RETURN type(r) + ':' + coalesce(r.role, '') + ':' + coalesce(n.id, n.key) AS edge ORDER BY edge`,
      { id: decision.id },
    );
    expect(rows.map((r) => r.get('edge'))).toEqual([
      `DEPENDS_ON::${base}`, 'EVIDENCE:repeat of:miss:b', 'NAMES::lesson:gone', 'NAMES::miss:a', 'NAMES::miss:b', 'TARGETS:keeper:miss:b', 'TARGETS:primary:miss:a',
    ]);
    // forTarget finds it by a target whose record does not exist, through its key.
    expect((await d.forTarget('lesson:gone')).map((x) => x.id)).toEqual([decision.id]);
  });

  test('a label counted before Decision.labelledAt (a loop-kept:<id> cursor) marks its decision on start', async () => {
    const d = h.store.decisions;
    const ids = [(await d.propose(input())).decision.id, (await d.propose(input({ policyVersion: 2 }))).decision.id];
    for (const id of ids) { await d.markApplying(id); await d.markApplied(id, []); }
    await h.store.docs.setCursor(`loop-kept:${ids[0]}`, '2026-11-01T00:00:00.000Z');
    expect((await d.list({ unlabelled: true })).map((x) => x.id).sort()).toEqual([...ids].sort());
    await h.store.ensureSchema();
    expect((await d.list({ unlabelled: true })).map((x) => x.id)).toEqual([ids[1]]);
  });
}, { only: ['neo4j'] });
