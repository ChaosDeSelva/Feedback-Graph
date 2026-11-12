import {
  decisionId, type Activity, type ActivityInput, type ActivityQuery, type ActivitySinceQuery, type CalibrationBucket, type CalibrationBump,
  type Candidate, type Decision, type DecisionCount, type DecisionFilter, type DecisionInput, type DecisionNote, type DecisionNoteInput, type DecisionsStore,
  type DecisionStatusPatch, type DecidedLessonsQuery, type Lesson, type LessonFilter, type LessonSignals, type LessonSignalsRow,
  type DistinctPair, type MissLink, type Store, type TargetSnapshot,
} from '@fb/core';
import type { LoopEngineDeps } from '../engine.ts';

/**
 * The learning loop's replay sees a restored store as it was at a cut T0. Nothing is written to that
 * store: the loop's own records (decisions, signals, calibration, cursors, its Activity entries) live in memory, and the
 * reads the decision types make are answered as of T0:
 * - lessons, misses, Inbox items, facts and miss links made after T0 are left out;
 * - a lesson is rewound through what changed it after T0: your edits and decisions (Activity `lesson_decided` and
 *   `lesson_to_fact`: their `changed.from`, and the status before from the lesson's earlier decision) and the loop's
 *   applied or rolled-back decisions (their snapshots);
 * - an Inbox item decided after T0 is pending again;
 * - Activity reads stop at T0.
 * What is not rewound: a lesson's checks and embedding, a fact's relevance, the code map and the patterns report, which
 * the store keeps only as they are now. docs/operations.md says what that means for the numbers.
 */

/** Rows a time-travelled list reads before it filters (its own status filter is applied after the rewind). */
export const TT_READ = 100_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** The status a lesson_decided or lesson_to_fact entry set; null for an edit or a note that set none. */
export function statusSet(e: Activity): Lesson['status'] | null {
  if (e.kind === 'lesson_to_fact') return 'rejected';
  if (e.kind !== 'lesson_decided' || e.subject.startsWith('edited ')) return null;
  const s = e.details.status;
  return typeof s === 'string' ? (s as Lesson['status']) : null;
}

/** What changed lessons, by lesson id: the owner's and others' entries (oldest first), and the loop's real decisions. */
export class LessonHistory {
  private readonly t0: string;
  private readonly entries = new Map<string, Activity[]>();
  private readonly decisions = new Map<string, Decision[]>();

  constructor(t0: number, entries: readonly Activity[], decisions: readonly Decision[]) {
    this.t0 = iso(t0);
    for (const e of entries) {
      if (e.kind !== 'lesson_decided' && e.kind !== 'lesson_to_fact') continue;
      const id = e.targets[0];
      if (id) this.entries.set(id, [...(this.entries.get(id) ?? []), e]);
    }
    for (const d of decisions) for (const t of d.targets) if (t.kind === 'lesson') this.decisions.set(t.id, [...(this.decisions.get(t.id) ?? []), d]);
  }

  /** The lesson as it was at T0; null when it was made after. */
  rewind(l: Lesson): Lesson | null {
    if (l.createdAt >= this.t0) return null;
    const events: { ts: string; undo: (x: Record<string, unknown>) => void }[] = [];
    for (const e of this.entries.get(l.id) ?? []) if (e.ts >= this.t0) events.push({ ts: e.ts, undo: (x) => this.undoEntry(l.id, e, x) });
    for (const d of this.decisions.get(l.id) ?? []) {
      const before = d.before.find((s) => s.kind === 'lesson' && s.id === l.id);
      const after = d.after.find((s) => s.kind === 'lesson' && s.id === l.id);
      if (d.appliedAt && d.appliedAt >= this.t0 && before) events.push({ ts: d.appliedAt, undo: (x) => Object.assign(x, before.fields) });
      if (d.rollback && d.rollback.at >= this.t0 && after) events.push({ ts: d.rollback.at, undo: (x) => Object.assign(x, after.fields) });
    }
    const x: Record<string, unknown> = { ...l, paths: [...l.paths] };
    for (const ev of events.sort((a, b) => b.ts.localeCompare(a.ts))) ev.undo(x);
    return x as Lesson;
  }

  private undoEntry(id: string, e: Activity, x: Record<string, unknown>) {
    const changed = e.details.changed && typeof e.details.changed === 'object' ? (e.details.changed as Record<string, { from?: unknown }>) : {};
    for (const [k, v] of Object.entries(changed)) if (v && 'from' in v) x[k] = v.from;
    const set = statusSet(e);
    if (!set) return;
    // The status before: the lesson's previous decision, else where a lesson starts (revoking needs it approved).
    const prior = this.entries.get(id)!.filter((p) => p.ts < e.ts && statusSet(p)).at(-1);
    x.status = prior ? statusSet(prior) : set === 'revoked' ? 'approved' : 'proposed';
    x.decidedAt = prior?.ts ?? null;
    x.decidedBy = prior?.actor ?? null;
  }
}

