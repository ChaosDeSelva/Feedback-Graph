import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  ABSENT, betaSummary, DECISION_MODES, redactSecrets, type DecisionNoteInput, IsoInstant, DECISION_NOTE_REASONS, DECISION_STATUSES, DECISION_TYPES, LOOP_DECISION_TYPES, type LoopDecisionType, effectiveLoopMode, effectiveTypeMode, LOOP_ACTOR,
  LOOP_BANDS, LOOP_MODES, LOOP_POLICY_VERSION, LOOP_ROUNDS_KEPT, LOOP_TYPE_INFO, readLoopBreaker, readLoopBudget, readLoopRound, readLoopRounds,
  readLoopSettings, needsYouReason, loopHoldout, lessonHeldOut, readLoopMetrics, REPEAT_SIMILARITY, resetLoopBreaker, TargetChangedError, typeTau, writeLoopSettings, CascadeBlockedError, DecisionStateError, UnsupportedTargetError,
  type CascadePlan, type DecisionExecutor, type RollbackOptions,
  type Activity, type ActivityKind, type ActivityStore, type Decision, type DecisionCount, type DecisionKey, type DecisionNote, type DecisionsStore,
  type DecisionStatus, type DecisionType, type DocsStore, type EvidenceRef, type InsightsStore, type KnowledgeStore, type LoopConfig,
  type LoopRound, type LoopSettings, type PatternReport, type SessionsStore, type ShownProjects, type TargetSnapshot,
} from '@fb/core';
import { actingAsOperator, currentActor } from './operator.ts';
import { pageByScore, scorer, SortQuery, type Scorer } from './scores.ts';

/**
 * The learning loop's REST routes (docs/learning-loop-api.md): its decisions as the audit log, the owner's verdicts on
 * them (approve, reject, keep, roll back, notes), its state and settings, the live event stream and a lesson's track
 * record. Writes are owner routes (OWNER_ROUTES: loop_decide, loop_settings). Applying and rolling back a decision is
 * the executor's (decisionExecutor in core); these routes check what the page saw (`expect`), call it, and record the
 * owner's Activity entries, which the loop folds into its calibration.
 */

export type LoopDeps = {
  decisions: Pick<DecisionsStore, 'get' | 'list' | 'count' | 'forTarget' | 'loopChanged' | 'markStatus' | 'ratify' | 'addNote' | 'notes' | 'dependents' | 'signals' | 'calibration' | 'listSignals' | 'markDistinct' | 'liftDistinct' | 'distinctPairs'> & Partial<Pick<DecisionsStore, 'propose'>>;
  /** The feedback patterns GET /api/loop/metrics reads its repeat rate from. Unset: that route answers 404. */
  insights?: Pick<InsightsStore, 'patterns'>;
  /** Where the loop's settings, budget, breakers and rounds are kept (loop/state.ts). */
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  activity: Pick<ActivityStore, 'record' | 'since' | 'list' | 'get'>;
  /** config.loop. */
  config: LoopConfig;
  /** decisionExecutor (core decisions/*): applies, rolls back and reads targets; writes no Activity. Unset: approve and rollback answer 501. */
  exec?: Pick<DecisionExecutor, 'apply' | 'rollback' | 'snapshot' | 'current' | 'changed'>;
  /** A lesson's title and project, for its track record. */
  lessonDetail: KnowledgeStore['lessonDetail'];
  /** A session's goal, for evidence that points at one. */
  sessionDetail?: SessionsStore['detail'];
  /** The later misses that repeat a lesson's own miss (lessonRepeats), for its track record. Unset: none shown. */
  repeats?: (lessonId: string) => Promise<RepeatMiss[]>;
  now?: () => number;
};

/** A later miss that repeats a lesson's own miss: what the loop's signals count as repeatServed / repeatUnserved. */
export type RepeatMiss = { missId: string; missed: string; sessionId: string | null; ts: string };

/**
 * The misses after a lesson's own (miss:<id> for lesson:<id>) at cosine ≥ REPEAT_SIMILARITY among its k nearest: the
 * rule the worker's signals fold (loop/signals.ts), read here per lesson for its timeline. Demo and run data are not
 * repeats (run: null), as there.
 */
export async function lessonRepeats(
  lessonId: string,
  d: { loopMisses: DecisionsStore['loopMisses']; relatedMisses: KnowledgeStore['relatedMisses'] },
  k = 10,
): Promise<RepeatMiss[]> {
  const [own] = await d.loopMisses([`miss:${lessonId.slice('lesson:'.length)}`]);
  if (!own?.embedding) return [];
  const near = await d.relatedMisses({ embedding: own.embedding, projectKey: own.projectKey, k, run: null });
  const close = near.filter((m) => m.missId !== own.id && m.score >= REPEAT_SIMILARITY).map((m) => m.missId);
  // Ordered by when each miss was recorded, as the signals are: a turn's time says when it was said, not when it was learned.
  const later = close.length ? (await d.loopMisses(close)).filter((m) => m.createdAt > own.createdAt) : [];
  return later.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((m) => ({ missId: m.id, missed: m.missed, sessionId: m.sessionId, ts: m.createdAt }));
}

/**
 * After an owner's own write to lessons, facts or Inbox items (an edit, revoke or reject, a fact's relevance, an Inbox
 * decision): every applied decision on those targets that the write changed (executor.changed) is overridden, by them,
 * and logged, so its sync hold no longer holds the target back and the loop folds it as the owner's negative label; and
 * every call still observed or proposed on them whose targets are no longer as it found them (a triage_inbox proposal
 * for the item you just decided) is expired, so it does not wait for an approve that could only fail. Without an
 * executor, nothing.
 */
