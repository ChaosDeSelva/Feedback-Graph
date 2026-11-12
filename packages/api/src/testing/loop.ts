import { isoWeek, type DecisionNoteReason, type RollbackOptions, type Activity, type ActivityInput, type CalibrationBucket, type Decision, type DecisionCount, type DecisionFilter, type DecisionNote, type LessonDetail, type LessonSignals, type LoopConfig, type TargetSnapshot } from '@fb/core';
import type { LoopDeps } from '../decisions.ts';

/** In-memory learning loop stores for the API's tests: decisions, notes, cursors, Activity and an executor. */

export const loopConfig = (o: Partial<LoopConfig> = {}): LoopConfig => ({
  mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0.2, types: null, ...o,
});

export const snap = (id: string, fields: Record<string, unknown>, kind: TargetSnapshot['kind'] = 'lesson'): TargetSnapshot =>
  ({ kind, id, fields, fingerprint: `fp:${id}:${JSON.stringify(fields)}` });

export function decision(id: string, o: Partial<Decision> = {}): Decision {
  return {
    id, type: 'retire_lesson', projectKey: 'shop',
    targets: [{ kind: 'lesson', id: 'lesson:1', role: 'primary' }],
    before: [snap('lesson:1', { title: 'Validate totals', status: 'approved' })],
    after: [snap('lesson:1', { title: 'Validate totals', status: 'revoked' })],
    evidence: [{ kind: 'activity', id: 'act:1', role: 'verdict not_applicable', weight: 0.6, observedAt: '2026-11-09T10:00:00.000Z' }],
    features: { served: 22 }, score: 0.91, confidence: { p: 0.93, lower: 0.9, n: 34, band: 4 }, tier: 'H', mode: 'auto',
    rationale: 'Served 22 times and never helped', model: 'deterministic', policyVersion: 1, status: 'applied', dependsOn: [],
    createdAt: '2026-11-09T12:00:00.000Z', appliedAt: '2026-11-09T12:00:01.000Z', decidedAt: '2026-11-09T12:00:01.000Z', decidedBy: 'loop:1',
    supersededBy: null, rollback: null, ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null,
    ...o,
  };
}

