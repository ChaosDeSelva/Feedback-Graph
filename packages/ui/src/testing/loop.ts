import type { Decision, DecisionDetail, LoopEvent, LoopMetrics, LoopState, LoopTypeState, Rate, TrackRecord } from '../api.ts';

/** Learning loop records for the UI's tests and the browser checks: one of each status, a state, events and a track record. */

const snap = (id: string, fields: Record<string, unknown>) => ({ kind: 'lesson' as const, id, fields, fingerprint: `fp:${id}:${JSON.stringify(fields).length}` });

export function decision(id: string, o: Partial<Decision> = {}): Decision {
  return {
    id,
    type: 'retire_lesson',
    projectKey: 'demo-shop',
    targets: [{ kind: 'lesson', id: 'lesson:demo-shop:1', role: 'primary' }],
    before: [snap('lesson:demo-shop:1', { status: 'approved', title: 'Validate cart totals on the server', decidedBy: 'you' })],
    after: [snap('lesson:demo-shop:1', { status: 'revoked', title: 'Validate cart totals on the server', decidedBy: 'loop:1' })],
    evidence: [{ kind: 'activity', id: 'act:1', role: 'verdict not_applicable', weight: 0.6, observedAt: '2026-11-09T10:00:00Z' }],
    features: { notApplicableShare: 0.86, served: 22 },
    score: 0.91,
    confidence: { p: 0.93, lower: 0.9, n: 34, band: 4 },
    tier: 'H',
    mode: 'auto',
    rationale: 'Served 22 times with no gap caught; 86% of verdicts said it did not apply.',
    model: null,
    policyVersion: 1,
    status: 'applied',
    dependsOn: [],
    createdAt: '2026-11-09T12:00:00Z',
    appliedAt: '2026-11-09T12:00:01Z',
    decidedAt: '2026-11-09T12:00:01Z',
    decidedBy: 'loop:1',
    ...o,
  };
}

export const decisions: Decision[] = [
  decision('dec:proposed', { type: 'approve_lesson', status: 'proposed', tier: 'A', mode: 'propose', decidedBy: undefined, decidedAt: undefined, appliedAt: undefined, confidence: { p: 0.71, lower: 0.52, n: 12, band: 2 }, rationale: 'The miss repeated twice in checkout and the owner confirmed it.', model: 'ollama:gemma4' }),
  decision('dec:applied'),
  decision('dec:observed', { type: 'link_misses', status: 'observed', mode: 'observe', targets: [{ kind: 'miss', id: 'miss:fb:2', role: 'primary' }, { kind: 'miss', id: 'miss:fb:3', role: 'merged' }], before: [], after: [], decidedBy: undefined, rationale: 'Two misses with cosine 0.93 that edited the same file.' }),
  decision('dec:rolled', { status: 'rolled_back', rollback: { at: '2026-11-10T08:00:00Z', by: 'you', reason: 'too_broad', note: 'still useful in checkout', cascade: ['dec:later'] } }),
  decision('dec:over', { type: 'reword_lesson', status: 'overridden', tier: 'A' }),
];

export function detail(d: Decision, o: Partial<DecisionDetail> = {}): DecisionDetail {
  return {
    decision: d,
    current: d.after.map((s) => ({ ...s, fields: d.status === 'overridden' ? { ...s.fields, title: 'Validate totals server-side (edited by you)' } : s.fields })),
    evidence: [
      { ...d.evidence[0], label: 'pre-done check: not applicable', activity: { id: 'act:1', ts: '2026-11-09T10:00:00Z', kind: 'predone_check', actor: 'claude-code', projectKey: 'demo-shop', subject: 'checked 3 lessons', why: 'agent finished', details: {}, targets: [] } },
      { kind: 'lesson', id: 'lesson:demo-shop:1', role: 'target', weight: 1, observedAt: '2026-11-09T10:00:00Z', label: 'Validate cart totals on the server' },
      { kind: 'session', id: 'sess-1', role: 'served in', weight: 0.2, observedAt: '2026-11-09T09:00:00Z', label: 'Refactor checkout' },
      { kind: 'miss', id: 'miss:fb:2', role: 'repeat of', weight: 0.5, observedAt: '2026-11-08T09:00:00Z', label: 'missed the server check' },
      { kind: 'fact', id: 'fact:1', role: 'cited', weight: 0.1, observedAt: '2026-11-08T09:00:00Z', label: 'Totals live in cart.ts', projectKey: 'demo-shop', path: 'src/cart.ts' },
      { kind: 'check', id: 'check:9', role: 'judge', weight: 0.1, observedAt: '2026-11-08T09:00:00Z', label: 'judge said generic', missing: true },
    ],
    dependsOn: [],
    // Labelled as the API's summaryOf writes it: the type's id in words.
    dependents: [{ id: 'dec:later', type: 'rank_weight', status: 'applied', createdAt: '2026-11-10T00:00:00Z', projectKey: 'demo-shop', label: 'rank weight · lesson:demo-shop:2' }],
    notes: [{ id: 'dnote:1', decisionId: d.id, ts: '2026-11-10T09:00:00Z', by: 'you', text: 'Right call for this one.', verdict: 'agree' }],
    ...o,
  };
}