export function ownerOverrides(d: Pick<LoopDeps, 'decisions' | 'activity' | 'exec'>): (targetIds: string[]) => Promise<void> {
  return async (targetIds) => {
    if (!d.exec) return;
    const by = currentActor();
    const seen = new Set<string>();
    const expired: Decision[] = [];
    for (const id of targetIds) {
      for (const dec of await d.decisions.forTarget(id)) {
        if (seen.has(dec.id)) continue;
        seen.add(dec.id);
        if (dec.status === 'observed' || dec.status === 'proposed') {
          const now = await d.exec.current(dec);
          const stale = dec.before.some((b) => (now.find((n) => n.kind === b.kind && n.id === b.id)?.fingerprint ?? ABSENT) !== b.fingerprint);
          if (stale && (await d.decisions.markStatus(dec.id, { status: 'expired', from: [dec.status], by }))) expired.push(dec);
          continue;
        }
        if (dec.status !== 'applied') continue;
        const why = await d.exec.changed(dec);
        if (why === null || !(await d.decisions.markStatus(dec.id, { status: 'overridden', from: ['applied'], by }))) continue;
        await d.activity.record({
          kind: 'decision_made', actor: 'you', projectKey: dec.projectKey, subject: `${dec.type.replace('_', ' ')} overridden: ${why}`.slice(0, 300),
          why: 'you changed its target since it was applied', details: { decisionId: dec.id, decisionType: dec.type, status: 'overridden', action: 'overridden' },
          targets: [dec.id, ...dec.targets.map((t) => t.id)],
        });
      }
    }
    if (!expired.length) return;
    // One line for what one change of yours expired, however many proposals waited on it (deciding lessons by hand
    // expired 22 at once with no notice): the Decisions page counts these lines (action expired_by_you).
    const n = expired.length;
    const projects = [...new Set(expired.map((x) => x.projectKey))];
    await d.activity.record({
      kind: 'decision_made', actor: 'you', projectKey: projects.length === 1 ? projects[0] : null,
      subject: n === 1
        ? `${expired[0].type.replace('_', ' ')} expired: you changed its target yourself`
        : `${n} waiting loop proposals expired: you changed their targets yourself`,
      why: 'you decided what they would have changed before deciding them, so they no longer apply',
      details: {
        status: 'expired', action: 'expired_by_you', expired: n, decisions: expired.slice(0, EXPIRED_LISTED).map((x) => ({ id: x.id, type: x.type })),
        ...(n === 1 && { decisionId: expired[0].id, decisionType: expired[0].type }),
      },
      targets: expired.slice(0, EXPIRED_LISTED).flatMap((x) => [x.id, ...x.targets.map((t) => t.id)]),
    });
  };
}

/** The expired decisions an expired_by_you Activity line names (and targets): the count is always whole. */
const EXPIRED_LISTED = 25;

/**
 * createApp's part: whether owner actions are read-only (no API_TOKEN, no FG_OWNER_TOKEN), and which projects are
 * shown (null: everything). The routes read `view` once per request.
 */
/** scores: the app's scorer (with your verdicts); unset, one over the decisions store alone. */
export type LoopRouteContext = { tokenless: boolean; view: () => Promise<Pick<ShownProjects, 'has' | 'keys'> | null>; scores?: Scorer };

/** What one request may see: a project's records (and those of none), and the store's projectKeys filter (undefined: all). */
type Seen = { visible: (key: string | null) => boolean; keys: string[] | undefined };

/** The Activity kinds the loop writes; GET /api/loop/events adds the round records (`loop_round`). */
export const LOOP_ACTIVITY_KINDS = ['decision_made', 'decision_applied', 'decision_rolled_back', 'decision_noted', 'loop_settings_changed', 'loop_paused'] as const satisfies readonly ActivityKind[];

const DECISION_PAGE = 100;
const DECISION_MAX_PAGE = 500;
const EVENTS_PAGE = 100;
/** insights.patterns for GET /api/loop/metrics is kept this long per scope: its repeat groups grow with the square of the misses. */
const PATTERNS_TTL = 60_000;
const TRACK_ENTRIES = 200;
/** A type's rollback rate: over its last this many applied decisions. */
const TYPE_RATE_OF = 10;
const DAY = 86_400_000;

const MetricsQuery = z.object({ weeks: z.coerce.number().int().min(1).max(52).optional() });
const ListQuery = z.object({
  status: z.enum(DECISION_STATUSES).optional(),
  type: z.enum(DECISION_TYPES).optional(),
  project: z.string().min(1).max(200).optional(),
  mode: z.enum(DECISION_MODES).optional(),
  band: z.coerce.number().int().min(0).max(LOOP_BANDS - 1).optional(),
  target: z.string().min(1).max(500).optional(),
  since: IsoInstant.optional(),
  until: IsoInstant.optional(),
  /** Applied at or after; the list is then of applied decisions, newest applied first. */
  appliedSince: IsoInstant.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  /** Decisions whose id starts with this (fg decisions show <prefix>). */
  idPrefix: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(DECISION_MAX_PAGE).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  /** x-next-after of the page before: the next page in created order, read by keyset instead of offset. */
  after: z.string().min(1).max(1000).optional(),
  ...SortQuery,
});
const ActionBody = z.object({
  expect: z.enum(DECISION_STATUSES),
  note: z.string().trim().min(1).max(4000).optional(),
  reason: z.enum(DECISION_NOTE_REASONS).optional(),
  cascade: z.enum(['preview', 'apply']).optional(),
  restoreAnyway: z.boolean().optional(),
}).strict();
const NoteBody = z.object({
  text: z.string().trim().min(1).max(4000),
  verdict: z.enum(['agree', 'disagree']).nullable().optional(),
  reason: z.enum(DECISION_NOTE_REASONS).optional(),
}).strict().refine((n) => n.reason === undefined || n.verdict === 'disagree', { message: 'a reason goes only with verdict disagree', path: ['reason'] });
const Mode = z.enum(LOOP_MODES);
const SettingsBody = z.object({
  mode: Mode.optional(),
  types: z.record(z.enum(LOOP_DECISION_TYPES as [LoopDecisionType, ...LoopDecisionType[]]), z.object({ mode: Mode.nullable().optional(), tau: z.number().nullable().optional() }).strict()).optional(),
}).strict();
const DistinctBody = z.object({
  a: z.string().min(1).max(500), b: z.string().min(1).max(500), reason: z.string().trim().min(1).max(500).optional(),
}).strict().refine((x) => x.a !== x.b, 'two different records');
/** The two records a merge (merge_duplicates, merge_claims) joins: its keeper and the one merged into it. */
export function mergedPair(d: Pick<Decision, 'type' | 'targets'>): { a: string; b: string } | null {
  if (d.type !== 'merge_duplicates' && d.type !== 'merge_claims') return null;
  const keeper = d.targets.find((t) => t.role === 'keeper');
  const merged = d.targets.find((t) => t.role === 'merged');
  return keeper && merged ? { a: keeper.id, b: merged.id } : null;
}
const EventsQuery = z.object({ after: z.string().min(1).max(1000).optional() });

