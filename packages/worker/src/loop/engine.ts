import {
  dependenciesOf, effectiveLoopMode, effectiveTypeMode, inHoldout, isSuppressed, LOOP_ACTOR, LOOP_BREAKER_ACTOR, LOOP_POLICY_VERSION, LOOP_TYPE_INFO, parseSuppression,
  readLoopBreaker, readLoopSettings, redactSecrets, suppressionKey, typeTau, writeLoopBreaker, writeLoopRound,
  type ActivityKind, type ActivityStore, type Decision, type DecisionConfidence, type DecisionInput, type DecisionTarget,
  type DecisionsStore, type DocsStore, type Lesson, type LessonSignals, type LlmProvider, type LoopBreaker, type LoopConfig, type LoopMode, type LoopRound, type LoopSettings,
  type TargetSnapshot,
} from '@fb/core';
import { LoopBudgetGate, LoopBudgetSpent, meteredLlm } from './budget.ts';
import { confidenceOf, foldLabels, labelUntouched } from './calibrate.ts';
import type { LoopExecutor } from './executor.ts';
import { RECHECK_OBSERVED, SKIP, type LoopCandidate, type LoopReads, type LoopType, type LoopTypeContext } from './plugin.ts';
import { readPenalties, score } from './policy.ts';
import { admissible, FOLD_KINDS, LOOP_SESSIONS_CURSOR, pruneSessions, readSessions, SignalFold, type SessionMemory } from './signals.ts';
import { applyTimeVeto } from './types/guards.ts';
import { LOOP_TYPES } from './types/index.ts';

/**
 * One round of the learning loop: read the Activity log on from its cursor and fold it into signals and calibration
 * labels; let each type find its calls; then decide each call by mode, tier and confidence, recording it (observed or
 * proposed), applying it through the executor when it earned that, and logging it in Activity. A store error aborts the
 * round (recorded as aborted) and the next round reads the same entries again: proposing is idempotent (content-addressed
 * ids), the fold is recorded before it is stored (LOOP_FOLD_PENDING) and each owner label once per entry, so nothing is
 * counted twice.
 */

/** Where the loop is in the Activity log: the page it reads (`after`), and the last entry of it already folded. */
export const LOOP_ACTIVITY_CURSOR = 'loop-activity';
type FoldState = { after: string | null; foldedThrough: string | null };
/** Entries per round. A full page means more are waiting: the stage runs the next round soon. */
export const LOOP_PAGE = 500;
/** Entries younger than this are left for the next round, so a write still committing is never skipped. */
export const SETTLE_MS = 5_000;
/**
 * The circuit breaker: two rollbacks within 7 days, or more than 20% of its last 10 applied rolled back (fewer than 5
 * applied count as 5, so one early rollback does not trip it and three of three do).
 */
const BREAKER_DAYS = 7;
const BREAKER_WINDOW = 10;
const BREAKER_MIN = 5;
const BREAKER_RATE = 0.2;
/** Decisions on the same call that are still live: one of these is the call already made. */
const OPEN: Decision['status'][] = ['observed', 'proposed', 'applying', 'applied'];
/** Lessons a round's sweep reads (LoopTypeContext.lessons): every lesson is looked at again within its total / this rounds. */
export const LOOP_SWEEP = 500;
/** The last lesson id the sweep read ('' or none: it starts again from the first). */
export const LOOP_SWEEP_CURSOR = 'loop-lesson-sweep';
/** Where a type's LoopTypeResult.remember values are kept (LoopTypeContext.recall). */
const memoKey = (type: LoopType['type'], key: string) => `loop-memo:${type}:${key}`;
/** Target ids per read of the open decisions on a round's calls, and decisions per page of it. */
const OPEN_CHUNK = 500;
const OPEN_PAGE = 2000;

export type LoopEngineDeps = {
  store: LoopReads & { decisions: DecisionsStore; activity: ActivityStore };
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  config: LoopConfig;
  /** No API_TOKEN and no FG_OWNER_TOKEN: the owner cannot approve or roll back, so the loop observes at most. */
  tokenless: boolean;
  inScope: (projectKey: string | null) => boolean;
  executor: LoopExecutor;
  llm: LlmProvider | null;
  now: () => number;
  log: (msg: string, extra?: object) => void;
  types?: readonly LoopType[];
  pageSize?: number;
};

