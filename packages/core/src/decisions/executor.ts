import type { Decision, DecisionTargetKind, TargetSnapshot } from '../types.ts';
import { applyDecision, currentTargets, reconcileInFlight, type ReconcileResult } from './apply.ts';
import { changedSince, type CascadePlan } from './cascade.ts';
import { DecisionStateError, TargetChangedError } from './record.ts';
import { redoDecision, rollbackDecision, type RollbackOptions } from './rollback.ts';
import { shownSnapshots, snapshotTarget, type DecisionExecStore } from './snapshot.ts';
import type { ExecDeps } from './types/index.ts';

/** The one way the API and the worker's engine apply and undo decisions. */
export type DecisionExecutor = {
  apply(d: Decision, o: { by: string; syncHoldUntil?: string | null }): Promise<Decision>;
  rollback(d: Decision, o: RollbackOptions): Promise<Decision | CascadePlan>;
  redo(d: Decision, o: { by: string }): Promise<Decision>;
  /** A target as it is now, redacted like stored snapshots; null when it is gone (a closed fact included). */
  snapshot(kind: DecisionTargetKind, id: string): Promise<TargetSnapshot | null>;
  /** The decision's targets as its type reads them now (comparable with before and after), redacted, gone ones left out. */
  current(d: Decision): Promise<TargetSnapshot[]>;
  /** reconcileInFlight as of `now` (default: the clock). */
  reconcile(now?: number): Promise<ReconcileResult>;
  /** changedSince: what someone changed since this applied decision was applied, or null. */
  changed(d: Decision): Promise<string | null>;
};

export function decisionExecutor(store: DecisionExecStore, deps: ExecDeps = {}): DecisionExecutor {
  return {
    apply: (d, o) => applyDecision(store, d, o, deps),
    rollback: (d, o) => rollbackDecision(store, d, o, deps),
    redo: (d, o) => redoDecision(store, d, o, deps),
    snapshot: async (kind, id) => shownSnapshots([await snapshotTarget(store, { kind, id })])[0] ?? null,
    current: async (d) => shownSnapshots(await currentTargets(store, d, deps)),
    reconcile: (now) => reconcileInFlight(store, deps, now),
    changed: (d) => changedSince(store, d),
  };
}

/** What the worker engine's LoopExecutor answers (packages/worker/src/loop/executor.ts ApplyOutcome). */
export type LoopApplyOutcome = { status: 'applied'; decision: Decision } | { status: 'lost' } | { status: 'changed'; reason: string };

/**
 * decisionExecutor's apply as the engine's LoopExecutor: lost when the decision was no longer observed or proposed,
 * changed (and overridden) when a target differs from its `before`; any other failure is thrown.
 */
export function loopExecutor(store: DecisionExecStore, deps: ExecDeps = {}): {
  apply(d: Decision, o: { by: string; syncHoldUntil: string | null }): Promise<LoopApplyOutcome>;
  changed(d: Decision): Promise<string | null>;
} {
  return {
    changed: (d) => changedSince(store, d),
    async apply(d, o) {
      try {
        return { status: 'applied', decision: await applyDecision(store, d, o, deps) };
      } catch (error) {
        if (error instanceof DecisionStateError) return { status: 'lost' };
        if (error instanceof TargetChangedError) return { status: 'changed', reason: error.message };
        throw error;
      }
    },
  };
}
