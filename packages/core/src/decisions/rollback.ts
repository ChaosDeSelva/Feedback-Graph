import { suppress, suppressionKey } from '../loop/state.ts';
import type { DocsStore } from '../store.ts';
import { DECISION_NOTE_REASONS, type Decision, type DecisionNoteReason, type DecisionType } from '../types.ts';
import { applyDecision, currentTargets, handlerContext } from './apply.ts';
import { appliedDependents, checkChain, type Blocked, type CascadePlan } from './cascade.ts';
import { changedError, refuse, TargetChangedError } from './record.ts';
import { handlerFor, type ExecDeps } from './types/index.ts';
import { drift, type DecisionExecStore } from './snapshot.ts';

/** A rollback refused because a dependent it would also undo was changed since: nothing was written. */
export class CascadeBlockedError extends Error {
  readonly blocked: Blocked[];
  constructor(blocked: Blocked[]) {
    super(`the rollback also undoes ${blocked.map((b) => b.id).join(', ')}, changed since: ${blocked.map((b) => b.reason).join('; ')}`);
    this.name = 'CascadeBlockedError';
    this.blocked = blocked;
  }
}

export type RollbackOptions = { by: string; reason?: string; note?: string; cascade: 'preview' | 'apply'; restoreAnyway?: boolean };

const reasonOf = (r: string | undefined): DecisionNoteReason | null => ((DECISION_NOTE_REASONS as readonly string[]).includes(r ?? '') ? (r as DecisionNoteReason) : null);

/**
 * Roll back an applied decision, restoring each target exactly as it was. preview: changes nothing and answers the
 * cascade. apply: the applied dependents first, newest first, then the decision, all or nothing, each target restored
 * to `before` expecting `after`. A target of the decision changed since throws TargetChangedError (the caller marks it
 * overridden); a changed dependent throws CascadeBlockedError. restoreAnyway (an applied or overridden decision): the
 * owner writes `before` over the target as it is now. Afterwards every undone decision is rolled_back (the cascade on
 * the decision's own record) and the call is suppressed (suppress). Writes no Activity and no calibration: the caller
 * records the rollback in Activity, and the engine's fold of that entry (worker loop/calibrate.ts) is the one place an
 * owner's rollback becomes a negative label and its reason a penalty.
 */
export async function rollbackDecision(s: DecisionExecStore, d: Decision, o: RollbackOptions, deps: ExecDeps = {}): Promise<Decision | CascadePlan> {
  const cur = await s.decisions.get(d.id);
  const takes: Decision['status'][] = o.restoreAnyway ? ['applied', 'overridden'] : ['applied'];
  // Restore anyway only undoes what was applied: an overridden proposal never changed anything.
  if (!cur || !takes.includes(cur.status)) throw refuse(d.id, cur, takes.join(' or '));
  if (cur.appliedAt === null) throw refuse(d.id, cur, takes.join(' or '), 'and it was never applied, so there is nothing to restore');
  const cascade = await appliedDependents(s, cur);
  const { blocked, own } = await checkChain(s, cur, cascade, { restoreAnyway: o.restoreAnyway });
  if (o.cascade === 'preview') return { cascade, blocked, own };
  if (own) throw new TargetChangedError(own.targetId, own.expected, own.actual);
  if (blocked.length) throw new CascadeBlockedError(blocked);

  // Every target is written before any status moves, so a failure part way moves the written ones back and leaves
  // every decision as it was.
  const ctx = handlerContext(s, deps, o.by);
  const undone: Decision[] = [];
  try {
    for (const x of cascade) {
      await handlerFor(x.type).rollback(ctx, x, x.after);
      undone.push(x);
    }
    await handlerFor(cur.type).rollback(ctx, cur, o.restoreAnyway ? await currentTargets(s, cur, deps) : cur.after);
  } catch (error) {
    for (const x of undone.reverse()) await handlerFor(x.type).apply(ctx, x);
    throw error;
  }

  const at = new Date().toISOString();
  const reason = reasonOf(o.reason);
  const record = (cascade: string[]) => ({ at, by: o.by, reason, note: o.note ?? null, cascade });
  for (const x of cascade) await s.decisions.markStatus(x.id, { status: 'rolled_back', from: ['applied'], by: o.by, rollback: record([]) });
  // Moved meanwhile: another rollback of it (a double click) got there first; that one is the record.
  if (!(await s.decisions.markStatus(cur.id, { status: 'rolled_back', from: takes, by: o.by, rollback: record(cascade.map((x) => x.id)) }))) {
    throw refuse(cur.id, await s.decisions.get(cur.id), takes.join(' or '));
  }
  await suppress(s.docs, cur.type, cur.targets, cur.evidence.length, Date.parse(at));
  return (await s.decisions.get(cur.id))!;
}

/**
 * Apply a rolled-back decision again ("redo"), only while its targets are still as `before`: it goes back to proposed
 * and is applied as `by`, and its suppression is lifted.
 */
export async function redoDecision(s: DecisionExecStore, d: Decision, o: { by: string }, deps: ExecDeps = {}): Promise<Decision> {
  const cur = await s.decisions.get(d.id);
  if (!cur || cur.status !== 'rolled_back') throw refuse(d.id, cur, 'rolled_back');
  const changed = drift(await currentTargets(s, cur, deps), cur.before);
  if (changed) throw changedError(changed.target.id, changed.expected, changed.target);
  if (!(await s.decisions.markStatus(cur.id, { status: 'proposed', from: ['rolled_back'] }))) throw refuse(cur.id, await s.decisions.get(cur.id), 'rolled_back');
  await s.docs.deleteCursor(suppressionKey(cur.type, cur.targets));
  return applyDecision(s, { ...cur, status: 'proposed' }, o, deps);
}