export const loopSchemas = { ListQuery, ActionBody, NoteBody, SettingsBody, EventsQuery, MetricsQuery, DistinctBody };

// ── Wire shapes (docs/learning-loop-api.md; the UI's api.ts types) ─────

/** Unset rather than null, as the page's Decision type has them. */
const OPTIONAL = ['appliedAt', 'decidedAt', 'decidedBy', 'supersededBy', 'rollback', 'ratifiedAt', 'ratifiedBy', 'syncHoldUntil'] as const;
export function decisionWire(d: Decision): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d };
  for (const k of OPTIONAL) if (out[k] === null) delete out[k];
  // What the loop could not decide on its own, and why, in one line (the Decisions page's "needs you").
  if (d.status === 'proposed') out.needsYou = needsYouReason(d);
  return out;
}
export const noteWire = ({ reason, ...n }: DecisionNote) => (reason === null ? n : { ...n, reason });

const words = (s: string) => s.replace(/_/g, ' ');
const primary = (d: Decision) => d.targets.find((t) => t.role === 'primary') ?? d.targets[0];
export const summaryOf = (d: Decision) => ({
  id: d.id, type: d.type, status: d.status, createdAt: d.createdAt, projectKey: d.projectKey,
  label: `${words(d.type)} · ${primary(d)?.id ?? d.id}`,
});

const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
/** A target's one line: a lesson's title, a fact's statement, a miss, an Inbox item's summary. */
const snapshotLabel = (s: TargetSnapshot) => {
  const f = s.fields;
  return text(f.title) ?? text(f.statement) ?? text(f.missed) ?? text(f.summary) ?? text((f.classification as { summary?: unknown } | undefined)?.summary) ?? s.id;
};

/** x-next-after of GET /api/decisions: where the page ended (DecisionKey), opaque. */
const encodeKey = (d: DecisionKey) => Buffer.from(JSON.stringify([d.createdAt, d.id])).toString('base64url');
function decodeKey(s: string): DecisionKey | null {
  try {
    const k = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(k) && k.length === 2 && typeof k[1] === 'string' && IsoInstant.safeParse(k[0]).success ? { createdAt: k[0], id: k[1] } : null;
  } catch {
    return null;
  }
}

/** A cursor of GET /api/loop/events: where the Activity log was read to (opaque, per backend) and the last round seq. */
type EventCursor = { a: string | null; r: number };
const encodeCursor = (c: EventCursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s: string): EventCursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Partial<EventCursor>;
    return (c.a === null || typeof c.a === 'string') && Number.isInteger(c.r) && c.r! >= 0 ? { a: c.a, r: c.r! } : null;
  } catch {
    return null;
  }
}

type LoopEvent = {
  seq: string; ts: string; kind: string; actor: string; subject: string;
  decisionId: string | null; decisionType: string | null; status: string | null; projectKey: string | null;
};
const detailText = (a: Activity, k: string) => text(a.details?.[k]);
const activityEvent = (a: Activity): LoopEvent => ({
  seq: `a:${a.id}`, ts: a.ts, kind: a.kind, actor: a.actor, subject: a.subject,
  decisionId: detailText(a, 'decisionId'), decisionType: detailText(a, 'decisionType'), status: detailText(a, 'status'), projectKey: a.projectKey,
});
const n = (k: number, w: string) => `${k} ${w}`;
const roundEvent = (seq: number, r: LoopRound): LoopEvent => ({
  seq: `r:${seq}`, ts: r.finishedAt ?? r.startedAt, kind: 'loop_round', actor: LOOP_ACTOR,
  subject: `round ${r.phase}: ${r.targetsScored}${r.targetsTotal === null ? '' : ` of ${r.targetsTotal}`} scored, ${n(r.decisions.observed, 'observed')}, ${n(r.decisions.proposed, 'proposed')}, ${n(r.decisions.applied, 'applied')}, ${n(r.decisions.skipped, 'skipped')}${r.error ? ` (${r.error})` : ''}`,
  decisionId: null, decisionType: null, status: null, projectKey: null,
});

/** A store that did not answer (an error, or the request's store deadline): 503, which the page retries. */
const unavailable = (c: Context, error: unknown) =>
  c.json({ error: `the store did not answer: ${(error as Error).message}`, retryable: true }, 503);
type Handler = (c: Context) => Promise<Response>;
const guarded = (h: Handler): Handler => async (c) => {
  try {
    return await h(c);
  } catch (error) {
    if (c.req.raw.signal.aborted) throw error;
    return unavailable(c, error);
  }
};

