import type { Activity, Decision, DecisionFilter, DecisionType, Lesson, LessonSignals, LoopMiss, MissLink, RelatedMiss } from '@fb/core';
import type { LoopCandidate, LoopReads, LoopTypeContext } from '../plugin.ts';

/** A unit-test LoopTypeContext: the store parts a type reads, over plain data. Override what a test needs. */
export function fakeContext(o: {
  now?: number;
  entries?: Activity[];
  mode?: LoopTypeContext['mode'];
  misses?: LoopMiss[];
  /** Decisions already on record (DecisionsStore.list filters them by type and status). */
  decisions?: Decision[];
  links?: MissLink[];
  related?: (embedding: number[], projectKey: string | null) => RelatedMiss[];
  signals?: Record<string, LessonSignals>;
  /** The round's lessons (LoopTypeContext.lessons); default: what store.knowledge.listLessons lists. */
  lessons?: Lesson[];
  inScope?: (projectKey: string | null) => boolean;
  holdout?: number;
  /** What the type remembered in earlier rounds (LoopTypeContext.recall), by key. */
  memo?: Record<string, string>;
  store?: Partial<{ [K in keyof LoopReads]: Partial<LoopReads[K]> }>;
} = {}): LoopTypeContext {
  const misses = o.misses ?? [];
  const store = {
    ...o.store,
    decisions: {
      loopMisses: async (ids: string[]) => misses.filter((m) => ids.includes(m.id)).toSorted((a, b) => a.id.localeCompare(b.id)),
      missLinks: async (id: string) => (o.links ?? []).filter((l) => l.from === id || l.to === id),
      distinctPairs: async () => [],
      list: async (f: DecisionFilter = {}) => (o.decisions ?? []).filter((d) => (!f.type || d.type === f.type) && (!f.status || f.status.includes(d.status))),
      ...o.store?.decisions,
    },
    knowledge: {
      relatedMisses: async (q: { embedding: number[]; projectKey: string | null }) =>
        o.related?.(q.embedding, q.projectKey) ?? misses.filter((m) => m.projectKey === q.projectKey).map((m) => relatedOf(m)),
      ...o.store?.knowledge,
    },
  } as unknown as LoopReads;
  return {
    now: o.now ?? Date.parse('2026-11-11T12:00:00Z'),
    store,
    entries: o.entries ?? [],
    mode: o.mode ?? 'auto',
    signals: async (id) => o.signals?.[id] ?? null,
    lessons: async () => o.lessons ?? (await store.knowledge.listLessons?.({})) ?? [],
    inScope: o.inScope ?? (() => true),
    holdout: o.holdout ?? 0,
    recall: async (key) => o.memo?.[key] ?? null,
    llm: null,
    log: () => {},
  };
}

export const relatedOf = (m: LoopMiss): RelatedMiss =>
  ({ missId: m.id, missed: m.missed, cause: m.cause, feedbackText: '', sessionId: m.sessionId ?? '', ts: m.createdAt, score: 1 });

export const axis = (i: number, tilt = 0) => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : k === (i + 1) % 8 ? tilt : 0));

export function loopMiss(id: string, o: Partial<LoopMiss> = {}): LoopMiss {
  return {
    id, projectKey: 'demo', cause: 'verification_gap', missed: `missed ${id}`, embedding: axis(0), createdAt: '2026-11-01T00:00:00.000Z',
    subject: null, run: null, sandbox: false, sessionId: `s-${id}`, editedFiles: ['src/a.ts'], ...o,
  };
}

let seq = 0;
export function activity(kind: Activity['kind'], o: Partial<Activity> = {}): Activity {
  seq++;
  return { id: `act:${seq}`, ts: `2026-11-10T00:00:${String(seq % 60).padStart(2, '0')}.000Z`, kind, actor: 'deterministic', projectKey: 'demo', subject: kind, why: '', details: {}, targets: [], ...o };
}

/** The decision a round recorded observed for this call (what a type's recheck is handed). */
export function observedAs(type: DecisionType, c: LoopCandidate, o: Partial<Decision> = {}): Decision {
  return {
    type, projectKey: c.projectKey, targets: c.targets, before: c.before, after: c.after, evidence: c.evidence, features: c.features, rationale: c.rationale,
    model: c.model ?? 'deterministic', id: `dec:${type}:${c.targets[0].id}`, status: 'observed', mode: 'observe', tier: 'A', score: 0.9,
    confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 }, policyVersion: 1, dependsOn: c.dependsOn ?? [], createdAt: 't', appliedAt: null, decidedAt: null,
    decidedBy: null, supersededBy: null, rollback: null, ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null, ...o,
  };
}