/** round: the round as recorded (null when the loop is off); more: the page was full, so more entries wait. */
export type LoopRoundResult = { round: LoopRound | null; more: boolean };

type Plan = { type: LoopType; mode: LoopMode; c: LoopCandidate; score: number; confidence: DecisionConfidence };

const iso = (ms: number) => new Date(ms).toISOString();
const sameTargets = (a: DecisionTarget[], b: DecisionTarget[]) =>
  a.map((t) => `${t.kind}:${t.id}:${t.role}`).sort().join('|') === b.map((t) => `${t.kind}:${t.id}:${t.role}`).sort().join('|');
/** The same snapshots (by fingerprint): the targets as they were, or the change they would get. */
const sameSnapshots = (a: TargetSnapshot[], b: TargetSnapshot[]) =>
  a.map((t) => `${t.kind}:${t.id}:${t.fingerprint}`).sort().join('|') === b.map((t) => `${t.kind}:${t.id}:${t.fingerprint}`).sort().join('|');

async function readFoldState(cursors: LoopEngineDeps['cursors']): Promise<FoldState> {
  try {
    const o = JSON.parse((await cursors.getCursor(LOOP_ACTIVITY_CURSOR)) ?? 'null') as Partial<FoldState> | null;
    return { after: typeof o?.after === 'string' ? o.after : null, foldedThrough: typeof o?.foldedThrough === 'string' ? o.foldedThrough : null };
  } catch {
    return { after: null, foldedThrough: null };
  }
}

/**
 * One page's fold as computed (the signals rows as they are to be stored, the session memory, and the last entry it
 * covers), recorded before any of it is stored: a store error part way leaves it here, and the next attempt stores it
 * as it was instead of folding those entries onto counts that already hold some of them. Labels are counted once per
 * entry by their own markers (foldLabels).
 */
const LOOP_FOLD_PENDING = 'loop-fold-pending';
type PendingFold = { after: string | null; through: string; rows: Omit<LessonSignals, 'updatedAt'>[]; sessions: SessionMemory };

async function readPendingFold(cursors: LoopEngineDeps['cursors']): Promise<PendingFold | null> {
  try {
    const o = JSON.parse((await cursors.getCursor(LOOP_FOLD_PENDING)) ?? 'null') as PendingFold | null;
    return o && typeof o.through === 'string' && Array.isArray(o.rows) ? o : null;
  } catch {
    return null;
  }
}

/** Store a fold: its counts (absolute, so storing it twice is storing it once), the sessions, then the cursor past it. */
async function storeFold(d: LoopEngineDeps, f: PendingFold): Promise<void> {
  if (f.rows.length) await d.store.decisions.upsertSignals(f.rows);
  await d.cursors.setCursor(LOOP_SESSIONS_CURSOR, JSON.stringify(f.sessions));
  await d.cursors.setCursor(LOOP_ACTIVITY_CURSOR, JSON.stringify({ after: f.after, foldedThrough: f.through } satisfies FoldState));
  await d.cursors.setCursor(LOOP_FOLD_PENDING, 'null');
}

