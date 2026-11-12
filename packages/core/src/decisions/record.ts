import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactDeep, redactSecrets } from '../redact.ts';
import { archiveRedactionInput } from '../redactionArchive.ts';
import type { StoredFact } from '../graph/facts.ts';
import type { Decision, DecisionInput, DecisionNote, DecisionNoteReason, DecisionRollback, Lesson, TargetSnapshot } from '../types.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted at every depth, so equal values always hash alike. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * A decision's id: the same call (type, targets as they were, the evidence it rests on, policy version) is the same
 * decision, so a second round over the same data proposes nothing new. Evidence counts by what it points at, not its
 * weight or when it was seen, which a later round recomputes. The targets count by their `before` fingerprints too: the
 * same change asked again of targets changed since is a new call, never blocked by the earlier one's status. So do
 * the decisions it builds on (dependsOn), when it has any: the same change from the same state, made again after later
 * decisions came back to that state (a rank_weight step back to a weight it stepped from), is a new call, not the one
 * now history. A decision with none keeps the id it had before dependsOn existed.
 */
export function decisionId(d: Pick<DecisionInput, 'type' | 'targets' | 'before' | 'evidence' | 'policyVersion' | 'dependsOn'>): string {
  const targets = d.targets.map((t) => `${t.kind}:${t.id}:${t.role}`).sort();
  const before = d.before.map((b) => `${b.kind}:${b.id}:${b.fingerprint}`).sort();
  const evidence = sha256(canonicalJson(d.evidence.map((e) => `${e.kind}:${e.id}:${e.role}`).sort()));
  const deps = [...new Set(d.dependsOn ?? [])].sort();
  return `dec:${sha256(canonicalJson([d.type, targets, evidence, d.policyVersion, before, ...(deps.length ? [deps] : [])]))}`;
}

/** The lesson fields a decision changes and a rollback restores: one changed since the snapshot fails its `expect`. */
export const LESSON_FINGERPRINT_FIELDS = ['projectKey', 'title', 'rule', 'appliesWhen', 'scope', 'paths', 'status', 'decidedAt', 'decidedBy', 'decisionNote', 'servingWeight'] as const;
/** The fact fields the same way; `current`: not closed by a scan since. */
export const FACT_FINGERPRINT_FIELDS = ['kind', 'statement', 'path', 'lines', 'relevance', 'relevanceBy', 'current'] as const;
export type FingerprintedFact = Pick<StoredFact, 'id' | 'kind' | 'statement' | 'path' | 'lines' | 'relevance' | 'relevanceBy'> & { current: boolean };

const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
export const lessonFingerprint = (l: Lesson): string => sha256(canonicalJson(['lesson', l.id, pick(l, LESSON_FINGERPRINT_FIELDS)]));
export const factFingerprint = (f: FingerprintedFact): string => sha256(canonicalJson(['fact', f.id, pick(f, FACT_FINGERPRINT_FIELDS)]));

/**
 * The fingerprint of a target that does not exist: what a decision's `before` holds for a record it creates (a
 * record_fact's fact), and what a fact no longer current reads as (closed facts are never served, so a closed fact and
 * no fact are the same state to a decision).
 */
export const ABSENT = 'absent';
/** A fact's state as decisions compare it: factFingerprint while current, ABSENT when closed or gone. */
export const factStateFingerprint = (f: FingerprintedFact | null): string => (f?.current ? factFingerprint(f) : ABSENT);

/** The lesson fields a decision snapshot holds and a snapshot write sets (LESSON_FINGERPRINT_FIELDS). */
export type LessonSnapshotFields = Pick<Lesson, 'projectKey' | 'title' | 'rule' | 'appliesWhen' | 'scope' | 'paths' | 'status' | 'decidedAt'> & {
  decidedBy: string | null; decisionNote: string | null; servingWeight: number | null;
};
/** One lesson set to `fields` (KnowledgeStore.writeLessonSnapshots) while it still has the fingerprint `expect`. */
export type LessonSnapshotWrite = { id: string; fields: LessonSnapshotFields; expect: string; embedding?: number[] };
/** A merge's SUPERSEDES edge: the keeper supersedes the merged duplicate. */
export type SupersedeLink = { keeper: string; merged: string };
/** The fact fields a decision changes (FactsStore.writeFactSnapshots); current false closes the fact, true reopens it. */
export type FactSnapshotFields = { relevance: number | null; relevanceBy: string | null; current: boolean };
/** One fact set to `fields` while factStateFingerprint still reads `expect`. */
export type FactSnapshotWrite = { id: string; fields: FactSnapshotFields; expect: string };

