import { createHash } from 'node:crypto';
import { redactDeep } from '../redact.ts';
import type { StoredFact } from '../graph/facts.ts';
import type { Store } from '../store.ts';
import type { Candidate, DecisionTarget, Lesson, TargetSnapshot } from '../types.ts';
import { ABSENT, canonicalJson, factStateFingerprint, lessonFingerprint, type FingerprintedFact, type LessonSnapshotFields, type MissLink } from './record.ts';
import { thresholdsSnapshot } from '../loop/snapshots.ts';

/** What the executors read and write. */
export type DecisionExecStore = Pick<Store, 'knowledge' | 'facts' | 'graph' | 'decisions' | 'docs'>;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A target with no record (yet, or any more): see ABSENT. */
export const absentSnapshot = (t: Pick<DecisionTarget, 'kind' | 'id'>): TargetSnapshot => ({ kind: t.kind, id: t.id, fields: {}, fingerprint: ABSENT });

export const lessonSnapshotFields = (l: Lesson): LessonSnapshotFields => ({
  projectKey: l.projectKey, title: l.title, rule: l.rule, appliesWhen: l.appliesWhen, scope: l.scope, paths: l.paths,
  status: l.status, decidedAt: l.decidedAt, decidedBy: l.decidedBy ?? null, decisionNote: l.decisionNote ?? null,
  servingWeight: l.servingWeight ?? null,
});
export const lessonSnapshot = (l: Lesson): TargetSnapshot => ({ kind: 'lesson', id: l.id, fields: lessonSnapshotFields(l), fingerprint: lessonFingerprint(l) });

/**
 * A fact's snapshot: the fingerprinted fields, plus what creating it again needs (its project and why). A closed fact
 * reads as ABSENT (factStateFingerprint).
 */
export const factSnapshot = (f: FingerprintedFact & Pick<StoredFact, 'why'> & { projectKey: string }): TargetSnapshot => ({
  kind: 'fact', id: f.id,
  fields: { projectKey: f.projectKey, kind: f.kind, statement: f.statement, path: f.path, lines: f.lines, why: f.why, relevance: f.relevance, relevanceBy: f.relevanceBy, current: f.current },
  fingerprint: factStateFingerprint(f),
});

/** A miss as link_misses changes it: the misses it repeats (its outgoing REPEATS links), sorted. */
export function missSnapshot(id: string, links: MissLink[]): TargetSnapshot {
  const fields = { repeats: links.filter((l) => l.from === id).map((l) => l.to).sort() };
  return { kind: 'miss', id, fields, fingerprint: sha256(canonicalJson(['miss', id, fields])) };
}

/**
 * An Inbox item as triage changes it: its status, note and who decided. Not when: deciding again stamps a new time,
 * and a rollback reopens it as it was.
 */
export function candidateSnapshot(c: Pick<Candidate, 'id' | 'status' | 'note' | 'decidedBy'>): TargetSnapshot {
  const fields = { status: c.status, note: c.note, decidedBy: c.decidedBy ?? null };
  return { kind: 'candidate', id: c.id, fields, fingerprint: sha256(canonicalJson(['candidate', c.id, fields])) };
}

/** A target as it is now. A project's state is its own floors (tune_threshold). */
export async function snapshotTarget(s: DecisionExecStore, t: Pick<DecisionTarget, 'kind' | 'id'>): Promise<TargetSnapshot> {
  switch (t.kind) {
    case 'lesson': {
      const d = await s.knowledge.lessonDetail(t.id);
      return d ? lessonSnapshot(d.lesson) : absentSnapshot(t);
    }
    case 'fact': {
      const f = await s.facts.fact(t.id);
      return f ? factSnapshot(f) : absentSnapshot(t);
    }
    case 'miss':
      return missSnapshot(t.id, await s.decisions.missLinks(t.id));
    case 'candidate': {
      const c = await s.graph.candidateDetail(t.id);
      return c ? candidateSnapshot(c.candidate) : absentSnapshot(t);
    }
    case 'project':
      return thresholdsSnapshot(t.id, await s.facts.projectThresholds(t.id));
  }
}

/** Each target as it is now, in the targets' order. */
export const snapshotTargets = (s: DecisionExecStore, targets: Pick<DecisionTarget, 'kind' | 'id'>[]) => Promise.all(targets.map((t) => snapshotTarget(s, t)));

/** The distinct kinds and ids a list of snapshots names, in order. */
export const snapshotKeys = (list: TargetSnapshot[]) => [...new Map(list.map((x) => [`${x.kind}:${x.id}`, { kind: x.kind, id: x.id }])).values()];

/** The snapshot of `id` in a list; a target a list leaves out reads as ABSENT. */
export const snapshotOf = (list: TargetSnapshot[], t: Pick<DecisionTarget, 'kind' | 'id'>) => list.find((x) => x.id === t.id && x.kind === t.kind) ?? absentSnapshot(t);

/** The first target whose state differs from `expected`, with what it is now; null when all match. */
export function drift(now: TargetSnapshot[], expected: TargetSnapshot[]): { target: TargetSnapshot; expected: string } | null {
  for (const n of now) {
    const e = snapshotOf(expected, n).fingerprint;
    if (n.fingerprint !== e) return { target: n, expected: e };
  }
  return null;
}

/** Targets as the API shows them now: redacted like stored snapshots, those that are gone left out. */
export const shownSnapshots = (now: TargetSnapshot[]) => now.filter((n) => n.fingerprint !== ABSENT).map((n) => ({ ...n, fields: redactDeep(n.fields) }));