export async function runLoopRound(d: LoopEngineDeps): Promise<LoopRoundResult> {
  const settings = await readLoopSettings(d.cursors, d.config);
  if (effectiveLoopMode(settings, d.config, { tokenless: d.tokenless }).mode === 'off') return { round: null, more: false };
  const now = d.now();
  const round: LoopRound = {
    id: `round:${iso(now)}`, startedAt: iso(now), finishedAt: null, phase: 'reading', signalsIngested: 0, targetsScored: 0, targetsTotal: null,
    decisions: { observed: 0, proposed: 0, applied: 0, skipped: 0 }, skipped: [], llmCalls: 0, error: null,
  };
  const skipped = new Map<string, number>();
  const skip = (reason: string, n = 1) => { skipped.set(reason, (skipped.get(reason) ?? 0) + n); };
  const gate = new LoopBudgetGate({ cursors: d.cursors, config: d.config, now: d.now });
  const save = () => {
    round.skipped = [...skipped].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    round.decisions.skipped = [...skipped.values()].reduce((a, b) => a + b, 0);
    round.llmCalls = gate.llmCalls;
    return writeLoopRound(d.cursors, round);
  };
  await save();
  try {
    // Reading: the next page, folded from where the last attempt at it stopped.
    const limit = d.pageSize ?? LOOP_PAGE;
    const state = await readFoldState(d.cursors);
    const page = await d.store.activity.since({ after: state.after, kinds: FOLD_KINDS, limit, unlabelled: true, until: iso(now - SETTLE_MS) });
    const upTo = (id: string | null) => (id ? page.entries.findIndex((e) => e.id === id) + 1 : 0);
    let from = upTo(state.foldedThrough);
    const labels = { decisions: d.store.decisions, cursors: d.cursors };
    // A fold an earlier attempt recorded but did not finish storing: stored now as it was folded, never folded again.
    const pending = await readPendingFold(d.cursors);
    if (pending && pending.after === state.after && upTo(pending.through) > from) {
      await foldLabels(page.entries.slice(from, upTo(pending.through)).filter((e) => admissible(e, d.inScope)), labels);
      await storeFold(d, pending);
      from = upTo(pending.through);
    }
    const entries = page.entries.filter((e) => admissible(e, d.inScope));
    const fresh = page.entries.slice(from).filter((e) => admissible(e, d.inScope));
    const fold = new SignalFold({ decisions: d.store.decisions, knowledge: d.store.knowledge, sessions: pruneSessions(await readSessions(d.cursors), now) });
    for (const e of fresh) await fold.fold(e);
    const through = page.entries.at(-1)?.id ?? null;
    if (through && upTo(through) > from) {
      const done: PendingFold = { after: state.after, through, rows: fold.rows(), sessions: fold.sessions };
      await d.cursors.setCursor(LOOP_FOLD_PENDING, JSON.stringify(done));
      await foldLabels(fresh, labels);
      await storeFold(d, done);
    }
    await labelUntouched({ decisions: d.store.decisions, activity: d.store.activity, signals: (id) => fold.get(id), changed: (x) => d.executor.changed(x), now });
    round.signalsIngested = fresh.length;

    // Scoring: each type's calls, scored and calibrated.
    round.phase = 'scoring';
    await save();
    // The lessons changed since the last round: named by this page's entries (the loop's own too: it changed them) or
    // folded; and the sweep's next page. Read once, when a type first asks.
    const changed = new Set([...page.entries.flatMap((e) => e.targets.filter((t) => t.startsWith('lesson:'))), ...fold.rows().map((r) => r.lessonId)]);
    const sweep = { next: undefined as string | undefined };
    let lessons: Promise<Lesson[]> | undefined;
    const ctx: Omit<LoopTypeContext, 'mode' | 'recall'> = {
      now, store: d.store, entries, signals: (id) => fold.get(id), inScope: d.inScope, holdout: d.config.holdout, llm: d.llm && meteredLlm(d.llm, gate), log: d.log,
      lessons: () => (lessons ??= roundLessons(d, fold, changed, sweep)),
    };
    const plans: Plan[] = [];
    // Observed calls whose recheck found they no longer hold, with why: expired as the writing starts.
    const lapsed: { decision: Decision; reason: string }[] = [];
    for (const type of d.types ?? LOOP_TYPES) {
      const breaker = await checkBreaker(d, type.type, now);
      const mode = effectiveTypeMode(type.type, settings, d.config, { tokenless: d.tokenless, breaker });
      if (mode === 'off') continue;
      let found;
      const typeCtx: LoopTypeContext = { ...ctx, mode, recall: (key) => d.cursors.getCursor(memoKey(type.type, key)) };
      try {
        found = await type.candidates(typeCtx);
        for (const [key, value] of Object.entries(found.remember ?? {})) await d.cursors.setCursor(memoKey(type.type, key), value);
        if (mode !== 'observe' && type.recheck) {
          const calls = [...found.candidates];
          found = { ...found, candidates: calls };
          const limit = type.recheckLimit ?? RECHECK_OBSERVED;
          const observed = (await d.store.decisions.list({ type: type.type, status: ['observed'], limit: limit + calls.length }))
            .filter((x) => !calls.some((c) => sameTargets(c.targets, x.targets))).slice(0, limit);
          const again = observed.length ? await type.recheck(typeCtx, observed) : [];
          // The same call (the same change to its targets as they were) moves on; another call is made in its place.
          again.forEach((r, i) => {
            const o = observed[i];
            if (typeof r === 'string') { lapsed.push({ decision: o, reason: r }); return; }
            calls.push(r);
            if (!sameSnapshots(r.before, o.before)) lapsed.push({ decision: o, reason: SKIP.targetChanged });
            else if (!sameSnapshots(r.after, o.after)) lapsed.push({ decision: o, reason: SKIP.noLongerHolds });
          });
        }
      } catch (err) {
        if (!(err instanceof LoopBudgetSpent)) throw err;
        skip(SKIP.budget);
        continue;
      }
      for (const [reason, n] of Object.entries(found.skipped)) skip(reason, n);
      const buckets = await d.store.decisions.calibration(type.type, LOOP_POLICY_VERSION);
      const penalties = await readPenalties(d.cursors, type.type);
      for (const c of found.candidates) {
        // The control group: a call that would change a held-out lesson is not made at all, not even observed.
        if (c.targets.some((t) => t.kind === 'lesson' && inHoldout(t.id, d.config.holdout))) {
          skip(SKIP.holdout);
          continue;
        }
        const s = score(type, c.features, penalties);
        plans.push({ type, mode, c, score: s, confidence: confidenceOf(type.type, s, buckets) });
      }
    }
    round.targetsScored = plans.length;

    // Writing: each call decided and recorded.
    round.phase = 'writing';
    await save();
    for (const { decision, reason } of lapsed) {
      skip(reason);
      await expire(d, decision);
    }
    const open = await openOn(d, plans);
    for (const p of plans) {
      const outcome = await decide(d, p, settings, gate, now, open);
      if (outcome === 'observed' || outcome === 'proposed' || outcome === 'applied') round.decisions[outcome]++;
      else skip(outcome);
    }
    await d.cursors.setCursor(LOOP_ACTIVITY_CURSOR, JSON.stringify({ after: page.next ?? state.after, foldedThrough: null } satisfies FoldState));
    if (sweep.next !== undefined) await d.cursors.setCursor(LOOP_SWEEP_CURSOR, sweep.next);
    round.phase = 'done';
    round.finishedAt = iso(d.now());
    await save();
    return { round, more: page.entries.length >= limit };
  } catch (err) {
    round.phase = 'aborted';
    round.error = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
    round.finishedAt = iso(d.now());
    await save().catch(() => {});
    throw err;
  }
}

