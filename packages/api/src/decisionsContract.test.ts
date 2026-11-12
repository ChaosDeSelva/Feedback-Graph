import { DECISION_NOTE_REASONS, DECISION_STATUSES, DECISION_TYPES, LESSON_SIGNAL_COUNTS, LOOP_MODES, LOOP_ROUND_PHASES, writeLoopRound } from '@fb/core';
import { beforeAll, describe, expect, test } from 'vitest';
import { z, type ZodTypeAny } from 'zod';
import { createApp, type ApiRepo } from './app.ts';
import { LOOP_ACTIVITY_KINDS } from './decisions.ts';
import { decision, fakeLoop, snap } from './testing/loop.ts';

/**
 * The REST contract the UI consumes (docs/learning-loop-api.md): the shapes of packages/ui/src/api.ts's learning loop
 * types as strict schemas. The UI's own test fixtures (packages/ui/src/testing/loop.ts) must validate, so the schemas
 * say what the page reads; then every route's answer must validate too, so the API sends exactly that.
 */

// Loaded by path at run time: the UI package is typechecked on its own (DOM types), not as part of the API's.
const UI = '../../ui/src';
type Fixtures = Record<string, any>;
let ui: Fixtures;
let uiApi: Fixtures;
beforeAll(async () => {
  ui = await import(`${UI}/testing/loop.ts`);
  uiApi = await import(`${UI}/api.ts`);
});