export function loopRoutes(app: Hono, d: LoopDeps, ctx: LoopRouteContext) {
  const now = d.now ?? Date.now;
  const store = d.decisions;
  const scores = ctx.scores ?? scorer(store);
  /** The shown projects, read once per request however many records it checks (each read is a few store queries). */
  const seenBy = new WeakMap<Request, Promise<Seen>>();
  const seen = (c: Context): Promise<Seen> => {
    let s = seenBy.get(c.req.raw);
    if (!s) {
      s = ctx.view().then((v) => ({ visible: (key: string | null) => key === null || !v || v.has(key), keys: v?.keys }));
      seenBy.set(c.req.raw, s);
    }
    return s;
  };
  /** The decision, unless it is gone or of a project that is not shown. */
  const find = async (c: Context, id: string) => {
    const [dec, s] = await Promise.all([store.get(id), seen(c)]);
    return dec && s.visible(dec.projectKey) ? dec : null;
  };
  const NOT_FOUND = { error: 'no such decision' };

  /** The decisions of shown projects (and of none). */
  const shownOnly = (s: Seen, rows: Decision[]) => rows.filter((x) => s.visible(x.projectKey));

  /** Decisions counted in the store (shown projects only): all of them, however many. */
  const total = (rows: DecisionCount[], keep: (r: DecisionCount) => boolean = () => true) => rows.filter(keep).reduce((n, r) => n + r.n, 0);

  const patternsAt = new Map<string, { at: number; report: Promise<PatternReport> }>();
  /** insights.patterns, reused for PATTERNS_TTL per scope (a failed read is not kept). */
  const patterns = (insights: Pick<InsightsStore, 'patterns'>): Pick<InsightsStore, 'patterns'> => ({
    patterns: (q) => {
      const key = JSON.stringify(q);
      const hit = patternsAt.get(key);
      if (hit && now() - hit.at < PATTERNS_TTL) return hit.report;
      const report = insights.patterns(q);
      patternsAt.set(key, { at: now(), report });
      report.catch(() => { if (patternsAt.get(key)?.report === report) patternsAt.delete(key); });
      return report;
    },
  });

  /** One owner Activity entry about a decision (asActor names an operator; the loop folds these into calibration). */
  const record = (kind: ActivityKind, dec: Decision, subject: string, why: string, details: Record<string, unknown> = {}) => d.activity.record({
    kind, actor: 'you', projectKey: dec.projectKey, subject: `${summaryOf(dec).label}: ${subject}`, why,
    details: { decisionId: dec.id, decisionType: dec.type, ...details }, targets: [dec.id, ...dec.targets.map((t) => t.id)],
  });

  async function loopState(c: Context) {
    const s = await seen(c);
    const shown = s.keys ? { projectKeys: s.keys } : {};
    const settings = await readLoopSettings(d.cursors, d.config);
    const t = now();
    const runtime = { tokenless: ctx.tokenless };
    const effective = effectiveLoopMode(settings, d.config, runtime);
    const types = await Promise.all(LOOP_DECISION_TYPES.map(async (type) => {
      const info = LOOP_TYPE_INFO[type];
      const [breaker, buckets, recent] = await Promise.all([
        readLoopBreaker(d.cursors, type),
        store.calibration(type, LOOP_POLICY_VERSION),
        store.list({ type, author: 'loop', status: ['applied', 'rolled_back', 'overridden'], order: 'applied', limit: TYPE_RATE_OF }),
      ]);
      const bands = Array.from({ length: LOOP_BANDS }, (_, band) => {
        const b = buckets.find((x) => x.band === band);
        const alpha = b?.alpha ?? info.prior.alpha;
        const beta = b?.beta ?? info.prior.beta;
        return { band, alpha, beta, n: b?.n ?? 0, ...betaSummary(alpha, beta) };
      });
      // Every band's labels on one prior.
      const alpha = info.prior.alpha + bands.reduce((s, b) => s + b.alpha - info.prior.alpha, 0);
      const beta = info.prior.beta + bands.reduce((s, b) => s + b.beta - info.prior.beta, 0);
      return {
        type, tier: info.tier, mode: settings.types[type]?.mode ?? null,
        effectiveMode: effectiveTypeMode(type, settings, d.config, { ...runtime, breaker }),
        tau: typeTau(type, settings), tauDefault: info.tauDefault,
        calibration: { ...betaSummary(alpha, beta), n: bands.reduce((s, b) => s + b.n, 0) },
        bands,
        rollbackRate: { rolledBack: recent.filter((x) => x.status === 'rolled_back').length, of: recent.length },
        breaker,
      };
    }));
    // Counted in the store, so the counts hold however many decisions there are, at a fixed number of queries.
    const [budget, proposed, week, month, round] = await Promise.all([
      readLoopBudget(d.cursors, t),
      store.count({ status: ['proposed'], author: 'loop', ...shown }, []),
      // The loop's own: the owner's decisions (conflicts resolved) are his, not proposals or the loop's rollbacks.
      store.count({ since: new Date(t - 7 * DAY).toISOString(), author: 'loop', ...shown }, ['mode', 'status', 'applied']),
      store.count({ since: new Date(t - 30 * DAY).toISOString(), author: 'loop', ...shown }, ['status', 'applied']),
      readLoopRound(d.cursors),
    ]);
    return {
      mode: settings.mode, effectiveMode: effective.mode, disabled: d.config.disabled, paused: settings.paused, capped: effective.capped,
      policyVersion: LOOP_POLICY_VERSION, types,
      budget: { llmCallsToday: budget.llmCalls, llmCallsPerDay: d.config.llmCallsPerDay, autoToday: budget.auto, autoPerDay: d.config.autoPerDay, autoPerProject: d.config.autoPerProject },
      counts: {
        proposed: total(proposed),
        week: {
          observed: total(week, (r) => r.mode === 'observe'), proposed: total(week, (r) => r.mode === 'propose'),
          applied: total(week, (r) => r.applied === true), rolledBack: total(week, (r) => r.status === 'rolled_back'),
        },
      },
      rollbackRate: { rolledBack: total(month, (r) => r.applied === true && r.status === 'rolled_back'), of: total(month, (r) => r.applied === true) },
      round,
      holdout: await loopHoldout(store, d.config.holdout, shown),
    };
  }

  app.get('/api/decisions', guarded(async (c) => {
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const { status, project, limit = DECISION_PAGE, offset = 0, after, sort, ...f } = q.data;
    if (after && (f.appliedSince || q.data.offset !== undefined)) return c.json({ error: 'after pages in created order: it goes with neither appliedSince nor offset' }, 400);
    if (after && sort) return c.json({ error: 'after pages in created order: sort=score pages by offset' }, 400);
    const key = after === undefined ? undefined : decodeKey(after);
    if (after !== undefined && !key) return c.json({ error: 'after: not a cursor this API gave' }, 400);
    const s = await seen(c);
    if (project && !s.visible(project)) return c.json([]);
    // One more than the page tells whether another follows (x-next-offset, as GET /api/candidates; x-next-after, the
    // keyset cursor, reads a deep page as fast as the first). The store pages only shown projects' decisions: a hidden
    // one counted toward the page would say a hidden match exists.
    const filter = {
      ...f, ...(status && { status: [status] }), ...(project && { projectKey: project }), ...(s.keys && { projectKeys: s.keys }),
      ...(f.appliedSince && { order: 'applied' as const }),
    };
    if (sort === 'score') {
      const scored = await pageByScore(async (n) => scores.decisions(await store.list({ ...filter, offset: 0, limit: n })), limit, offset, (r) => r.approveScore);
      if (scored.next !== null) c.header('x-next-offset', String(scored.next));
      return c.json(scored.page.map(decisionWire));
    }
    const rows = await store.list({ ...filter, ...(key ? { after: key } : { offset }), limit: limit + 1 });
    const page = rows.slice(0, limit);
    if (rows.length > limit) {
      if (!key) c.header('x-next-offset', String(offset + limit));
      if (!f.appliedSince) c.header('x-next-after', encodeKey(page.at(-1)!));
    }
    return c.json((await scores.decisions(page)).map(decisionWire));
  }));

  app.get('/api/decisions/:id', guarded(async (c) => {
    const dec = await find(c, c.req.param('id')!);
    if (!dec) return c.json(NOT_FOUND, 404);
    const s = await seen(c);
    const [current, evidence, deps, dependents, notes] = await Promise.all([
      d.exec ? d.exec.current(dec) : [],
      Promise.all(dec.evidence.map((e) => resolve(s, e))),
      Promise.all(dec.dependsOn.map((id) => store.get(id))),
      store.dependents(dec.id),
      store.notes(dec.id),
    ]);
    return c.json({
      decision: decisionWire((await scores.decisions([dec]))[0]),
      current,
      evidence,
      dependsOn: shownOnly(s, deps.filter((x): x is Decision => x !== null)).map(summaryOf),
      dependents: shownOnly(s, dependents).map(summaryOf),
      notes: notes.map(noteWire),
    });
  }));

  /** An evidence pointer as a line to show and link; missing when what it points at is gone (or not shown). */
  async function resolve(s: Seen, e: EvidenceRef) {
    if (e.kind === 'activity') {
      const a = await d.activity.get(e.id);
      return a && s.visible(a.projectKey) ? { ...e, label: a.subject, projectKey: a.projectKey, activity: a } : { ...e, label: e.role, activity: null, missing: true };
    }
    if (e.kind === 'session') {
      const x = await d.sessionDetail?.(e.id);
      if (x && !s.visible(x.projectKey)) return { ...e, label: e.role, missing: true };
      return x ? { ...e, label: x.snippet ?? x.id, projectKey: x.projectKey } : { ...e, label: e.role, ...(d.sessionDetail && { missing: true }) };
    }
    if (e.kind === 'check' || !d.exec) return { ...e, label: e.role };
    const snap = await d.exec.snapshot(e.kind, e.id);
    // A lesson with no project belongs to the one it was learned in (origin), as on the Lessons page.
    const key = snap && (text(snap.fields.projectKey) ?? (e.kind === 'lesson' ? (await d.lessonDetail(e.id))?.lesson.origin ?? null : null));
    if (!snap || !s.visible(key)) return { ...e, label: e.role, missing: true };
    return { ...e, label: snapshotLabel(snap), projectKey: text(snap.fields.projectKey), path: text(snap.fields.path) };
  }

  const ALLOWED: Record<'approve' | 'reject' | 'keep' | 'rollback', readonly DecisionStatus[]> = {
    approve: ['proposed', 'observed'], reject: ['proposed', 'observed'], keep: ['applied'], rollback: ['applied', 'overridden'],
  };
  const DONE = { approve: 'approved', reject: 'rejected', keep: 'kept', rollback: 'rolled back' } as const;
  const NO_EXECUTOR = { error: 'this API cannot apply or roll back decisions (no executor)' };
  /** The executor's refusals: it moved meanwhile, a dependent changed since (nothing written), or a write it cannot make. */
  const refused = (c: Context, error: unknown) => {
    if (error instanceof DecisionStateError) return c.json({ error: `${error.message}: reload it` }, 409);
    if (error instanceof CascadeBlockedError) return c.json({ error: `${error.message}: nothing was rolled back`, blocked: error.blocked }, 409);
    if (error instanceof UnsupportedTargetError) return c.json({ error: error.message }, 422);
    throw error;
  };

  /**
   * A rollback's own target changed since, but not by the owner: a 409 that overrides nothing, or null when it was the
   * owner. Another decision still applied left it as it is (a later one that builds on this one but was recorded without
   * the dependency), or it is already as it was before (another rollback of it, a double click, is restoring it now).
   */
  const notTheOwners = async (c: Context, dec: Decision, targetId: string, actual: string | null) => {
    const fingerprint = actual ?? ABSENT;
    const later = (await store.forTarget(targetId)).find((x) => x.id !== dec.id && x.status === 'applied' && x.after.some((a) => a.id === targetId && a.fingerprint === fingerprint));
    if (later) return c.json({ error: `${targetId} was changed since by ${later.id}, still applied: roll that back first`, blocked: [{ id: later.id, reason: `${targetId} is as it left it` }] }, 409);
    if (dec.before.some((b) => b.id === targetId && b.fingerprint === fingerprint)) return c.json({ error: `${summaryOf(dec).label} is being rolled back already: reload it` }, 409);
    return null;
  };

  /**
   * The note an approve, reject, keep or rollback came with, written after the action: the action is done by then, so a note
   * that cannot be saved is said in the answer (noteError), never answered as the action failing.
   */
  const actionNote = async (id: string, note: DecisionNoteInput | undefined | '') => {
    if (!note) return null;
    try {
      await store.addNote(id, note);
      return null;
    } catch (error) {
      return { noteError: `done, but its note was not saved (${redactSecrets(String(error)).slice(0, 200)}): add it again` };
    }
  };

  for (const action of ['approve', 'reject', 'keep', 'rollback'] as const) {
    app.post(`/api/decisions/:id/${action}`, guarded(async (c) => {
      const body = ActionBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const { expect, note, reason, cascade = 'apply', restoreAnyway = false } = body.data;
      if (action !== 'rollback' && (body.data.cascade || body.data.restoreAnyway !== undefined)) return c.json({ error: 'cascade and restoreAnyway go only with rollback' }, 400);
      const dec = await find(c, c.req.param('id')!);
      if (!dec) return c.json(NOT_FOUND, 404);
      if (dec.status !== expect) return c.json({ error: `it is ${words(dec.status)} now, not ${words(expect)}: reload it` }, 409);
      if (!ALLOWED[action].includes(dec.status)) return c.json({ error: `a decision that is ${words(dec.status)} cannot be ${DONE[action]}` }, 409);
      const by = currentActor();
      const label = summaryOf(dec).label;

      if (action === 'reject') {
        if (!(await store.markStatus(dec.id, { status: 'rejected', from: ['proposed', 'observed'], by }))) return c.json({ error: `${label} changed meanwhile: reload it` }, 409);
        const lost = await actionNote(dec.id, note && { by, text: note, verdict: 'disagree', reason: reason ?? null });
        await record('decision_made', dec, 'rejected', 'you rejected it', { status: 'rejected', action, ...(reason && { reason }) });
        return c.json({ ...decisionWire((await store.get(dec.id))!), ...lost });
      }
      if (action === 'keep') {
        if (!(await store.ratify(dec.id, by))) return c.json({ error: `${label} changed meanwhile: reload it` }, 409);
        const lost = await actionNote(dec.id, note && { by, text: note, verdict: 'agree' });
        await record('decision_made', dec, 'kept', 'you kept it', { status: 'applied', action });
        return c.json({ ...decisionWire((await store.get(dec.id))!), ...lost });
      }
      if (!d.exec) return c.json(NO_EXECUTOR, 501);
      if (action === 'approve') {
        let applied: Decision;
        try {
          applied = await d.exec.apply(dec, { by });
        } catch (error) {
          if (!(error instanceof TargetChangedError)) return refused(c, error);
          // The executor marked it overridden: the owner's change to its target stands.
          await record('decision_made', dec, 'overridden: its target changed since', `you tried to approve it after ${error.targetId} changed`, { status: 'overridden', action: 'overridden' });
          return c.json({ error: `${error.targetId} changed since it was proposed, so nothing was applied; it is marked overridden: reload it` }, 409);
        }
        const lost = await actionNote(dec.id, note && { by, text: note, verdict: 'agree' });
        await record('decision_applied', applied, 'approved and applied', 'you approved it', { status: applied.status, action });
        return c.json({ ...decisionWire(applied), ...lost });
      }

      // rollback
      if (dec.status === 'overridden' && !restoreAnyway) {
        return c.json({ error: 'its target was changed since it was applied: send restoreAnyway to write what it was before over that change' }, 409);
      }
      if (restoreAnyway && dec.status !== 'overridden') return c.json({ error: 'restoreAnyway goes only with an overridden decision' }, 400);
      const opts: RollbackOptions = { by, cascade, ...(reason && { reason }), ...(note && { note }), ...(restoreAnyway && { restoreAnyway }) };
      if (cascade === 'preview') {
        let plan: CascadePlan;
        try {
          plan = (await d.exec.rollback(dec, opts)) as CascadePlan;
        } catch (error) {
          return refused(c, error);
        }
        // Its own target changed since it was applied: no plain rollback can go through, so it is overridden now, as the
        // apply below would make it, and the page offers Restore anyway instead of a rollback it can never confirm.
        const own = plan.blocked.find((x) => x.id === dec.id);
        if (own && plan.own && dec.status === 'applied') {
          const other = await notTheOwners(c, dec, plan.own.targetId, plan.own.actual);
          if (other) return other;
          if (await store.markStatus(dec.id, { status: 'overridden', from: ['applied'], by })) {
            await record('decision_made', dec, 'overridden: its target changed since', 'you tried to roll it back after its target changed', { status: 'overridden', action: 'overridden' });
          }
          return c.json({ error: `its ${own.reason}, so nothing was rolled back; it is marked overridden: reload it to compare, or restore anyway` }, 409);
        }
        return c.json({ cascade: plan.cascade.map(summaryOf), blocked: plan.blocked });
      }
      let rolled: Decision;
      try {
        rolled = (await d.exec.rollback(dec, opts)) as Decision;
      } catch (error) {
        if (!(error instanceof TargetChangedError)) return refused(c, error);
        const other = await notTheOwners(c, dec, error.targetId, error.actual);
        if (other) return other;
        // The owner's later change is never silently undone: the decision is overridden, and Restore anyway is offered.
        if (await store.markStatus(dec.id, { status: 'overridden', from: ['applied'], by })) {
          await record('decision_made', dec, 'overridden: its target changed since', `you tried to roll it back after ${error.targetId} changed`, { status: 'overridden', action: 'overridden' });
        }
        return c.json({ error: `${error.targetId} was changed since this decision was applied, so nothing was rolled back; it is marked overridden: reload it to compare, or restore anyway` }, 409);
      }
      const undone = rolled.rollback?.cascade ?? [];
      // One entry per decision undone, so the loop labels each (the cascaded ones point at the one you rolled back).
      for (const id of undone) {
        const dep = await store.get(id);
        if (dep) await record('decision_rolled_back', dep, `rolled back with ${dec.id}`, 'you rolled back a decision it depended on', { status: 'rolled_back', action: 'cascade', cascadeOf: dec.id });
      }
      if (restoreAnyway) await record('decision_rolled_back', rolled, 'restored over a later change', 'you restored it anyway', { status: 'overridden', action: 'restore_anyway', ...(reason && { reason }), ...(note && { note }) });
      else {
        await record('decision_rolled_back', rolled, `rolled back${undone.length ? ` with ${undone.length} later decision${undone.length === 1 ? '' : 's'}` : ''}`, 'you rolled it back',
          { status: 'rolled_back', action, cascade: undone, ...(reason && { reason }), ...(note && { note }) });
      }
      // A merge you rolled back (or one undone with it) is two records you said are not the same: never proposed again.
      for (const x of [rolled, ...(await Promise.all(undone.map((id) => store.get(id))))]) {
        const pair = x && mergedPair(x);
        if (pair) await store.markDistinct({ ...pair, by, reason: `you rolled back the merge${note ? `: ${note}` : ''}`.slice(0, 500), decisionId: x.id });
      }
      // In the decision's notes too, with its reason, as a reject's note is: what the page and the loop read back.
      const lost = await actionNote(dec.id, note && { by, text: note, verdict: 'disagree', reason: reason ?? null });
      return c.json({ ...decisionWire(rolled), ...lost });
    }));
  }

  app.post('/api/decisions/:id/notes', guarded(async (c) => {
    const body = NoteBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const dec = await find(c, c.req.param('id')!);
    if (!dec) return c.json(NOT_FOUND, 404);
    const note = await store.addNote(dec.id, { by: currentActor(), text: body.data.text, verdict: body.data.verdict ?? null, reason: body.data.reason ?? null });
    if (!note) return c.json(NOT_FOUND, 404);
    await record('decision_noted', dec, `note${note.verdict ? ` (${note.verdict})` : ''}`, 'you added a note', { status: dec.status, noteId: note.id, ...(note.verdict && { verdict: note.verdict }), ...(note.reason && { reason: note.reason }) });
    return c.json(noteWire(note), 201);
  }));

  // Pairs you said are not the same (0.9.1): the loop never proposes merging them, whatever the evidence. Marking one
  // is an owner route (loop_decide); lifting one is yours alone, never the operator token's.
  app.get('/api/distinct-pairs', guarded(async (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200);
    if (!ids.length) return c.json({ error: 'ids: one or more record ids, comma separated' }, 400);
    return c.json(await store.distinctPairs(ids));
  }));
  app.post('/api/distinct-pairs', guarded(async (c) => {
    const body = DistinctBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const { a, b, reason } = body.data;
    const created = await store.markDistinct({ a, b, by: currentActor(), reason: reason ?? 'you marked them as not the same', decisionId: null });
    if (created) {
      await d.activity.record({ kind: 'decision_noted', actor: currentActor(), projectKey: null, subject: `never merge ${a} and ${b}`, why: reason ?? 'you marked them as not the same', details: { distinct: [a, b] }, targets: [a, b] });
    }
    return c.json({ created, pairs: await store.distinctPairs([a]) }, created ? 201 : 200);
  }));
  app.delete('/api/distinct-pairs', guarded(async (c) => {
    if (actingAsOperator()) return c.json({ error: 'only you lift a never-merge record (the browser or FG_OWNER_TOKEN), never the operator token' }, 403);
    const body = DistinctBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    if (!(await store.liftDistinct(body.data.a, body.data.b))) return c.json({ error: 'no such record' }, 404);
    await d.activity.record({ kind: 'decision_noted', actor: 'you', projectKey: null, subject: `may merge ${body.data.a} and ${body.data.b} again`, why: 'you lifted the never-merge record', details: { distinctLifted: [body.data.a, body.data.b] }, targets: [body.data.a, body.data.b] });
    return c.body(null, 204);
  }));

  app.get('/api/loop', guarded(async (c) => c.json(await loopState(c))));

  app.put('/api/loop/settings', guarded(async (c) => {
    const body = SettingsBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const patch = body.data;
    for (const [type, p] of Object.entries(patch.types ?? {}) as [DecisionType, { mode?: string | null; tau?: number | null }][]) {
      // A tier P type is always a proposal (choosing which side of a conflict is true, assigning or closing a question):
      // auto is refused rather than stored and silently capped.
      if (p.mode === 'auto' && LOOP_TYPE_INFO[type].tier === 'P') return c.json({ error: `${type} is always a proposal (tier P): it cannot apply on its own; set observe, propose or off` }, 400);
      const floor = LOOP_TYPE_INFO[type].tauDefault;
      if (p.tau != null && (p.tau < floor || p.tau > 1)) return c.json({ error: `${type}: tau must be from ${floor} (its default) to 1` }, 400);
    }
    const before = await readLoopSettings(d.cursors, d.config);
    const next: LoopSettings = { ...before, ...(patch.mode && { mode: patch.mode }), types: { ...before.types } };
    const changed: string[] = patch.mode && patch.mode !== before.mode ? [`mode ${before.mode} → ${patch.mode}`] : [];
    for (const [type, p] of Object.entries(patch.types ?? {}) as [DecisionType, { mode?: LoopSettings['mode'] | null; tau?: number | null }][]) {
      const was = before.types[type] ?? { mode: null, tau: null };
      const set = { mode: p.mode === undefined ? was.mode : p.mode, tau: p.tau === undefined ? was.tau : p.tau };
      next.types[type] = set;
      if (set.mode !== was.mode) changed.push(`${type} mode ${was.mode ?? 'global'} → ${set.mode ?? 'global'}`);
      if (set.tau !== was.tau) changed.push(`${type} tau ${was.tau ?? 'default'} → ${set.tau ?? 'default'}`);
      // The owner set the type's mode: a tripped breaker no longer holds it.
      if (p.mode !== undefined && (await readLoopBreaker(d.cursors, type)).tripped) {
        await resetLoopBreaker(d.cursors, type, now());
        changed.push(`${type} breaker reset`);
      }
    }
    await writeLoopSettings(d.cursors, next);
    if (changed.length) {
      await d.activity.record({
        kind: 'loop_settings_changed', actor: 'you', projectKey: null, subject: `learning loop: ${changed.join(', ')}`, why: 'you changed the learning loop settings',
        details: { changed, mode: next.mode, types: next.types }, targets: [],
      });
    }
    return c.json(await loopState(c));
  }));

  for (const pause of [true, false]) {
    app.post(`/api/loop/${pause ? 'pause' : 'resume'}`, guarded(async (c) => {
      if (d.config.disabled) return c.json({ error: 'LOOP_DISABLED=1 stops the learning loop: remove it from .env and restart to run it' }, 409);
      const s = await readLoopSettings(d.cursors, d.config);
      if (!!s.paused !== pause) {
        await writeLoopSettings(d.cursors, { ...s, paused: pause ? { at: new Date(now()).toISOString(), by: currentActor() } : null });
        await d.activity.record({
          kind: 'loop_paused', actor: 'you', projectKey: null, subject: `learning loop ${pause ? 'paused' : 'resumed'}`, why: `you ${pause ? 'paused' : 'resumed'} the learning loop`,
          details: { paused: pause }, targets: [],
        });
      }
      return c.json(await loopState(c));
    }));
  }

  app.get('/api/loop/metrics', guarded(async (c) => {
    if (!d.insights) return c.json({ error: 'no metrics' }, 404);
    const q = MetricsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const { keys } = await seen(c);
    return c.json(await readLoopMetrics({ insights: patterns(d.insights), decisions: store }, { now: now(), ...(q.data.weeks && { weeks: q.data.weeks }), ...(keys && { projectKeys: keys }) }));
  }));

  app.get('/api/loop/events', guarded(async (c) => {
    const q = EventsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const after = q.data.after === undefined ? null : decodeCursor(q.data.after);
    if (q.data.after !== undefined && !after) return c.json({ error: 'after: not a cursor this API gave' }, 400);
    const ring = await readLoopRounds(d.cursors);
    const kinds = [...LOOP_ACTIVITY_KINDS];
    // Rounds since the cursor (all of the ring without one); a full ring that starts past it may have dropped some.
    const rounds = ring.rounds.filter((r) => !after || r.seq > after.r).sort((x, y) => x.seq - y.seq);
    let gap = !!after && ring.rounds.length >= LOOP_ROUNDS_KEPT && ring.rounds[0].seq > after.r + 1;
    let page;
    try {
      page = after
        ? await d.activity.since({ after: after.a, kinds, unlabelled: true, limit: EVENTS_PAGE - Math.min(rounds.length, EVENTS_PAGE / 2) })
        : await d.activity.since({ kinds, unlabelled: true, last: true, limit: EVENTS_PAGE });
    } catch (error) {
      // A cursor from another store (a restore, a switch of STORE): start again at the end, and say events were lost.
      if (!after || !/not an Activity cursor/.test((error as Error).message)) throw error;
      gap = true;
      page = await d.activity.since({ kinds, unlabelled: true, last: true, limit: EVENTS_PAGE });
    }
    // A full page may stop short of later rounds: those wait for the next poll, so the stream stays in order.
    const full = after && page.entries.length >= EVENTS_PAGE - Math.min(rounds.length, EVENTS_PAGE / 2);
    const lastTs = page.entries.at(-1)?.ts;
    // In seq order up to the first that is later than the page: the cursor's seq then leaves none behind.
    const later = full ? rounds.findIndex((r) => (r.round.finishedAt ?? r.round.startedAt) > lastTs!) : -1;
    const taken = later < 0 ? rounds : rounds.slice(0, later);
    const s = await seen(c);
    const events = [...page.entries.filter((a) => s.visible(a.projectKey)).map(activityEvent), ...taken.map((r) => roundEvent(r.seq, r.round))]
      .sort((x, y) => x.ts.localeCompare(y.ts))
      .slice(-EVENTS_PAGE);
    const r = taken.at(-1)?.seq ?? after?.r ?? ring.seq;
    return c.json({ events, next: encodeCursor({ a: page.next, r }), gap });
  }));

  app.get('/api/loop/lessons/:id/track', guarded(async (c) => {
    const id = c.req.param('id')!;
    const detail = await d.lessonDetail(id);
    // A lesson with no project belongs to the one it was learned in (origin), as GET /api/lessons/:id has it.
    const s = await seen(c);
    if (!detail || !s.visible(detail.lesson.projectKey ?? detail.lesson.origin ?? null)) return c.json({ error: 'no such lesson' }, 404);
    const [stored, listed, decisions, repeats] = await Promise.all([
      store.signals(id),
      d.activity.list({ target: id, limit: TRACK_ENTRIES, unlabelled: true, noSandbox: true }),
      store.forTarget(id).then((rows) => shownOnly(s, rows)),
      d.repeats?.(id) ?? Promise.resolve([]),
    ]);
    // A global lesson is served and judged in every project: only the shown ones' entries are listed.
    const entries = listed.filter((a) => s.visible(a.projectKey));
    const k = stored?.counts;
    const signals = {
      served: k?.served ?? 0, lastServed: stored?.lastServed ?? null, sessions: k?.sessionsServed ?? 0,
      addressed: k?.addressed ?? 0, notAddressed: k?.notAddressed ?? 0, notApplicable: k?.notApplicable ?? 0, cannotTell: k?.cannotTell ?? 0,
      gapsFixed: k?.gapsFixed ?? 0, repeatServed: k?.repeatServed ?? 0, repeatUnserved: k?.repeatUnserved ?? 0,
      ownerPushbackAfter: k?.ownerPushbackAfter ?? 0, ownerEdits: k?.ownerEdits ?? 0, ownerRejects: k?.ownerRejects ?? 0,
      holdout: lessonHeldOut(detail.lesson, d.config.holdout),
    };
    type Entry = { ts: string; kind: 'served' | 'judged' | 'gap_fixed' | 'repeat' | 'owner' | 'decision'; label: string; sessionId: string | null; decisionId: string | null };
    const timeline: Entry[] = [];
    /** Sessions where a check caught this lesson's gap: addressed there later, the gap was fixed. */
    const gaps = new Set<string>();
    /** Sessions it was served in: a repeat there is one it did not prevent, elsewhere one retrieval missed. */
    const servedIn = new Set<string>();
    for (const a of [...entries].reverse()) {
      const known = new Set([id, ...idsIn(a.details?.lessons), ...idsIn(a.details?.misses), ...idsIn(a.details?.fileMisses), ...idsIn(a.details?.verdicts)]);
      const sessionId = text(a.details?.sessionId) ?? a.targets.filter((t) => !known.has(t)).at(-1) ?? null;
      if (a.kind === 'context_served') {
        if (sessionId) servedIn.add(sessionId);
        timeline.push({ ts: a.ts, kind: 'served', label: a.subject, sessionId, decisionId: null });
      }
      else if (a.kind === 'predone_check') {
        const v = (Array.isArray(a.details?.verdicts) ? a.details.verdicts as { lessonId?: string; status?: string }[] : []).find((x) => x?.lessonId === id);
        if (!v?.status) continue;
        const fixed = v.status === 'addressed' && sessionId !== null && gaps.has(sessionId);
        if (v.status === 'not_addressed' && sessionId) gaps.add(sessionId);
        if (fixed) gaps.delete(sessionId);
        timeline.push({ ts: a.ts, kind: fixed ? 'gap_fixed' : 'judged', label: words(v.status), sessionId, decisionId: null });
      } else if (a.kind === 'lesson_decided' && !a.actor.startsWith('loop:')) timeline.push({ ts: a.ts, kind: 'owner', label: a.subject, sessionId: null, decisionId: null });
    }
    for (const r of repeats) {
      const served = r.sessionId !== null && servedIn.has(r.sessionId);
      timeline.push({ ts: r.ts, kind: 'repeat', label: `${served ? 'repeated after it was served' : 'repeated where it was not served'}: ${r.missed}`, sessionId: r.sessionId, decisionId: null });
    }
    for (const x of decisions) timeline.push({ ts: x.createdAt, kind: 'decision', label: `${words(x.type)}: ${words(x.status)}`, sessionId: null, decisionId: x.id });
    timeline.sort((x, y) => y.ts.localeCompare(x.ts));
    return c.json({ lessonId: id, title: detail.lesson.title, projectKey: detail.lesson.projectKey, signals, timeline });
  }));
}

/** Ids in an entry's details list: plain ids, or rows with an id or lessonId. */
const idsIn = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x?.id ?? x?.lessonId ?? ''))).filter((x): x is string => typeof x === 'string' && !!x) : [];
