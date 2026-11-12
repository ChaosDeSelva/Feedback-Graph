/**
 * Removing a source with everything drawn from it (DELETE /api/intake/sources/:id?keep=none, 0.9.0 §7): the claims you
 * accepted from it are rejected and the facts they became closed, as a remove_source decision by you, applied at once
 * by the 0.8 executor (the resolve_conflict handler's moves), so a rollback re-opens the facts and restores the claims.
 */
import { dependenciesOf } from '../decisions/cascade.ts';
import { ABSENT } from '../decisions/record.ts';
import { snapshotTarget, type DecisionExecStore } from '../decisions/snapshot.ts';
import { LOOP_POLICY_VERSION } from '../loop/state.ts';
import type { Claim, DecisionInput, DecisionTarget, EvidenceRef, TargetSnapshot } from '../types.ts';
import { claimFingerprint, type ClaimSnapshotFields } from './records.ts';

/** The decision for removing `source`'s accepted `claims` (each with the fact it became), from the records as they are now. */
export async function sourceRemovalDecision(
  s: DecisionExecStore, source: { docId: string; projectKey: string | null; title: string }, claims: Pick<Claim, 'id' | 'factId'>[], o: { by: string; now?: string },
): Promise<DecisionInput> {
  const now = o.now ?? new Date().toISOString();
  const targets: DecisionTarget[] = [];
  const before: TargetSnapshot[] = [];
  for (const c of claims) {
    targets.push({ kind: 'claim', id: c.id, role: 'primary' });
    before.push(await snapshotTarget(s, { kind: 'claim', id: c.id }));
    if (c.factId) {
      targets.push({ kind: 'fact', id: c.factId, role: 'merged' });
      before.push(await snapshotTarget(s, { kind: 'fact', id: c.factId }));
    }
  }
  const after = before.map((b): TargetSnapshot => {
    if (b.fingerprint === ABSENT) return b;
    if (b.kind === 'fact') return { ...b, fields: { ...b.fields, current: false }, fingerprint: ABSENT };
    const fields = { ...(b.fields as ClaimSnapshotFields), status: 'rejected' as const, decidedBy: o.by, decidedAt: now };
    return { ...b, fields, fingerprint: claimFingerprint({ id: b.id, ...fields }) };
  });
  // The time makes removing it again after a rollback a new decision.
  const evidence: EvidenceRef[] = claims.map((c) => ({ kind: 'claim', id: c.id, role: `source ${source.docId} removed ${now}`, weight: 1, observedAt: now }));
  return {
    type: 'remove_source', author: 'owner', projectKey: source.projectKey, targets, before, after, evidence, features: {}, score: 1,
    confidence: { p: 1, lower: 1, n: 0, band: 4 }, tier: 'P', mode: 'propose', model: null, policyVersion: LOOP_POLICY_VERSION, status: 'proposed',
    rationale: `You removed the source "${source.title}" with everything drawn from it: the claims you had accepted from it are rejected and their facts closed`.slice(0, 500),
    dependsOn: await dependenciesOf(s, before),
  };
}