const str = z.string();
const num = z.number();
const int = z.number().int();
const nullable = <T extends ZodTypeAny>(t: T) => t.nullable();
const TargetKind = z.enum(['lesson', 'fact', 'miss', 'candidate', 'project']);
const Status = z.enum(DECISION_STATUSES);
const Reason = z.enum(DECISION_NOTE_REASONS);
const Mode = z.enum(LOOP_MODES);
const TargetSnapshot = z.object({ kind: TargetKind, id: str, fields: z.record(z.unknown()), fingerprint: str }).strict();
const EvidenceRef = { kind: z.enum(['activity', 'miss', 'lesson', 'fact', 'check', 'session', 'candidate']), id: str, role: str, weight: num, observedAt: str };
const Decision = z.object({
  id: str, type: z.enum(DECISION_TYPES), projectKey: nullable(str),
  targets: z.array(z.object({ kind: TargetKind, id: str, role: z.enum(['primary', 'keeper', 'merged', 'created']) }).strict()),
  before: z.array(TargetSnapshot), after: z.array(TargetSnapshot), evidence: z.array(z.object(EvidenceRef).strict()),
  features: z.record(num), score: num, confidence: z.object({ p: num, lower: num, n: int, band: int }).strict(),
  tier: z.enum(['H', 'A', 'P']), mode: z.enum(['observe', 'propose', 'auto']), rationale: str, model: nullable(str), policyVersion: int,
  status: Status, dependsOn: z.array(str), supersededBy: str.optional(), createdAt: str, appliedAt: str.optional(), decidedAt: str.optional(),
  decidedBy: str.optional(), rollback: z.object({ at: str, by: str, reason: nullable(Reason), note: nullable(str), cascade: z.array(str) }).strict().optional(),
  ratifiedAt: str.optional(), ratifiedBy: str.optional(), syncHoldUntil: str.optional(),
}).strict();
const DecisionNote = z.object({ id: str, decisionId: str, ts: str, by: str, text: str, verdict: z.enum(['agree', 'disagree']).nullable().optional(), reason: Reason.optional() }).strict();
const Activity = z.object({ id: str, ts: str, kind: str, actor: str, projectKey: nullable(str), subject: str, why: str, details: z.record(z.unknown()), targets: z.array(str) }).passthrough();
const ResolvedEvidence = z.object({ ...EvidenceRef, label: str, projectKey: nullable(str).optional(), path: nullable(str).optional(), activity: nullable(Activity).optional(), missing: z.boolean().optional() }).strict();
const DecisionSummary = z.object({ id: str, type: z.enum(DECISION_TYPES), status: Status, createdAt: str, projectKey: nullable(str), label: str }).strict();
const DecisionDetail = z.object({ decision: Decision, current: z.array(TargetSnapshot), evidence: z.array(ResolvedEvidence), dependsOn: z.array(DecisionSummary), dependents: z.array(DecisionSummary), notes: z.array(DecisionNote) }).strict();
const RollbackPreview = z.object({ cascade: z.array(DecisionSummary), blocked: z.array(z.object({ id: str, reason: str }).strict()) }).strict();
const Rate = z.object({ rolledBack: int, of: int }).strict();
const LoopTypeState = z.object({
  type: z.enum(DECISION_TYPES), tier: z.enum(['H', 'A', 'P']), mode: nullable(Mode), effectiveMode: Mode, tau: num, tauDefault: num,
  calibration: z.object({ p: num, lower: num, n: int }).strict(),
  bands: z.array(z.object({ band: int, alpha: num, beta: num, n: int, p: num, lower: num }).strict()),
  rollbackRate: Rate, breaker: z.object({ tripped: z.boolean(), at: nullable(str), reason: nullable(str) }).strict(),
}).strict();
const LoopRound = z.object({
  id: str, startedAt: str, finishedAt: nullable(str), phase: z.enum(LOOP_ROUND_PHASES), signalsIngested: int, targetsScored: int, targetsTotal: nullable(int),
  decisions: z.object({ observed: int, proposed: int, applied: int, skipped: int }).strict(), skipped: z.array(z.object({ reason: str, count: int }).strict()),
  llmCalls: int, error: nullable(str),
}).strict();
const Arm = z.object({ lessons: int, repeatRate: num, helpfulRate: num, ciLow: num, ciHigh: num }).strict();
const LoopState = z.object({
  mode: Mode, effectiveMode: Mode, disabled: z.boolean(), paused: nullable(z.object({ at: str, by: str }).strict()),
  capped: nullable(z.enum(['tokenless', 'disabled', 'paused'])), policyVersion: int, types: z.array(LoopTypeState),
  budget: z.object({ llmCallsToday: int, llmCallsPerDay: int, autoToday: int, autoPerDay: int, autoPerProject: int }).strict(),
  counts: z.object({ proposed: int, week: z.object({ observed: int, proposed: int, applied: int, rolledBack: int }).strict() }).strict(),
  rollbackRate: Rate, round: nullable(LoopRound), holdout: nullable(z.object({ share: num, treated: Arm, control: Arm }).strict()),
}).strict();
const LoopEvent = z.object({
  seq: str, ts: str, kind: z.enum([...LOOP_ACTIVITY_KINDS, 'loop_round']), actor: str, subject: str,
  decisionId: nullable(str), decisionType: nullable(z.enum(DECISION_TYPES)), status: nullable(Status), projectKey: nullable(str),
}).strict();
const Proportion = z.object({ k: int, n: int, rate: num, ciLow: num, ciHigh: num }).strict();
const LoopMetrics = z.object({
  since: str, weeks: int,
  repeatRate: Proportion.extend({ weekly: z.array(z.object({ week: str, feedback: int, repeats: int }).strict()) }).strict(),
  checksCaughtGap: Proportion, gapsFixedPerServed: Proportion, notApplicableShare: Proportion,
  proposalsPerWeek: z.array(z.object({ week: str, proposals: int }).strict()),
  rollbackRate: z.array(z.object({ type: z.enum(DECISION_TYPES), rolledBack: int, of: int, rate: Proportion }).strict()),
}).strict();
const LoopEventPage = z.object({ events: z.array(LoopEvent), next: str, gap: z.boolean() }).strict();
const TrackRecord = z.object({
  lessonId: str, title: str, projectKey: nullable(str),
  signals: z.object({
    served: int, lastServed: nullable(str), sessions: int, addressed: int, notAddressed: int, notApplicable: int, cannotTell: int,
    gapsFixed: int, repeatServed: int, repeatUnserved: int, ownerPushbackAfter: int, ownerEdits: int, ownerRejects: int, holdout: z.boolean(),
  }).strict(),
  timeline: z.array(z.object({ ts: str, kind: z.enum(['served', 'judged', 'gap_fixed', 'repeat', 'owner', 'decision']), label: str, sessionId: nullable(str), decisionId: nullable(str) }).strict()),
}).strict();