/**
 * The round's lessons (LoopTypeContext.lessons): the next LOOP_SWEEP of every lesson by id after the sweep's cursor
 * (sweep.next: where the next round starts; '' after the last page), and the changed ones the page did not hold, their
 * signals read in one go.
 */
async function roundLessons(d: LoopEngineDeps, fold: SignalFold, changed: ReadonlySet<string>, sweep: { next: string | undefined }): Promise<Lesson[]> {
  const after = (await d.cursors.getCursor(LOOP_SWEEP_CURSOR)) ?? '';
  const swept = await d.store.knowledge.listLessons({ afterId: after, limit: LOOP_SWEEP });
  sweep.next = swept.length < LOOP_SWEEP ? '' : swept.at(-1)!.id;
  const have = new Set(swept.map((l) => l.id));
  const rest = [...changed].filter((id) => !have.has(id));
  const out = [...swept];
  for (let i = 0; i < rest.length; i += LOOP_SWEEP) {
    const ids = rest.slice(i, i + LOOP_SWEEP);
    out.push(...await d.store.knowledge.listLessons({ ids, limit: ids.length }));
  }
  await fold.prefetch(out.map((l) => l.id));
  return out;
}

/**
 * The decisions still open on each call's first target, read for all the round's calls at once (a few reads, not one
 * per call): what decide checks for the call already made.
 */
async function openOn(d: LoopEngineDeps, plans: readonly Plan[]): Promise<Map<string, Decision[]>> {
  const ids = [...new Set(plans.map((p) => p.c.targets[0].id))];
  const out = new Map<string, Decision[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += OPEN_CHUNK) {
    const targets = ids.slice(i, i + OPEN_CHUNK);
    for (let offset = 0; ; offset += OPEN_PAGE) {
      const rows = await d.store.decisions.list({ targets, status: OPEN, limit: OPEN_PAGE, offset });
      for (const x of rows) for (const id of new Set(x.targets.map((t) => t.id))) out.get(id)?.push(x);
      if (rows.length < OPEN_PAGE) break;
    }
  }
  return out;
}