const type = (t: LoopTypeState['type'], o: Partial<LoopTypeState> = {}): LoopTypeState => ({
  type: t, tier: 'H', mode: null, effectiveMode: 'auto', tau: 0.85, tauDefault: 0.85,
  calibration: { p: 0.9, lower: 0.82, n: 40 },
  bands: [0, 1, 2, 3, 4].map((band) => ({ band, alpha: 4 + band, beta: 1, n: 8, p: 0.8, lower: 0.6 })),
  rollbackRate: { rolledBack: 1, of: 10 },
  breaker: { tripped: false, at: null, reason: null },
  ...o,
});

export function loopState(o: Partial<LoopState> = {}): LoopState {
  return {
    mode: 'auto',
    effectiveMode: 'auto',
    disabled: false,
    paused: null,
    capped: null,
    policyVersion: 1,
    types: [
      type('retire_lesson'),
      type('approve_lesson', { tier: 'A', tau: 0.92, tauDefault: 0.9, calibration: { p: 0.62, lower: 0.41, n: 12 }, effectiveMode: 'propose', mode: 'propose', bands: [] }),
      type('merge_duplicates', { breaker: { tripped: true, at: '2026-11-08T00:00:00Z', reason: '2 rollbacks in 7 days' }, effectiveMode: 'propose', rollbackRate: { rolledBack: 0, of: 0 } }),
    ],
    budget: { llmCallsToday: 7, llmCallsPerDay: 40, autoToday: 1, autoPerDay: 5, autoPerProject: 2 },
    counts: { proposed: 3, week: { observed: 4, proposed: 5, applied: 9, rolledBack: 1 } },
    rollbackRate: { rolledBack: 1, of: 12 },
    round: {
      id: 'round:42', startedAt: '2026-11-10T09:59:00Z', finishedAt: null, phase: 'scoring', signalsIngested: 120, targetsScored: 30, targetsTotal: 60,
      decisions: { observed: 2, proposed: 1, applied: 1, skipped: 3 }, skipped: [{ reason: 'owner_touched', count: 2 }, { reason: 'suppressed', count: 1 }], llmCalls: 2, error: null,
    },
    holdout: { share: 0.2, treated: { lessons: 40, repeatRate: 0.05, helpfulRate: 0.4, ciLow: 0.28, ciHigh: 0.53 }, control: { lessons: 10, repeatRate: 0.1, helpfulRate: 0.3, ciLow: 0.1, ciHigh: 0.6 } },
    ...o,
  };
}

export const event = (seq: number, o: Partial<LoopEvent> = {}): LoopEvent => ({
  seq: String(seq), ts: '2026-11-10T10:00:00Z', kind: 'decision_applied', actor: 'loop:1', subject: `retired lesson ${seq}`,
  decisionId: 'dec:applied', decisionType: 'retire_lesson', status: 'applied', projectKey: 'demo-shop', ...o,
});

export const track: TrackRecord = {
  lessonId: 'lesson:demo-shop:1',
  title: 'Validate cart totals on the server',
  projectKey: 'demo-shop',
  signals: { served: 22, lastServed: '2026-11-09T10:00:00Z', sessions: 9, addressed: 1, notAddressed: 0, notApplicable: 12, cannotTell: 1, gapsFixed: 0, repeatServed: 0, repeatUnserved: 0, ownerPushbackAfter: 0, ownerEdits: 0, ownerRejects: 0, holdout: false },
  timeline: [
    { ts: '2026-11-09T12:00:00Z', kind: 'decision', label: 'retired by the loop', sessionId: null, decisionId: 'dec:applied' },
    { ts: '2026-11-09T10:00:00Z', kind: 'judged', label: 'not applicable', sessionId: 'sess-1', decisionId: null },
  ],
};

const rate = (k: number, n: number, ciLow: number, ciHigh: number): Rate => ({ k, n, rate: n ? k / n : 0, ciLow, ciHigh });
const weeks = ['2026-W39', '2026-W40', '2026-W41', '2026-W42', '2026-W43', '2026-W44', '2026-W45', '2026-W46'];

/** GET /api/loop/metrics over 8 weeks, with something in every measure; `empty` before anything was measured. */
export function loopMetrics(empty = false): LoopMetrics {
  const z = empty ? 0 : 1;
  return {
    since: weeks[0], weeks: 8,
    repeatRate: { ...rate(3 * z, 25 * z, 0.04 * z, empty ? 1 : 0.3), weekly: empty ? [] : [{ week: weeks[2], feedback: 3, repeats: 0 }, { week: weeks[6], feedback: 2, repeats: 2 }] },
    checksCaughtGap: rate(2 * z, 8 * z, 0.07 * z, empty ? 1 : 0.59),
    gapsFixedPerServed: rate(1 * z, 40 * z, 0.004 * z, empty ? 1 : 0.13),
    notApplicableShare: rate(12 * z, 30 * z, 0.25 * z, empty ? 1 : 0.58),
    proposalsPerWeek: weeks.map((week, i) => ({ week, proposals: (i > 4 ? i - 4 : 0) * z })),
    rollbackRate: [
      { type: 'retire_lesson', rolledBack: 1 * z, of: 10 * z, rate: rate(1 * z, 10 * z, 0.02 * z, empty ? 1 : 0.4) },
      { type: 'link_misses', rolledBack: 0, of: 0, rate: rate(0, 0, 0, 1) },
    ],
  };
}