const valid = (schema: ZodTypeAny, value: unknown, what: string) => {
  const r = schema.safeParse(value);
  expect(r.success ? [] : r.error.issues.map((i) => `${what}: ${i.path.join('.')}: ${i.message}`)).toEqual([]);
};

describe("the UI's enums and fixtures are the contract", () => {
  test('the enums the UI knows are the API\'s', () => {
    expect([...uiApi.DECISION_TYPES]).toEqual([...DECISION_TYPES]);
    expect([...uiApi.DECISION_STATUSES]).toEqual([...DECISION_STATUSES]);
    expect([...uiApi.LOOP_MODES]).toEqual([...LOOP_MODES]);
    expect([...uiApi.NOTE_REASONS]).toEqual([...DECISION_NOTE_REASONS]);
    expect([...uiApi.ROUND_PHASES]).toEqual([...LOOP_ROUND_PHASES]);
    expect([...uiApi.LOOP_ACTIVITY_KINDS]).toEqual([...LOOP_ACTIVITY_KINDS]);
    expect(uiApi.DECISION_PAGE).toBe(100);
  });

  test("the UI's fixtures validate", () => {
    for (const d of ui.decisions) valid(Decision, d, d.id);
    for (const d of ui.decisions) valid(DecisionDetail, ui.detail(d), `detail ${d.id}`);
    valid(LoopState, ui.loopState(), 'loopState');
    valid(LoopState, ui.loopState({ round: null, holdout: null, paused: { at: 't', by: 'you' }, capped: 'paused' }), 'loopState paused');
    valid(LoopEventPage, { events: [ui.event(1), ui.event(2, { kind: 'loop_round', decisionId: null, decisionType: null, status: null })], next: '2', gap: false }, 'events');
    valid(TrackRecord, ui.track, 'track');
  });
});