/** An Inbox item as it was at T0; null when it arrived after. */
export function rewindCandidate(c: Candidate, t0: number): Candidate | null {
  const at = iso(t0);
  if (c.createdAt >= at) return null;
  return c.decidedAt && c.decidedAt >= at ? { ...c, status: 'pending', decidedAt: null, decidedBy: null } : c;
}

/** `target` with some of its members replaced; the rest are the target's own (methods bound to it). */
export function overlay<T extends object>(target: T, over: Partial<T>): T {
  return new Proxy(target, {
    get(t, p) {
      if (p in over) return (over as Record<string | symbol, unknown>)[p];
      const v = (t as Record<string | symbol, unknown>)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

export class ReplayReadOnly extends Error {
  constructor(what: string) {
    super(`the replay never writes to the restored store (${what})`);
    this.name = 'ReplayReadOnly';
  }
}

/**
 * The loop's own records in memory, with the stores' semantics the engine relies on (content-addressed propose,
 * compare-and-set status moves); misses and their links are read from the restored store as of T0.
 */
export class MemoryDecisions implements DecisionsStore {
  readonly decisions = new Map<string, Decision>();
  private readonly signalRows = new Map<string, LessonSignals>();
  private readonly buckets = new Map<string, CalibrationBucket>();
  private readonly noteRows: DecisionNote[] = [];
  private readonly labelled = new Set<string>();
  private readonly base: Pick<DecisionsStore, 'loopMisses' | 'missLinks' | 'distinctPairs'>;
  private readonly now: () => string;
  private readonly t0: string;

  constructor(base: Pick<DecisionsStore, 'loopMisses' | 'missLinks' | 'distinctPairs'>, t0: number) {
    this.base = base;
    this.t0 = iso(t0);
    this.now = () => this.t0;
  }

  private move(id: string, from: Decision['status'][], set: Partial<Decision>) {
    const d = this.decisions.get(id);
    if (!d || !from.includes(d.status)) return false;
    this.decisions.set(id, { ...d, ...set });
    return true;
  }

  async propose(input: DecisionInput) {
    const id = decisionId(input);
    const had = this.decisions.get(id);
    if (had) return { decision: had, created: false };
    const { dependsOn, ...rest } = input;
    const d: Decision = {
      ...rest, id, dependsOn: [...new Set(dependsOn ?? [])], createdAt: this.now(), appliedAt: null, decidedAt: null, decidedBy: null,
      supersededBy: null, rollback: null, ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null,
    };
    this.decisions.set(id, d);
    return { decision: d, created: true };
  }

  async get(id: string) {
    return this.decisions.get(id) ?? null;
  }

  async list(f: DecisionFilter = {}) {
    const rows = [...this.decisions.values()].filter((d) => (!f.status || f.status.includes(d.status)) && (!f.type || d.type === f.type)
      && (f.projectKey === undefined || d.projectKey === f.projectKey) && (!f.mode || d.mode === f.mode) && (f.band === undefined || d.confidence.band === f.band)
      && (!f.target || d.targets.some((t) => t.id === f.target)) && (!f.since || d.createdAt >= f.since)
      && (!f.targets || d.targets.some((t) => f.targets!.includes(t.id))) && (!f.unlabelled || !this.labelled.has(d.id))
      && (!f.appliedBefore || (d.appliedAt !== null && d.appliedAt < f.appliedBefore)) && (f.order !== 'applied' || d.appliedAt !== null));
    rows.sort((a, b) => (f.order === 'applied' ? b.appliedAt!.localeCompare(a.appliedAt!) : 0) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 100));
  }

  async forTarget(id: string) {
    return this.list({ target: id, limit: TT_READ });
  }

  async loopChanged(ids: string[]) {
    const changed = new Set([...this.decisions.values()].filter((d) => d.status === 'applied' && d.decidedBy?.startsWith('loop:')).flatMap((d) => d.after.map((a) => a.id)));
    return [...new Set(ids)].filter((id) => changed.has(id));
  }

  async markApplying(id: string) {
    return this.move(id, ['proposed', 'observed'], { status: 'applying' });
  }

  async markApplied(id: string, after: TargetSnapshot[], o: { syncHoldUntil?: string | null } = {}) {
    return this.move(id, ['applying'], { status: 'applied', after, appliedAt: this.now(), syncHoldUntil: o.syncHoldUntil ?? null });
  }

  async markStatus(id: string, p: DecisionStatusPatch) {
    return this.move(id, p.from, {
      status: p.status, ...(p.by && { decidedBy: p.by, decidedAt: this.now() }), ...(p.rollback && { rollback: p.rollback }), ...(p.supersededBy && { supersededBy: p.supersededBy }),
      ...p.call,
    });
  }

  async ratify(id: string, by: string) {
    return this.move(id, ['applied'], { ratifiedAt: this.now(), ratifiedBy: by });
  }

  async markLabelled(id: string) {
    return this.decisions.get(id)?.status === 'applied' && !!this.labelled.add(id);
  }

  /** Counts are the API's, not part of a round. */
  async count(): Promise<DecisionCount[]> {
    throw new ReplayReadOnly('count is not part of a round');
  }

  async addNote(decisionId: string, n: DecisionNoteInput) {
    if (!this.decisions.has(decisionId)) return null;
    const note: DecisionNote = { id: `dnote:${this.noteRows.length + 1}`, decisionId, ts: this.now(), by: n.by, text: n.text, verdict: n.verdict ?? null, reason: n.reason ?? null };
    this.noteRows.push(note);
    return note;
  }

  async notes(decisionId: string) {
    return this.noteRows.filter((n) => n.decisionId === decisionId);
  }

  async dependents(id: string) {
    return (await this.list({ limit: TT_READ })).filter((d) => d.dependsOn.includes(id));
  }

  async inFlight() {
    return (await this.list({ status: ['applying'], limit: TT_READ })).reverse();
  }

  async signals(lessonId: string) {
    return this.signalRows.get(lessonId) ?? null;
  }

  async signalsOf(lessonIds: string[]) {
    return lessonIds.flatMap((id) => this.signalRows.get(id) ?? []);
  }

  /** The replay knows only the counts it folded, not the lessons' own fields. */
  async listSignals(): Promise<LessonSignalsRow[]> {
    throw new ReplayReadOnly('listSignals is not part of a round');
  }

  async upsertSignals(rows: Omit<LessonSignals, 'updatedAt'>[]) {
    for (const r of rows) this.signalRows.set(r.lessonId, { ...r, updatedAt: this.now() });
    return rows.length;
  }

  async calibration(type: Decision['type'], policyVersion: number) {
    return [...this.buckets.values()].filter((b) => b.type === type && b.policyVersion === policyVersion).sort((a, b) => a.band - b.band);
  }

  async bumpCalibration(b: CalibrationBump) {
    const key = `${b.type}|${b.band}|${b.policyVersion}`;
    const had = this.buckets.get(key) ?? { type: b.type, band: b.band, policyVersion: b.policyVersion, alpha: b.prior.alpha, beta: b.prior.beta, n: 0, updatedAt: this.now() };
    const next = { ...had, alpha: had.alpha + b.alpha, beta: had.beta + b.beta, n: had.n + b.n, updatedAt: this.now() };
    this.buckets.set(key, next);
    return next;
  }

  async linkMisses(): Promise<boolean> {
    throw new ReplayReadOnly('linkMisses');
  }

  async unlinkMisses(): Promise<boolean> {
    throw new ReplayReadOnly('unlinkMisses');
  }

  async markDistinct(): Promise<boolean> {
    throw new ReplayReadOnly('markDistinct');
  }

  async liftDistinct(): Promise<boolean> {
    throw new ReplayReadOnly('liftDistinct');
  }

  /** The pairs marked distinct before the replay's time. */
  async distinctPairs(ids: string[]): Promise<DistinctPair[]> {
    return (await this.base.distinctPairs(ids)).filter((p) => p.at < this.t0);
  }

  async missLinks(missId: string): Promise<MissLink[]> {
    return (await this.base.missLinks(missId)).filter((l) => l.createdAt < this.t0);
  }

  async loopMisses(ids: string[]) {
    return (await this.base.loopMisses(ids)).filter((m) => m.createdAt < this.t0);
  }

  async redactStoredDecisions(): Promise<number> {
    throw new ReplayReadOnly('redactStoredDecisions');
  }
}

/** Cursors in memory: the loop's settings, fold position and rounds during a replay. */
export function memoryCursors() {
  const m = new Map<string, string>();
  return { getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => { m.set(k, v); }, raw: m };
}

export type TimeTravel = {
  store: LoopEngineDeps['store'];
  decisions: MemoryDecisions;
  /** The Activity entries the loop recorded during the replay. */
  recorded: ActivityInput[];
};

/** The restored store as the loop reads it at T0. `history`: what changed its lessons (LessonHistory). */
export function timeTravel(store: Pick<Store, 'knowledge' | 'facts' | 'graph' | 'codegraph' | 'insights' | 'decisions' | 'activity' | 'intake' | 'links' | 'docs'>, t0: number, history: LessonHistory): TimeTravel {
  const at = iso(t0);
  const earlier = (ts: string | undefined) => (ts && ts < at ? ts : at);
  const recorded: ActivityInput[] = [];
  const decisions = new MemoryDecisions(store.decisions, t0);
  const k = store.knowledge;
  const rewound = (ls: Lesson[]) => ls.map((l) => history.rewind(l)).filter((l): l is Lesson => l !== null);

  const knowledge = overlay(k, {
    async listLessons(f: LessonFilter) {
      const ls = rewound(await k.listLessons({ ...f, status: undefined, limit: TT_READ }));
      return ls.filter((l) => !f.status || l.status === f.status).slice(0, f.limit ?? 500);
    },
    async lessonDetail(id: string) {
      const d = await k.lessonDetail(id);
      const lesson = d && history.rewind(d.lesson);
      return d && lesson ? { ...d, lesson } : null;
    },
    async similarLessons(id: string, n: number) {
      const hits = (await k.similarLessons?.(id, n)) ?? [];
      const out = [];
      for (const h of hits) {
        const d = await k.lessonDetail(h.id);
        const l = d && history.rewind(d.lesson);
        if (l) out.push({ ...h, status: l.status });
      }
      return out;
    },
    async searchLessons(q: Parameters<Store['knowledge']['searchLessons']>[0]) {
      const hits = await k.searchLessons({ ...q, status: undefined, k: q.k * 4 });
      return hits.map((h) => ({ ...h, lesson: history.rewind(h.lesson) })).filter((h): h is typeof h & { lesson: Lesson } => h.lesson !== null && (!q.status || h.lesson.status === q.status)).slice(0, q.k);
    },
    async relatedMisses(q: Parameters<Store['knowledge']['relatedMisses']>[0]) {
      return (await k.relatedMisses(q)).filter((m) => m.ts < at);
    },
    ...(k.decidedLessons && {
      async decidedLessons(q: DecidedLessonsQuery) {
        const rows = await k.decidedLessons!({ ...q, limit: TT_READ });
        return rows.map((r) => ({ ...r, lesson: history.rewind(r.lesson) }))
          .filter((r): r is typeof r & { lesson: Lesson } => r.lesson !== null && r.lesson.decidedAt !== null && r.lesson.decidedAt !== undefined && r.lesson.decidedAt < at && (r.lesson.status === 'approved' || r.lesson.status === 'rejected'))
          .slice(0, q.limit);
      },
    }),
  });

  const graph = overlay(store.graph, {
    async listCandidates(f: Parameters<Store['graph']['listCandidates']>[0] = {}) {
      const all = (await store.graph.listCandidates({ ...f, status: undefined, limit: TT_READ, offset: 0 })).map((c) => rewindCandidate(c, t0)).filter((c): c is Candidate => c !== null);
      const offset = f.offset ?? 0;
      return all.filter((c) => !f.status || c.status === f.status).slice(offset, offset + (f.limit ?? 50));
    },
    async candidateDetail(id: string) {
      const d = await store.graph.candidateDetail(id);
      const candidate = d && rewindCandidate(d.candidate, t0);
      return d && candidate ? { ...d, candidate } : null;
    },
  });

  const facts = overlay(store.facts, {
    async listFacts(q: Parameters<Store['facts']['listFacts']>[0]) {
      const offset = q.offset ?? 0;
      return (await store.facts.listFacts({ ...q, limit: TT_READ, offset: 0 })).filter((f) => f.createdAt < at).slice(offset, offset + (q.limit ?? 500));
    },
  });

  const activity = overlay(store.activity, {
    since: (q: ActivitySinceQuery) => store.activity.since({ ...q, until: earlier(q.until) }),
    list: (q: ActivityQuery) => store.activity.list({ ...q, before: earlier(q.before) }),
    async record(a: ActivityInput) {
      recorded.push(a);
    },
  });

  // Knowledge intake is read as it is now, not as it was: its loop types are not replayed with labels (score.ts).
  return { store: { knowledge, graph, facts, codegraph: store.codegraph, insights: store.insights, decisions, activity, intake: store.intake, links: store.links, docs: store.docs }, decisions, recorded };
}