/**
 * A domain write given `expect` found its target changed since the decision's snapshot (or gone: actual null), so it
 * wrote nothing: the owner's later edit is never silently overwritten.
 */
export class TargetChangedError extends Error {
  readonly targetId: string;
  readonly expected: string;
  readonly actual: string | null;
  constructor(targetId: string, expected: string, actual: string | null) {
    super(`${targetId} changed since the decision's snapshot`);
    this.name = 'TargetChangedError';
    this.targetId = targetId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** The texts a decision carries; kinds, ids, fingerprints and numbers are kept as they are. */
export type DecisionText = Pick<Decision, 'before' | 'after' | 'evidence' | 'rationale' | 'model' | 'rollback'>;
const redactSnapshots = (s: TargetSnapshot[]) => s.map((x) => ({ ...x, fields: redactDeep(x.fields) }));
const redactRollback = (r: DecisionRollback | null) => (r === null ? null : { ...r, note: r.note === null ? null : redactSecrets(r.note) });
const redactText = (d: DecisionText): DecisionText => ({
  before: redactSnapshots(d.before),
  after: redactSnapshots(d.after),
  evidence: d.evidence.map((e) => ({ ...e, role: redactSecrets(e.role) })),
  rationale: redactSecrets(d.rationale),
  model: d.model === null ? null : redactSecrets(d.model),
  rollback: redactRollback(d.rollback),
});

/** A stored decision's texts under the current rules (redactStoredDecisions); null when none changes. */
export function redactStoredDecision<T extends DecisionText>(d: T): T | null {
  const out = { ...d, ...redactText(d) };
  return JSON.stringify(out) === JSON.stringify(d) ? null : out;
}

/**
 * A proposal as both stores keep it: its id, and every text it carries redacted, the original archived first when
 * redaction changed it.
 */
export async function prepareDecision(input: DecisionInput): Promise<DecisionInput & { id: string }> {
  const id = decisionId(input);
  const { rollback: _, ...text } = redactText({ ...input, rollback: null });
  await archiveRedactionInput('decision', id, input, { ...input, ...text });
  return { ...input, ...text, dependsOn: [...new Set(input.dependsOn ?? [])], id };
}

/** Snapshots written when a decision is applied, redacted the same way. */
export async function prepareSnapshots(decisionId: string, after: TargetSnapshot[]): Promise<TargetSnapshot[]> {
  const safe = redactSnapshots(after);
  await archiveRedactionInput('decision-after', decisionId, after, safe);
  return safe;
}

/** A rollback record with its note redacted. */
export async function prepareRollback(decisionId: string, r: DecisionRollback): Promise<DecisionRollback> {
  const safe = redactRollback(r)!;
  await archiveRedactionInput('decision-rollback', decisionId, r, safe);
  return safe;
}

export type DecisionNoteInput = { by: string; text: string; verdict?: 'agree' | 'disagree' | null; reason?: DecisionNoteReason | null };

/** A note as both stores keep it: a new id, the time, and its text redacted. */
export async function prepareNote(decisionId: string, n: DecisionNoteInput): Promise<DecisionNote> {
  const id = `dnote:${randomUUID()}`;
  const text = redactSecrets(n.text);
  await archiveRedactionInput('decision-note', id, n.text, text);
  return { id, decisionId, ts: new Date().toISOString(), by: n.by, text, verdict: n.verdict ?? null, reason: n.reason ?? null };
}

/** An ISO time's offset is a real one (±14:00 at most): zod's datetime({ offset }) takes +99:00. */
export const isoOffsetValid = (s: string) => {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(s);
  return !m || Number(m[2]) * 60 + Number(m[3]) <= 14 * 60 && Number(m[3]) < 60;
};
/** An ISO time with a real offset, as the UTC instant it names (toISOString): DecisionFilter's since / until. */
export const IsoInstant = z.string().datetime({ offset: true })
  .refine(isoOffsetValid, { message: 'the offset must be within ±14:00' })
  .transform((s) => new Date(s).toISOString());

/**
 * What DecisionsStore.list returns. status: any of these. since / until: created at or after / before (an instant:
 * stores compare them as times, not text). appliedSince / appliedBefore: applied at or after / before. decidedSince: its
 * last status change by someone (decidedAt: a rollback, a rejection...) at or after. projectKeys: only these projects'
 * decisions and those of none. targets: naming any of these records. unlabelled: not yet labelled kept by the loop
 * (markLabelled). q: text in the rationale or a target id (case ignored). order: newest created first (default), or
 * `applied`: only decisions ever applied, newest applied first. after: the page after this decision (keyset paging,
 * created order only): older than it by createdAt, then id. Default limit 100.
 */
export type DecisionFilter = {
  status?: Decision['status'][];
  type?: Decision['type'];
  projectKey?: string;
  projectKeys?: string[];
  mode?: Decision['mode'];
  band?: number;
  target?: string;
  targets?: string[];
  since?: string;
  until?: string;
  appliedSince?: string;
  appliedBefore?: string;
  decidedSince?: string;
  unlabelled?: boolean;
  order?: 'created' | 'applied';
  after?: DecisionKey;
  q?: string;
  /** Decisions whose id starts with this (`fg decisions show <prefix>`): read through the id index where there is one. */
  idPrefix?: string;
  limit?: number;
  offset?: number;
};

/** Where a page of decisions ends, in their created order (DecisionFilter.after). */
export type DecisionKey = { createdAt: string; id: string };

/** What DecisionsStore.count groups by: a decision's status, mode, type, whether it was ever applied, the ISO week (UTC, `2026-W45`) it was made in. */
export const DECISION_COUNT_KEYS = ['status', 'mode', 'type', 'applied', 'createdWeek'] as const;
export type DecisionCountKey = (typeof DECISION_COUNT_KEYS)[number];
/** The filters DecisionsStore.count applies, as list's. */
export type DecisionCountFilter = Pick<DecisionFilter, 'status' | 'type' | 'mode' | 'projectKeys' | 'since' | 'appliedSince'>;
/** One group of DecisionsStore.count: the keys asked for, and how many decisions have them. */
export type DecisionCount = Partial<Pick<Decision, 'status' | 'mode' | 'type'> & { applied: boolean; createdWeek: string }> & { n: number };

/** A time as the stores write it (toISOString), so comparing the text compares the instants. */
export const instantText = (s: string | undefined): string | null => (s === undefined ? null : new Date(s).toISOString());

/**
 * markStatus: move from one of `from` to `status`. by: who decided (sets decidedAt and decidedBy). call: the loop made
 * the same call again in a later round (the decision observed then): the mode, score and confidence it made it with now.
 */
export type DecisionStatusPatch = {
  status: Decision['status']; from: Decision['status'][]; by?: string; rollback?: DecisionRollback; supersededBy?: string;
  call?: Pick<Decision, 'mode' | 'score' | 'confidence'>;
};

/** A link_misses edge: `from` repeats `to`, made by `decisionId`. */
export type MissLink = { from: string; to: string; decisionId: string; createdAt: string };

/** bumpCalibration: add labels to a bucket; one not yet stored starts from `prior`. */
export type CalibrationBump = { type: Decision['type']; band: number; policyVersion: number; prior: { alpha: number; beta: number }; alpha: number; beta: number; n: number };

/** The decision is not in a status the call takes (it moved since the caller read it, or is gone). */
export class DecisionStateError extends Error {
  readonly decisionId: string;
  readonly status: Decision['status'] | null;
  /** why: said instead of what it should have been, when its status is one wanted but the decision cannot be. */
  constructor(decisionId: string, status: Decision['status'] | null, want: string, why?: string) {
    super(status === null ? `no decision ${decisionId}` : `decision ${decisionId} is ${status}, ${why ?? `not ${want}`}`);
    this.name = 'DecisionStateError';
    this.decisionId = decisionId;
    this.status = status;
  }
}
/** The decision `id` as it was found (null: none), refused for not being `want`. */
export const refuse = (id: string, d: Pick<Decision, 'status'> | null, want: string, why?: string) => new DecisionStateError(id, d?.status ?? null, want, why);

/** `id` is no longer as `expected`: it is `now` (gone when ABSENT). */
export const changedError = (id: string, expected: string, now: TargetSnapshot) => new TargetChangedError(id, expected, now.fingerprint === ABSENT ? null : now.fingerprint);

/** A target kind or move no executor writes (a project's threshold; creating or removing a lesson). */
export class UnsupportedTargetError extends Error {
  constructor(t: { kind: string; id: string }, what: string) {
    super(`cannot ${what} ${t.kind} ${t.id}`);
    this.name = 'UnsupportedTargetError';
  }
}
