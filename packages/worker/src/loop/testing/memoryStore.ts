import {
  decisionId, type Activity, type ActivityInput, type ActivitySinceQuery, type CalibrationBucket, type CalibrationBump, type Decision,
  type DecisionFilter, type DecisionInput, type DecisionStatusPatch, type Lesson, type LessonSignals, type LoopMiss, type MissLink, type StoredFact,
  type TargetSnapshot,
} from '@fb/core';
import type { LoopEngineDeps } from '../engine.ts';
import { relatedOf } from './context.ts';

/**
 * The store parts the engine uses, in memory, with the real stores' semantics where the engine depends on them:
 * content-addressed propose, compare-and-set status moves, Activity in write order from a cursor.
 */
export function memoryStore(clock: () => number) {
  const now = () => new Date(clock()).toISOString();
  const log: (Activity & { seq: number })[] = [];
  const decisions = new Map<string, Decision>();
  const signals = new Map<string, LessonSignals>();
  const buckets = new Map<string, CalibrationBucket>();
  const links: MissLink[] = [];
  const misses = new Map<string, LoopMiss>();
  const lessons = new Map<string, Lesson>();
  const facts = new Map<string, StoredFact>();
  const cursors = new Map<string, string>();
  /** Decisions markLabelled marked. */
  const labelled = new Set<string>();
  let seq = 0;
  const move = (id: string, from: Decision['status'][], set: Partial<Decision>) => {
    const d = decisions.get(id);
    if (!d || !from.includes(d.status)) return false;
    decisions.set(id, { ...d, ...set });
    return true;
  };

  const store = {
    activity: {
      record: async (a: ActivityInput) => {
        seq++;
        log.push({ ...a, details: a.details ?? {}, targets: a.targets ?? [], id: `act:${seq}`, ts: now(), seq } as Activity & { seq: number });
      },
      since: async (q: ActivitySinceQuery) => {
        const after = q.after ? Number(q.after) : 0;
        const entries = log.filter((e) => e.seq > after && (!q.kinds || q.kinds.includes(e.kind)) && (!q.unlabelled || !e.run) && (!q.until || e.ts < q.until)).slice(0, q.limit);
        return { entries: entries.map(({ seq: _, ...e }) => e), next: entries.length ? String(entries.at(-1)!.seq) : q.after ?? null };
      },
      list: async () => [...log].reverse(),
      get: async (id: string) => log.find((e) => e.id === id) ?? null,
    },
    decisions: {
      propose: async (input: DecisionInput) => {
        const id = decisionId(input);
        const had = decisions.get(id);
        if (had) return { decision: had, created: false };
        const { dependsOn, ...rest } = input;
        const d: Decision = {
          ...rest, id, dependsOn: dependsOn ?? [], createdAt: now(), appliedAt: null, decidedAt: null, decidedBy: null, supersededBy: null,
          rollback: null, ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null,
        };
        decisions.set(id, d);
        return { decision: d, created: true };
      },
      get: async (id: string) => decisions.get(id) ?? null,
      list: async (f: DecisionFilter = {}) => [...decisions.values()]
        .filter((d) => (!f.status || f.status.includes(d.status)) && (!f.type || d.type === f.type) && (!f.mode || d.mode === f.mode)
          && (!f.appliedSince || (d.appliedAt ?? '') >= f.appliedSince) && (!f.decidedSince || (d.decidedAt ?? '') >= f.decidedSince)
          && (!f.appliedBefore || (d.appliedAt !== null && d.appliedAt < f.appliedBefore)) && (!f.unlabelled || !labelled.has(d.id))
          && (!f.targets || d.targets.some((t) => f.targets!.includes(t.id))) && (f.order !== 'applied' || d.appliedAt !== null))
        .sort((a, b) => (f.order === 'applied' ? b.appliedAt!.localeCompare(a.appliedAt!) : 0) || b.createdAt.localeCompare(a.createdAt))
        .slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 100)),
      forTarget: async (id: string) => [...decisions.values()].filter((d) => d.targets.some((t) => t.id === id)),
      markApplying: async (id: string, o: { by?: string; syncHoldUntil?: string | null } = {}) =>
        move(id, ['proposed', 'observed'], { status: 'applying', decidedAt: now(), ...(o.by && { decidedBy: o.by }), syncHoldUntil: o.syncHoldUntil ?? null }),
      markApplied: async (id: string, after: TargetSnapshot[], o: { syncHoldUntil?: string | null } = {}) =>
        move(id, ['applying'], { status: 'applied', after, appliedAt: now(), syncHoldUntil: o.syncHoldUntil ?? null }),
      markStatus: async (id: string, p: DecisionStatusPatch) =>
        move(id, p.from, { status: p.status, ...(p.by && { decidedBy: p.by, decidedAt: now() }), ...(p.rollback && { rollback: p.rollback }), ...p.call }),
      markLabelled: async (id: string) => decisions.get(id)?.status === 'applied' && !!labelled.add(id),
      signals: async (id: string) => signals.get(id) ?? null,
      signalsOf: async (ids: string[]) => ids.flatMap((id) => signals.get(id) ?? []),
      upsertSignals: async (rows: Omit<LessonSignals, 'updatedAt'>[]) => {
        for (const r of rows) signals.set(r.lessonId, { ...r, updatedAt: now() });
        return rows.length;
      },
      calibration: async (type: string, v: number) => [...buckets.values()].filter((b) => b.type === type && b.policyVersion === v),
      bumpCalibration: async (b: CalibrationBump) => {
        const key = `${b.type}|${b.band}|${b.policyVersion}`;
        const had = buckets.get(key) ?? { type: b.type, band: b.band, policyVersion: b.policyVersion, alpha: b.prior.alpha, beta: b.prior.beta, n: 0, updatedAt: now() };
        const next = { ...had, alpha: had.alpha + b.alpha, beta: had.beta + b.beta, n: had.n + b.n, updatedAt: now() };
        buckets.set(key, next);
        return next;
      },
      linkMisses: async (l: Omit<MissLink, 'createdAt'>) => {
        if (!misses.has(l.from) || !misses.has(l.to) || links.some((x) => x.from === l.from && x.to === l.to)) return false;
        links.push({ ...l, createdAt: now() });
        return true;
      },
      missLinks: async (id: string) => links.filter((l) => l.from === id || l.to === id),
      loopMisses: async (ids: string[]) => [...misses.values()].filter((m) => ids.includes(m.id)).sort((a, b) => a.id.localeCompare(b.id)),
    },
    knowledge: {
      lessonDetail: async (id: string) => (lessons.has(id) ? { lesson: lessons.get(id)! } : null),
      listLessons: async (q: { status?: Lesson['status']; flag?: string; ids?: string[]; afterId?: string; limit?: number }) =>
        [...lessons.values()]
          .filter((l) => (!q.status || l.status === q.status) && (!q.flag || l.checks?.some((c) => c.name === q.flag)) && (!q.ids || q.ids.includes(l.id))
            && (q.afterId === undefined || l.id > q.afterId))
          .sort((a, b) => (q.afterId === undefined ? 0 : a.id.localeCompare(b.id)))
          .slice(0, q.limit ?? 500),
      relatedMisses: async (q: { projectKey: string | null }) => [...misses.values()].filter((m) => m.projectKey === q.projectKey).map(relatedOf),
    },
    facts: {
      fact: async (id: string) => facts.get(id) ?? null,
    },
    cursors: {
      getCursor: async (k: string) => cursors.get(k) ?? null,
      setCursor: async (k: string, v: string) => { cursors.set(k, v); },
    },
  };
  return { store: store as unknown as LoopEngineDeps['store'], cursors: store.cursors, log, decisions, signals, buckets, links, misses, lessons, facts, raw: cursors, record: store.activity.record };
}