export function fakeLoop(o: { decisions?: Decision[]; config?: Partial<LoopConfig>; now?: number; exec?: boolean; lessons?: Record<string, LessonDetail['lesson']> } = {}) {
  const decisions = new Map((o.decisions ?? []).map((d) => [d.id, structuredClone(d)]));
  const notes: DecisionNote[] = [];
  const cursors = new Map<string, string>();
  const entries: (Activity & { seq: number })[] = [];
  const signals = new Map<string, LessonSignals>();
  const buckets: CalibrationBucket[] = [];
  const snapshots = new Map<string, TargetSnapshot>();
  const calls: { apply: unknown[][]; rollback: unknown[][] } = { apply: [], rollback: [] };
  /** Set to make the next executor call throw (a TargetChangedError, or a store error). */
  const fail: { apply?: Error; rollback?: Error; store?: Error } = {};
  let seq = 0;
  let noteSeq = 0;
  const now = o.now ?? Date.parse('2026-11-11T12:00:00.000Z');
  const sorted = () => [...decisions.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  const check = () => {
    if (fail.store) throw fail.store;
  };

  const record = (a: ActivityInput) => {
    entries.push({
      ...a, id: `act:${++seq}`, seq, ts: new Date(now + seq * 1000).toISOString(), details: a.details ?? {}, targets: a.targets ?? [], projectKey: a.projectKey ?? null,
      run: a.run, sandbox: a.sandbox,
    } as Activity & { seq: number });
  };

  const exec: NonNullable<LoopDeps['exec']> = {
    async apply(d, { by }) {
      calls.apply.push([d.id, by]);
      if (fail.apply) throw fail.apply;
      const x = decisions.get(d.id)!;
      Object.assign(x, { status: 'applied', appliedAt: new Date(now).toISOString(), decidedAt: new Date(now).toISOString(), decidedBy: by });
      return structuredClone(x);
    },
    async rollback(d, opts: RollbackOptions) {
      calls.rollback.push([d.id, opts]);
      if (fail.rollback) throw fail.rollback;
      const dependents = sorted().filter((x) => x.dependsOn.includes(d.id));
      if (opts.cascade === 'preview') return { cascade: dependents, blocked: dependents.filter((x) => x.status === 'overridden').map((x) => ({ id: x.id, reason: 'you changed its target since' })), own: null };
      const x = decisions.get(d.id)!;
      Object.assign(x, { status: 'rolled_back', decidedBy: opts.by, rollback: { at: new Date(now).toISOString(), by: opts.by, reason: (opts.reason ?? null) as DecisionNoteReason | null, note: opts.note ?? null, cascade: dependents.map((y) => y.id) } });
      return structuredClone(x);
    },
    async snapshot(kind, id) {
      check();
      return snapshots.get(`${kind}:${id}`) ?? null;
    },
    async current(d) {
      check();
      return d.targets.flatMap((t) => snapshots.get(`${t.kind}:${t.id}`) ?? []);
    },
    async changed(d) {
      check();
      const now = d.targets.flatMap((t) => snapshots.get(`${t.kind}:${t.id}`) ?? []);
      const moved = now.find((n) => d.after.some((a) => a.kind === n.kind && a.id === n.id && a.fingerprint !== n.fingerprint));
      return moved ? `${moved.id} changed since it was applied` : null;
    },
  };

  /** DecisionsStore.list's filters and order over the decisions. */
  const list = async (f: DecisionFilter = {}) => {
    check();
    const rows = sorted().filter((d) => (!f.status || f.status.includes(d.status)) && (!f.type || d.type === f.type) && (!f.projectKey || d.projectKey === f.projectKey)
      && (!f.projectKeys || d.projectKey === null || f.projectKeys.includes(d.projectKey))
      && (!f.mode || d.mode === f.mode) && (f.band === undefined || d.confidence.band === f.band) && (!f.target || d.targets.some((t) => t.id === f.target))
      && (!f.targets || d.targets.some((t) => f.targets!.includes(t.id)))
      && (!f.since || d.createdAt >= f.since) && (!f.until || d.createdAt < f.until)
      && (!f.appliedSince || (d.appliedAt ?? '') >= f.appliedSince) && (!f.decidedSince || (d.decidedAt ?? '') >= f.decidedSince)
      && (f.order !== 'applied' || d.appliedAt !== null) && (f.idPrefix === undefined || d.id.startsWith(f.idPrefix))
      && (!f.after || d.createdAt < f.after.createdAt || (d.createdAt === f.after.createdAt && d.id < f.after.id))
      && (!f.q || d.rationale.toLowerCase().includes(f.q.toLowerCase()) || d.targets.some((t) => t.id.toLowerCase().includes(f.q!.toLowerCase()))));
    if (f.order === 'applied') rows.sort((a, b) => b.appliedAt!.localeCompare(a.appliedAt!));
    return rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 100)).map((d) => structuredClone(d));
  };

  const deps: LoopDeps = {
    config: loopConfig(o.config),
    now: () => now,
    ...(o.exec !== false && { exec }),
    lessonDetail: async (id) => {
      const lesson = o.lessons?.[id];
      return lesson ? { lesson, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } as unknown as LessonDetail : null;
    },
    sessionDetail: async (id) => (id.startsWith('sess-') && id !== 'sess-gone' ? { id, projectKey: 'shop', snippet: id === 'sess-1' ? 'Refactor checkout' : null } as never : null),
    cursors: {
      getCursor: async (k) => { check(); return cursors.get(k) ?? null; },
      setCursor: async (k, v) => { cursors.set(k, v); },
    },
    activity: {
      record: async (a) => record(a),
      get: async (id) => entries.find((e) => e.id === id) ?? null,
      list: async (q) => entries.filter((e) => (!q.target || e.targets.includes(q.target)) && (!q.unlabelled || !e.run)).reverse().slice(0, q.limit ?? 200),
      since: async (q) => {
        if (q.after && !/^\d+$/.test(q.after)) throw new Error(`not an Activity cursor: ${q.after}`);
        const after = Number(q.after ?? 0);
        const match = entries.filter((e) => e.seq > after && (!q.kinds || q.kinds.includes(e.kind)) && (!q.unlabelled || !e.run));
        const page = q.last ? match.slice(-q.limit) : match.slice(0, q.limit);
        return { entries: page, next: page.length ? String(page.at(-1)!.seq) : (q.after ?? null) };
      },
    },
    decisions: {
      get: async (id) => { check(); const d = decisions.get(id); return d ? structuredClone(d) : null; },
      list: (f) => list(f),
      count: async (f, by) => {
        const groups = new Map<string, DecisionCount>();
        for (const d of await list({ ...f, limit: Number.MAX_SAFE_INTEGER })) {
          const g: DecisionCount = { n: 0 };
          for (const k of by) Object.assign(g, { [k]: k === 'applied' ? d.appliedAt !== null : k === 'createdWeek' ? isoWeek(d.createdAt) : d[k] });
          const key = JSON.stringify(g);
          groups.set(key, { ...g, n: (groups.get(key)?.n ?? 0) + 1 });
        }
        return by.length || groups.size ? [...groups.values()] : [{ n: 0 }];
      },
      forTarget: async (id) => sorted().filter((d) => d.targets.some((t) => t.id === id)),
      loopChanged: async (ids) => {
        const changed = new Set(sorted().filter((d) => d.status === 'applied' && d.decidedBy?.startsWith('loop:')).flatMap((d) => d.after.map((a) => a.id)));
        return [...new Set(ids)].filter((id) => changed.has(id));
      },
      markStatus: async (id, p) => {
        const d = decisions.get(id);
        if (!d || !p.from.includes(d.status)) return false;
        Object.assign(d, { status: p.status, ...(p.by && { decidedBy: p.by, decidedAt: new Date(now).toISOString() }), ...p.call });
        return true;
      },
      ratify: async (id, by) => {
        const d = decisions.get(id);
        if (d?.status !== 'applied') return false;
        Object.assign(d, { ratifiedAt: new Date(now).toISOString(), ratifiedBy: by });
        return true;
      },
      addNote: async (decisionId, n) => {
        if (!decisions.has(decisionId)) return null;
        const note: DecisionNote = { id: `dnote:${++noteSeq}`, decisionId, ts: new Date(now).toISOString(), by: n.by, text: n.text, verdict: n.verdict ?? null, reason: n.reason ?? null };
        notes.push(note);
        return note;
      },
      notes: async (id) => notes.filter((n) => n.decisionId === id),
      dependents: async (id) => sorted().filter((d) => d.dependsOn.includes(id)),
      signals: async (id) => signals.get(id) ?? null,
      // The signals with the lesson fields the holdout filters on (an approved postmortem lesson of shop unless given).
      listSignals: async (f = {}) => [...signals.values()]
        .map((x) => ({ ...x, projectKey: o.lessons?.[x.lessonId]?.projectKey ?? 'shop', source: o.lessons?.[x.lessonId]?.source ?? 'postmortem', status: o.lessons?.[x.lessonId]?.status ?? 'approved', run: null, sandbox: false }))
        .filter((x) => !f.projectKeys || (x.projectKey !== null && f.projectKeys.includes(x.projectKey))),
      calibration: async (type) => buckets.filter((b) => b.type === type),
    },
  };
  return { deps, decisions, notes, cursors, entries, signals, buckets, snapshots, calls, fail, record, now };
}