/** What happened to one call: a decision recorded or applied, or why none was. */
type Outcome = 'observed' | 'proposed' | 'applied' | string;

/**
 * open: the decisions still open on calls' first targets (openOn), as the round began. A target's are used once: a
 * later call on it this round reads them again, as decided since.
 */
async function decide(d: LoopEngineDeps, p: Plan, settings: LoopSettings, gate: LoopBudgetGate, now: number, open: Map<string, Decision[]>): Promise<Outcome> {
  const { c, type } = p;
  const info = LOOP_TYPE_INFO[type.type];
  const suppression = parseSuppression(await d.cursors.getCursor(suppressionKey(type.type, c.targets)));
  if (isSuppressed(suppression, c.evidence.length, now)) return SKIP.suppressed;
  const first = c.targets[0].id;
  const known = open.get(first);
  open.delete(first);
  const live = (known ?? (await d.store.decisions.forTarget(first)).filter((x) => OPEN.includes(x.status)))
    .filter((x) => x.type === type.type && sameTargets(x.targets, c.targets));
  // The same call (on the targets as they are now) is already on record. One only observed, now that the type proposes
  // or applies, moves on from there. An applied one is history, not the same call: the targets are as this call finds
  // them because later decisions brought them back (rank_weight stepping back to a weight it stepped from).
  const same = live.filter((x) => x.status !== 'applied' && sameSnapshots(x.before, c.before));
  if (same.length) {
    const observed = same.find((x) => x.status === 'observed');
    return observed && p.mode !== 'observe' ? advance(d, p, observed, (await gateAction(d, p, settings, gate, now)).action, gate) : SKIP.alreadyDecided;
  }
  // One only observed on the targets as they were: applying it would find them changed. It is expired, and this call
  // made in its place. One proposed waits for the owner.
  for (const x of live) if (x.status === 'observed') await expire(d, x);
  if (live.some((x) => x.status === 'proposed' || x.status === 'applying')) return SKIP.alreadyDecided;
  const { action, why } = await gateAction(d, p, settings, gate, now);
  const proposeOnly = c.proposeOnly ?? why;
  // Builds on every applied decision that left a target as this call finds it, whatever its type: a rollback of that
  // one undoes this one first (the cascade), instead of finding its target changed.
  const dependsOn = [...new Set([...(c.dependsOn ?? []), ...(await dependenciesOf(d.store, c.before))])].sort();
  const input: DecisionInput = {
    type: type.type, projectKey: c.projectKey, targets: c.targets, before: c.before, after: c.after, evidence: c.evidence, features: c.features,
    score: p.score, confidence: p.confidence, tier: info.tier, mode: action === 'apply' ? 'auto' : action, model: c.model ?? 'deterministic',
    rationale: proposeOnly ? `${c.rationale} Proposed rather than applied: ${proposeOnly}.` : c.rationale,
    policyVersion: LOOP_POLICY_VERSION, status: action === 'observe' ? 'observed' : 'proposed', dependsOn,
  };
  const { decision, created } = await d.store.decisions.propose(input);
  if (!created) {
    // An observed call the loop expired that holds again, on its targets as they were then (the id says so): observed
    // again, and moved on.
    if (decision.status !== 'expired') return SKIP.alreadyDecided;
    const call = { mode: 'observe' as const, score: p.score, confidence: p.confidence };
    if (!(await d.store.decisions.markStatus(decision.id, { status: 'observed', from: ['expired'], by: LOOP_ACTOR, call }))) return SKIP.alreadyDecided;
    const observed: Decision = { ...decision, status: 'observed', ...call };
    if (action !== 'observe') return advance(d, p, observed, action, gate);
    await record(d, 'decision_made', observed, 'observed', 'observed', c.subject);
    return 'observed';
  }
  if (action !== 'apply') {
    await record(d, 'decision_made', decision, action === 'observe' ? 'observed' : 'proposed', decision.status, c.subject);
    return decision.status;
  }
  return apply(d, decision, c.subject, { score: p.score, confidence: p.confidence }, gate);
}

const CAPPED = 'the day\'s cap on agent-facing changes applied on their own is reached';