describe("the API's answers validate against the contract", () => {
  const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
  const OWNER = 'contract-owner-token-0123456789abcdef';
  const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true', 'content-type': 'application/json' };

  test('every route, in every shape it answers', async () => {
    const applied = decision('dec:a', { dependsOn: ['dec:p'], evidence: [
      { kind: 'activity', id: 'act:1', role: 'r', weight: 1, observedAt: 't' }, { kind: 'session', id: 'sess-1', role: 'r', weight: 1, observedAt: 't' },
      { kind: 'fact', id: 'fact:1', role: 'r', weight: 1, observedAt: 't' }, { kind: 'check', id: 'c', role: 'r', weight: 1, observedAt: 't' },
      { kind: 'miss', id: 'miss:gone', role: 'r', weight: 1, observedAt: 't' },
    ] });
    const proposed = decision('dec:p', { type: 'approve_lesson', tier: 'A', mode: 'propose', status: 'proposed', appliedAt: null, decidedAt: null, decidedBy: null, model: null, createdAt: '2026-11-08T00:00:00.000Z' });
    const later = decision('dec:later', { type: 'rank_weight', dependsOn: ['dec:a'], createdAt: '2026-11-10T00:00:00.000Z', projectKey: null });
    const loop = fakeLoop({ decisions: [applied, proposed, later], lessons: { 'lesson:1': { id: 'lesson:1', projectKey: 'shop', title: 'T' } as never } });
    loop.record({ kind: 'predone_check', actor: 'judge', projectKey: 'shop', subject: 's', why: 'w', details: { decisionId: 'dec:a', decisionType: 'retire_lesson', status: 'applied', verdicts: [{ lessonId: 'lesson:1', status: 'addressed' }] }, targets: ['lesson:1'] });
    loop.record({ kind: 'decision_applied', actor: 'loop:1', projectKey: 'shop', subject: 's', why: 'w', details: { decisionId: 'dec:a', decisionType: 'retire_lesson', status: 'applied' } });
    loop.snapshots.set('lesson:lesson:1', snap('lesson:1', { title: 'T' }));
    loop.snapshots.set('fact:fact:1', snap('fact:1', { statement: 'S', path: 'a.ts', projectKey: 'shop' }, 'fact'));
    loop.notes.push({ id: 'n', decisionId: 'dec:a', ts: 't', by: 'you', text: 'x', verdict: 'disagree', reason: 'wording' }, { id: 'n2', decisionId: 'dec:a', ts: 't', by: 'you', text: 'y', verdict: null, reason: null });
    loop.cursors.set('loop-breaker:link_misses', JSON.stringify({ tripped: true, at: 't', reason: 'r' }));
    loop.buckets.push({ type: 'retire_lesson', band: 2, policyVersion: 1, alpha: 3, beta: 2, n: 2, updatedAt: 't' });
    await writeLoopRound(loop.deps.cursors, { id: 'round:1', startedAt: 't', finishedAt: null, phase: 'scoring', signalsIngested: 1, targetsScored: 1, targetsTotal: 2, decisions: { observed: 0, proposed: 0, applied: 0, skipped: 1 }, skipped: [{ reason: 'suppressed', count: 1 }], llmCalls: 0, error: null });
    // Enough served lessons that both holdout arms have some.
    for (let i = 0; i < 40; i++) loop.signals.set(`lesson:h${i}`, { lessonId: `lesson:h${i}`, counts: { ...Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, 0])), served: 2, addressed: i % 3 } as never, lastServed: 't', lastOwnerTouch: null, updatedAt: 't' });
    loop.deps.insights = { patterns: async () => ({ weekly: [{ week: '2026-W45', feedback: 4, repeats: 1 }], preDone: { checks: 3, withGaps: 1, gapsFound: 1 } }) as never };
    const app = createApp(repo, { loop: loop.deps, auth: { ownerToken: OWNER } });
    const read = async (path: string) => (await app.request(path, { headers: { authorization: `Bearer ${OWNER}` } })).json();
    const write = async (path: string, body: unknown, method = 'POST') => (await app.request(path, { method, headers: owner, body: JSON.stringify(body) })).json();

    valid(z.array(Decision), await read('/api/decisions'), 'GET /api/decisions');
    valid(DecisionDetail, await read('/api/decisions/dec:a'), 'GET /api/decisions/dec:a');
    valid(DecisionDetail, await read('/api/decisions/dec:p'), 'GET /api/decisions/dec:p');
    const state = await read('/api/loop');
    valid(LoopState, state, 'GET /api/loop');
    expect(state.holdout).toMatchObject({ share: 0.2, treated: { lessons: expect.any(Number) }, control: { lessons: expect.any(Number) } });
    valid(LoopMetrics, await read('/api/loop/metrics'), 'GET /api/loop/metrics');
    const events = await read('/api/loop/events');
    expect(events.events.map((e: { kind: string }) => e.kind)).toEqual(['decision_applied', 'loop_round']);
    valid(LoopEventPage, events, 'GET /api/loop/events');
    valid(LoopEventPage, await read(`/api/loop/events?after=${events.next}`), 'GET /api/loop/events?after');
    valid(TrackRecord, await read('/api/loop/lessons/lesson:1/track'), 'track');
    valid(RollbackPreview, await write('/api/decisions/dec:a/rollback', { expect: 'applied', cascade: 'preview' }), 'rollback preview');
    valid(DecisionNote, await write('/api/decisions/dec:a/notes', { text: 'n', verdict: 'disagree', reason: 'too_broad' }), 'note');
    valid(DecisionNote, await write('/api/decisions/dec:a/notes', { text: 'n' }), 'plain note');
    valid(Decision, await write('/api/decisions/dec:a/keep', { expect: 'applied' }), 'keep');
    valid(Decision, await write('/api/decisions/dec:p/approve', { expect: 'proposed' }), 'approve');
    valid(Decision, await write('/api/decisions/dec:a/rollback', { expect: 'applied', reason: 'wording', note: 'n' }), 'rollback');
    valid(Decision, await write('/api/decisions/dec:later/rollback', { expect: 'applied' }), 'rollback, no reason');
    valid(LoopState, await write('/api/loop/settings', { mode: 'propose', types: { approve_lesson: { tau: 0.95, mode: 'observe' } } }, 'PUT'), 'settings');
    valid(LoopState, await write('/api/loop/pause', {}), 'pause');
    valid(LoopState, await write('/api/loop/resume', {}), 'resume');
    const refused = await write('/api/decisions/dec:a/keep', { expect: 'applied' });
    expect(refused).toEqual({ error: expect.any(String) });
    valid(LoopEventPage, await read('/api/loop/events'), 'GET /api/loop/events after writes');
  });
});
