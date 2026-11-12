import type { Decision } from '@fb/core';

/**
 * The engine's call into the apply executor: move one decision from observed/proposed through applying to applied,
 * making its target write. The core's loopExecutor (packages/core/src/decisions/executor.ts) implements it for every
 * type, and worker.ts wires it in; the engine depends only on this boundary. `by`: who applies it (LOOP_ACTOR when the loop applies it on its own).
 */
export interface LoopExecutor {
  apply(d: Decision, o: { by: string; syncHoldUntil: string | null }): Promise<ApplyOutcome>;
  /** What someone changed since this applied decision was applied (its targets, or a later decision's built on it), or null. */
  changed(d: Decision): Promise<string | null>;
}
/**
 * applied: written, the decision as now stored. lost: it was no longer observed or proposed (someone decided it first).
 * changed: a target differs from the decision's `before` (the owner changed it since), so nothing was written and the
 * decision was marked overridden.
 */
export type ApplyOutcome = { status: 'applied'; decision: Decision } | { status: 'lost' } | { status: 'changed'; reason: string };