/**
 * observe, propose, or apply on its own: the mode; then the tier's bar (τ, raised for this call by tauRaise, on the
 * calibrated lower bound, with the owner labels the type needs); then the never-target and owner-touched rules on the
 * targets as they are now (why: the reason it is proposed instead); then, for tier A, room under the day's caps (the
 * slot itself is taken just before the apply, so a call that is not applied never uses one).
 */
async function gateAction(d: LoopEngineDeps, p: Plan, settings: LoopSettings, gate: LoopBudgetGate, now: number): Promise<{ action: 'observe' | 'propose' | 'apply'; why?: string }> {
  const info = LOOP_TYPE_INFO[p.type.type];
  if (p.mode === 'observe') return { action: 'observe' };
  if (p.mode === 'propose' || info.tier === 'P' || p.c.proposeOnly) return { action: 'propose' };
  if (p.confidence.lower < typeTau(p.type.type, settings) + Math.max(0, p.c.tauRaise ?? 0) || p.confidence.n < info.minLabels) return { action: 'propose' };
  const veto = await applyTimeVeto(d.store, p.c.targets, now);
  if (veto) return { action: 'propose', why: veto };
  if (info.tier === 'A' && !(await gate.hasAuto(p.c.projectKey))) return { action: 'propose', why: CAPPED };
  return { action: 'apply' };
}

/**
 * The call made again on a decision an earlier round only observed: it is recorded with the mode, score and confidence
 * it is made with now, so a decision the loop applies or proposes never reads as only observed. action: gateAction's,
 * outside observe (all but apply proposes).
 */
async function advance(d: LoopEngineDeps, p: Plan, observed: Decision, action: 'observe' | 'propose' | 'apply', gate: LoopBudgetGate): Promise<Outcome> {
  const call = { score: p.score, confidence: p.confidence };
  if (action === 'apply') return apply(d, observed, p.c.subject, call, gate);
  if (!(await d.store.decisions.markStatus(observed.id, { status: 'proposed', from: ['observed'], by: LOOP_ACTOR, call: { mode: 'propose', ...call } }))) return SKIP.alreadyDecided;
  await record(d, 'decision_made', observed, 'proposed', 'proposed', p.c.subject);
  return 'proposed';
}

/**
 * An observed call that no longer holds: expired (by the loop), so it is not measured again round after round. The
 * same call made again later, on its targets as they were, is observed again (decide).
 */
async function expire(d: LoopEngineDeps, observed: Decision): Promise<boolean> {
  return d.store.decisions.markStatus(observed.id, { status: 'expired', from: ['observed'], by: LOOP_ACTOR });
}

type Call = Pick<Decision, 'score' | 'confidence'>;

/**
 * Apply through the executor, unless the loop was paused (or its mode lowered) since the round began. call: the
 * decision's score and confidence this round; its mode is set to what happened (auto when applied, propose when it waits).
 */
async function apply(d: LoopEngineDeps, decision: Decision, subject: string, call: Call, gate: LoopBudgetGate): Promise<Outcome> {
  const settings = await readLoopSettings(d.cursors, d.config);
  const breaker = await readLoopBreaker(d.cursors, decision.type);
  const { status } = decision;
  const paused = effectiveTypeMode(decision.type, settings, d.config, { tokenless: d.tokenless, breaker }) !== 'auto';
  // Tier A takes its slot of the day's caps now, as it applies; one taken by another call meanwhile leaves it proposed.
  const capped = !paused && decision.tier === 'A' && !(await gate.reserveAuto(decision.projectKey));
  if (paused || capped) {
    // One observed in an earlier round stays observed: nothing new was decided.
    if (status === 'observed') return paused ? SKIP.paused : SKIP.cap;
    if (!(await d.store.decisions.markStatus(decision.id, { status, from: [status], call: { mode: 'propose', ...call } }))) return SKIP.alreadyDecided;
    await record(d, 'decision_made', decision, 'proposed', status, capped ? `${subject} (${CAPPED})` : subject);
    return status;
  }
  const refund = () => (decision.tier === 'A' ? gate.refundAuto(decision.projectKey) : undefined);
  if (decision.mode !== 'auto' && !(await d.store.decisions.markStatus(decision.id, { status, from: [status], call: { mode: 'auto', ...call } }))) {
    await refund();
    return SKIP.alreadyDecided;
  }
  const touchesAgents = decision.targets.some((t) => t.kind === 'lesson' || t.kind === 'fact');
  const syncHoldUntil = touchesAgents ? iso(d.now() + d.config.syncHoldDays * 86_400_000) : null;
  const r = await d.executor.apply(decision, { by: LOOP_ACTOR, syncHoldUntil }).catch(async (error: unknown) => {
    await refund();
    throw error;
  });
  if (r.status !== 'applied') await refund();
  if (r.status === 'lost') return SKIP.alreadyDecided;
  if (r.status === 'changed') {
    await record(d, 'decision_made', decision, 'overridden', 'overridden', `${subject} (not applied: ${r.reason})`);
    return SKIP.targetChanged;
  }
  await record(d, 'decision_applied', r.decision, 'applied', 'applied', subject);
  return 'applied';
}

