import { LESSON_SIGNAL_COUNTS, REPEAT_SIMILARITY, type Activity, type ActivityKind, type DecisionsStore, type DocsStore, type KnowledgeStore, type LessonSignals } from '@fb/core';

/**
 * Per-lesson outcome counts folded from the Activity log, in order, a page per round, for the types to decide on: served, the
 * done-check's verdicts, gaps fixed later in the same session, repeats after serving, owner pushback, the agent's
 * not-applicable share, and the owner's edits and rejects. Stored with upsertSignals; nothing is joined at serve time.
 */

/** The kinds the loop reads: the signals' and the owner's labels on decisions (calibrate.ts). */
export const FOLD_KINDS: ActivityKind[] = [
  'context_served', 'predone_check', 'lesson_decided', 'postmortem_done', 'decision_made', 'decision_applied', 'decision_rolled_back',
];
/** A served lesson whose miss is at least this close to a later owner-confirmed miss in that session: owner pushback. */
export const PUSHBACK_SIMILARITY = 0.8;
/** Sessions remembered (what was served, open gaps) for this long, and at most this many. */
export const SESSION_DAYS = 14;
export const SESSIONS_KEPT = 2000;

export const LOOP_SESSIONS_CURSOR = 'loop-sessions';
/** Lessons per signalsOf read. */
const PREFETCH = 1000;
/** served: lessons served in the session; gaps: lessons a done-check found not addressed, not yet addressed since. */
export type SessionMemory = Record<string, { ts: string; served: string[]; gaps: string[] }>;

const DEMO = /^(lesson:|miss:)?demo:/;
export const isDemoId = (id: string) => DEMO.test(id);

/**
 * Whether the loop reads this entry at all: never a run's or a sandbox's, nor one from a folder that is not selected
 * (globalOnly), nor one of a project out of scope, nor the loop's own (they are its output, not evidence). Entries with
 * no project (global lessons, decisions) stay.
 */
export const admissible = (e: Activity, inScope: (projectKey: string | null) => boolean) =>
  !e.run && !e.sandbox && e.details.globalOnly !== true && !e.actor.startsWith('loop:') && inScope(e.projectKey);

export async function readSessions(cursors: Pick<DocsStore, 'getCursor'>): Promise<SessionMemory> {
  try {
    const o = JSON.parse((await cursors.getCursor(LOOP_SESSIONS_CURSOR)) ?? '{}') as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as SessionMemory) : {};
  } catch {
    return {};
  }
}

/** The sessions still remembered at `now`: the newest SESSIONS_KEPT seen within SESSION_DAYS. */
export function pruneSessions(s: SessionMemory, now: number): SessionMemory {
  const since = new Date(now - SESSION_DAYS * 86_400_000).toISOString();
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v.ts >= since).sort(([, a], [, b]) => b.ts.localeCompare(a.ts)).slice(0, SESSIONS_KEPT));
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? [x] : x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' ? [(x as { id: string }).id] : [])) : [];
type Row = Omit<LessonSignals, 'updatedAt'>;
const zero = (lessonId: string): Row => ({ lessonId, counts: Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, 0])) as Row['counts'], lastServed: null, lastOwnerTouch: null });

export type SignalFoldDeps = {
  decisions: Pick<DecisionsStore, 'signals' | 'signalsOf' | 'loopMisses'>;
  knowledge: Pick<KnowledgeStore, 'relatedMisses'>;
  sessions: SessionMemory;
};

/**
 * One round's fold: rows start from what is stored, entries are applied in order, then rows() go to upsertSignals.
 * Stored counts read are kept for the round, so the types reading a lesson's signals read them once (prefetch: many in
 * one read).
 */
export class SignalFold {
  private d: SignalFoldDeps;
  private touched = new Map<string, Row>();
  private stored = new Map<string, LessonSignals | null>();
  readonly sessions: SessionMemory;

  constructor(d: SignalFoldDeps) {
    this.d = d;
    this.sessions = d.sessions;
  }

  /** The lesson's counts as folded so far: this round's, else the stored ones. */
  async get(lessonId: string): Promise<LessonSignals | null> {
    const row = this.touched.get(lessonId);
    if (row) return { ...row, updatedAt: '' };
    if (!this.stored.has(lessonId)) this.stored.set(lessonId, await this.d.decisions.signals(lessonId));
    return this.stored.get(lessonId)!;
  }

  /** Read these lessons' stored counts in one go (signalsOf), for the get()s that follow. */
  async prefetch(lessonIds: readonly string[]): Promise<void> {
    const ids = [...new Set(lessonIds)].filter((id) => !this.touched.has(id) && !this.stored.has(id));
    for (let i = 0; i < ids.length; i += PREFETCH) {
      const chunk = ids.slice(i, i + PREFETCH);
      const found = new Map((await this.d.decisions.signalsOf(chunk)).map((x) => [x.lessonId, x]));
      for (const id of chunk) this.stored.set(id, found.get(id) ?? null);
    }
  }

  /** The rows this round changed. */
  rows(): Row[] {
    return [...this.touched.values()];
  }

  private async row(lessonId: string): Promise<Row> {
    let r = this.touched.get(lessonId);
    if (!r) {
      const stored = this.stored.has(lessonId) ? this.stored.get(lessonId)! : await this.d.decisions.signals(lessonId);
      this.stored.delete(lessonId);
      r = stored ? { lessonId, counts: { ...zero(lessonId).counts, ...stored.counts }, lastServed: stored.lastServed, lastOwnerTouch: stored.lastOwnerTouch } : zero(lessonId);
      this.touched.set(lessonId, r);
    }
    return r;
  }

