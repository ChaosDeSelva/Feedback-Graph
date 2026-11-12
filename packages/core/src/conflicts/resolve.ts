/**
 * The owner's resolution of a conflict as a decision (0.9.0 §6): resolve_conflict, author owner, applied at once by
 * the 0.8 executor, so it is audited, shown on the Decisions page and rolled back (with its cascade) like any other.
 */
import { randomUUID } from 'node:crypto';
import { dependenciesOf } from '../decisions/cascade.ts';
import { ABSENT, decisionId, factFingerprint, lessonFingerprint, type LessonSnapshotFields } from '../decisions/record.ts';
import { conflictSnapshot, snapshotOf, snapshotTarget, type DecisionExecStore } from '../decisions/snapshot.ts';
import { claimFingerprint, type ClaimSnapshotFields } from '../intake/records.ts';
import { LOOP_POLICY_VERSION } from '../loop/state.ts';
import type { Conflict, ConflictChoice, ConflictDismissReason, ConflictSide, DecisionInput, DecisionTarget, EvidenceRef, FactKind, Lesson, RelevanceBy, TargetSnapshot } from '../types.ts';

/** The reconciled statement's fact: everyday, as an accepted claim's is, until you or the loop score it. */
export const RECONCILED_RELEVANCE = 0.8;

/**
 * a / b: that side is true, the other superseded. both: both partly, `note` required; with `statement`, a reconciled
 * owner fact (origin you) both sides are superseded by. none: not a conflict, `reason` required.
 */
export type ConflictResolveInput = {
  choice: ConflictChoice; note?: string | null; reason?: ConflictDismissReason | null; statement?: string | null;
  /** The reconciled fact's project when the conflict has none, and its kind (default convention). */
  projectKey?: string | null; factKind?: FactKind;
};

/** A resolution that cannot be made as asked: nothing was written. */
export class ResolveRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'ResolveRefusal'; }
}

const sideRef = (s: ConflictSide) => ({ kind: s.kind, id: s.id });

/** What a losing record becomes: a claim or lesson superseded, a fact closed. ABSENT ones (gone, closed) stay so. */
function lost(b: TargetSnapshot, o: { by: string; now: string; note: string | null }): TargetSnapshot {
  if (b.fingerprint === ABSENT) return b;
  if (b.kind === 'fact') return { ...b, fields: { ...b.fields, current: false }, fingerprint: ABSENT };
  if (b.kind === 'claim') {
    const fields = { ...(b.fields as ClaimSnapshotFields), status: 'superseded' as const, decidedBy: o.by, decidedAt: o.now };
    return { ...b, fields, fingerprint: claimFingerprint({ id: b.id, ...fields }) };
  }
  const fields: LessonSnapshotFields = { ...(b.fields as LessonSnapshotFields), status: 'superseded', decidedBy: o.by, decidedAt: o.now, ...(o.note && { decisionNote: o.note }) };
  return { ...b, fields, fingerprint: lessonFingerprint({ id: b.id, ...fields } as Lesson) };
}

/**
 * The decision for this resolution, built from the records as they are now (its `before`) and proposed by the owner.
 * Targets: the conflict (primary), each loser (merged; a losing claim's fact too), the winner (keeper) or the reconciled
 * fact (created). Its evidence names the conflict with the time, so resolving it again after a rollback is a new
 * decision; dependsOn names the loop decisions whose writes it builds on (a loser lesson a reword changed), so rolling
 * one of those back undoes this first.
 */