async function record(d: LoopEngineDeps, kind: ActivityKind, dec: Decision, action: string, status: Decision['status'], subject: string) {
  await d.store.activity.record({
    kind, actor: LOOP_ACTOR, projectKey: dec.projectKey,
    subject: `${dec.type.replace('_', ' ')} ${action}: ${subject}`.slice(0, 300),
    why: dec.rationale,
    details: { decisionId: dec.id, decisionType: dec.type, status, action, tier: dec.tier, confidence: dec.confidence },
    targets: [dec.id, ...dec.targets.map((t) => t.id)],
  });
}

/**
 * The breaker for this type, tripped now when its rollbacks say so: it then holds the type at propose until the owner
 * sets its mode again, logged as a settings change by loop:breaker.
 */
export async function checkBreaker(d: Pick<LoopEngineDeps, 'store' | 'cursors'>, type: LoopType['type'], now: number): Promise<LoopBreaker> {
  const b = await readLoopBreaker(d.cursors, type);
  if (b.tripped) return b;
  // Since the owner last reset it: what tripped it before does not trip it again.
  const reset = b.at ?? '';
  const window = iso(now - BREAKER_DAYS * 86_400_000);
  const since = window > reset ? window : reset;
  // Rollbacks by when they were made, whenever the decisions were (a rollback is its decision's last change by someone,
  // so decidedSince finds every one in the window), and the rate over the last applied, by when they were applied.
  // A cascade is one rollback, of its root, against the root's type: its dependents count for none.
  const rolled = await d.store.decisions.list({ type, status: ['rolled_back'], decidedSince: since, limit: 50 });
  const burst = (await ownRollbacks(d, rolled.filter((x) => (x.rollback?.at ?? '') > since))).length;
  const last = await d.store.decisions.list({ type, status: ['applied', 'rolled_back', 'overridden'], order: 'applied', ...(b.at && { appliedSince: b.at }), limit: BREAKER_WINDOW });
  const undone = (await ownRollbacks(d, last.filter((x) => x.status === 'rolled_back'))).length;
  const reason = burst >= 2 ? `${burst} rollbacks in ${BREAKER_DAYS} days`
    : undone / Math.max(last.length, BREAKER_MIN) > BREAKER_RATE ? `${undone} of its last ${last.length} applied decisions rolled back` : null;
  if (!reason) return b;
  const tripped: LoopBreaker = { tripped: true, at: iso(now), reason };
  await writeLoopBreaker(d.cursors, type, tripped);
  await d.store.activity.record({
    kind: 'loop_settings_changed', actor: LOOP_BREAKER_ACTOR, projectKey: null,
    subject: `${type.replace('_', ' ')} held at propose: ${reason}`,
    why: 'the circuit breaker: the owner rolled back too many of its decisions; set its mode again in Settings to turn it back on',
    details: { decisionType: type, breaker: tripped, mode: 'propose' },
    targets: [],
  });
  return tripped;
}

/**
 * The rolled-back decisions that were rolled back themselves, not undone by a cascade from a decision they depend on:
 * a cascade marks every decision it undoes with the same rollback time (rollbackDecision), as the owner's labels leave
 * a cascaded one out (calibrate.ts ownerLabel).
 */
async function ownRollbacks(d: Pick<LoopEngineDeps, 'store'>, rolled: readonly Decision[]): Promise<Decision[]> {
  const out: Decision[] = [];
  for (const x of rolled) {
    const on = await Promise.all(x.dependsOn.map((id) => d.store.decisions.get(id)));
    if (!on.some((p) => p?.rollback && p.rollback.at === x.rollback?.at)) out.push(x);
  }
  return out;
}