  private session(id: string, ts: string) {
    const s = (this.sessions[id] ??= { ts, served: [], gaps: [] });
    s.ts = ts > s.ts ? ts : s.ts;
    return s;
  }

  /** Fold one admissible entry (oldest first). */
  async fold(e: Activity): Promise<void> {
    if (e.kind === 'context_served') return this.served(e);
    if (e.kind === 'predone_check') return this.judged(e);
    if (e.kind === 'lesson_decided') return this.decided(e);
    if (e.kind === 'postmortem_done') return this.repeated(e);
  }

  private async served(e: Activity) {
    const lessons = ids(e.details.lessons).filter((id) => !isDemoId(id));
    const named = new Set([...lessons, ...ids(e.details.lessons), ...ids(e.details.misses), ...ids(e.details.fileMisses)]);
    const sessionId = e.targets.find((t) => !named.has(t)) ?? null;
    const session = sessionId ? this.session(sessionId, e.ts) : null;
    for (const id of new Set(lessons)) {
      const r = await this.row(id);
      r.counts.served++;
      r.lastServed = e.ts;
      if (session && !session.served.includes(id)) {
        session.served.push(id);
        r.counts.sessionsServed++;
      }
    }
  }

  private async judged(e: Activity) {
    if (e.details.notJudged) return;
    // A verdict on a lesson judged only because its trigger fired on other files says nothing about it on its own.
    const verdicts = ((Array.isArray(e.details.verdicts) ? e.details.verdicts : []) as { lessonId?: unknown; status?: unknown; triggerOnly?: unknown }[])
      .filter((v) => v.triggerOnly !== true);
    const judged = new Set(verdicts.map((v) => v.lessonId));
    const sessionId = e.targets.find((t) => !judged.has(t) && !t.startsWith('lesson:') && !t.startsWith('miss:')) ?? null;
    const session = sessionId ? this.session(sessionId, e.ts) : null;
    for (const v of verdicts) {
      if (typeof v.lessonId !== 'string' || v.lessonId.startsWith('miss:') || isDemoId(v.lessonId)) continue;
      const r = await this.row(v.lessonId);
      if (v.status === 'addressed') {
        r.counts.addressed++;
        if (session?.gaps.includes(v.lessonId)) {
          r.counts.gapsFixed++;
          session.gaps = session.gaps.filter((g) => g !== v.lessonId);
        }
      } else if (v.status === 'not_addressed') {
        r.counts.notAddressed++;
        if (session && !session.gaps.includes(v.lessonId)) session.gaps.push(v.lessonId);
      } else if (v.status === 'not_applicable') {
        r.counts.notApplicable++;
        r.counts.agentNotApplicable++;
      } else if (v.status === 'cannot_tell') {
        r.counts.cannotTell++;
        r.counts.agentNotApplicable++;
      }
    }
  }

  /** The owner's edit or decision (operators' are attributed apart and do not count). */
  private async decided(e: Activity) {
    if (e.actor !== 'you') return;
    const changed = e.details.changed && typeof e.details.changed === 'object' ? Object.keys(e.details.changed) : [];
    for (const id of e.targets.filter((t) => !isDemoId(t))) {
      const r = await this.row(id);
      r.lastOwnerTouch = e.ts;
      if (changed.length) r.counts.ownerEdits++;
      if (e.subject.startsWith('rejected ')) r.counts.ownerRejects++;
    }
  }

  /**
   * A new miss repeats the misses of earlier lessons (cosine ≥ REPEAT_SIMILARITY): served in its session, the lesson
   * did not prevent it (repeatServed); not served, retrieval missed it (repeatUnserved). A lesson served in the session
   * whose miss is near the new one (≥ PUSHBACK_SIMILARITY) drew the owner's pushback after it was served.
   */
  private async repeated(e: Activity) {
    const missId = e.targets.find((t) => t.startsWith('miss:'));
    if (!missId || isDemoId(missId)) return;
    const [m] = await this.d.decisions.loopMisses([missId]);
    if (!m?.embedding) return;
    const served = new Set(m.sessionId ? this.sessions[m.sessionId]?.served ?? [] : []);
    const near = await this.d.knowledge.relatedMisses({ embedding: m.embedding, projectKey: m.projectKey, k: 10, run: null });
    const servedMisses = [...served].map((l) => `miss:${l.slice('lesson:'.length)}`);
    const others = await this.d.decisions.loopMisses([...new Set([...near.map((n) => n.missId), ...servedMisses])].filter((id) => id !== m.id));
    for (const o of others) {
      if (!o.embedding || isDemoId(o.id)) continue;
      const lessonId = `lesson:${o.id.slice('miss:'.length)}`;
      const cos = cosine(m.embedding, o.embedding);
      if (served.has(lessonId) && cos >= PUSHBACK_SIMILARITY) (await this.row(lessonId)).counts.ownerPushbackAfter++;
      if (cos < REPEAT_SIMILARITY || o.createdAt >= m.createdAt) continue;
      const r = await this.row(lessonId);
      if (served.has(lessonId)) r.counts.repeatServed++;
      else r.counts.repeatUnserved++;
    }
  }
}