export async function resolutionDecision(s: DecisionExecStore, conflict: Conflict, r: ConflictResolveInput, o: { by: string; now?: string; factId?: string }): Promise<DecisionInput> {
  const now = o.now ?? new Date().toISOString();
  const note = r.note?.trim() || null;
  const statement = r.statement?.trim() || null;
  if (conflict.status !== 'open') throw new ResolveRefusal(`this conflict is ${conflict.status} already: roll its resolution back to choose again`);
  if (r.choice === 'both' && !note) throw new ResolveRefusal('both partly needs a note saying how each is true');
  if (r.choice === 'none' && !r.reason) throw new ResolveRefusal('not a conflict needs a reason: different scope, refines or already handled');
  if (statement && r.choice !== 'both') throw new ResolveRefusal('a reconciled statement goes only with both partly');
  const projectKey = conflict.projectKey ?? r.projectKey ?? null;
  if (statement && projectKey === null) throw new ResolveRefusal('this conflict is global, so there is no project to file the reconciled fact under: send projectKey');

  const losers: ConflictSide[] = r.choice === 'a' ? [conflict.b] : r.choice === 'b' ? [conflict.a] : r.choice === 'both' && statement ? [conflict.a, conflict.b] : [];
  const winner: ConflictSide | null = r.choice === 'a' ? conflict.a : r.choice === 'b' ? conflict.b : null;
  const targets: DecisionTarget[] = [{ kind: 'conflict', id: conflict.id, role: 'primary' }];
  const before: TargetSnapshot[] = [conflictSnapshot(conflict)];
  for (const side of losers) {
    const b = await snapshotTarget(s, side);
    targets.push({ ...sideRef(side), role: 'merged' });
    before.push(b);
    // A losing claim that agents are given as a fact: that fact is closed with it.
    const factId = side.kind === 'claim' ? (b.fields.factId as string | null | undefined) : null;
    if (factId && !targets.some((t) => t.kind === 'fact' && t.id === factId)) {
      targets.push({ kind: 'fact', id: factId, role: 'merged' });
      before.push(await snapshotTarget(s, { kind: 'fact', id: factId }));
    }
  }
  if (winner) targets.push({ ...sideRef(winner), role: 'keeper' });
  const factId = statement ? (o.factId ?? randomUUID()) : null;
  if (factId) {
    targets.push({ kind: 'fact', id: factId, role: 'created' });
    before.push({ kind: 'fact', id: factId, fields: {}, fingerprint: ABSENT });
  }

  const evidence: EvidenceRef[] = [
    { kind: 'conflict', id: conflict.id, role: `resolved ${now}`, weight: 1, observedAt: now },
    ...[conflict.a, conflict.b].map((x, i): EvidenceRef => ({ kind: x.kind, id: x.id, role: i ? 'side b' : 'side a', weight: 1, observedAt: x.assertedAt ?? now })),
  ];
  const input: Omit<DecisionInput, 'after'> = {
    type: 'resolve_conflict', author: 'owner', projectKey: conflict.projectKey, targets, before, evidence, features: {}, score: 1,
    confidence: { p: 1, lower: 1, n: 0, band: 4 }, tier: 'P', mode: 'propose', model: null, policyVersion: LOOP_POLICY_VERSION, status: 'proposed',
    rationale: rationaleOf(r.choice, note, r.reason ?? null, statement),
    dependsOn: await dependenciesOf(s, before),
  };
  const id = decisionId(input);
  const after = before.map((b): TargetSnapshot => {
    if (b.kind === 'conflict') {
      const fields = {
        ...b.fields, status: r.choice === 'none' ? 'dismissed' : 'resolved',
        resolution: { choice: r.choice, note, reason: r.choice === 'none' ? r.reason! : null, createdFactId: factId },
        resolvedBy: o.by, resolvedAt: now, decisionId: id,
      };
      return { ...conflictSnapshot({ ...(fields as unknown as Conflict), id: b.id }), fields };
    }
    if (b.kind === 'fact' && b.id === factId) {
      const f = { kind: r.factKind ?? 'convention', statement: statement!, path: `conflict:${conflict.id}`, lines: null, relevance: RECONCILED_RELEVANCE, relevanceBy: o.by as RelevanceBy, current: true };
      return { kind: 'fact', id: b.id, fields: { projectKey, why: `you, settling a conflict (${note})`.slice(0, 300), ...f }, fingerprint: factFingerprint({ id: b.id, ...f }) };
    }
    return lost(b, { by: o.by, now, note });
  });
  return { ...input, after };
}

function rationaleOf(choice: ConflictChoice, note: string | null, reason: ConflictDismissReason | null, statement: string | null): string {
  const said = note ? `: ${note}` : '';
  if (choice === 'a' || choice === 'b') return `You chose side ${choice.toUpperCase()} as true; the other is superseded${said}`;
  if (choice === 'both') return statement ? `Both partly true, reconciled as "${statement}"${said}` : `Both partly true${said}`;
  return `Not a conflict (${reason === 'scope' ? 'different scope' : reason === 'refines' ? 'one refines the other' : 'already handled'})${said}`;
}

/** The snapshot of `kind`/`id` in a decision's `after`, for a caller showing what a resolution did. */
export const resolvedSnapshot = (after: TargetSnapshot[], kind: TargetSnapshot['kind'], id: string) => snapshotOf(after, { kind, id });
