import type { Decision, TargetSnapshot } from '../../types.ts';
import type { DecisionExecStore } from '../snapshot.ts';

/** Embeds texts for the vectors a decision's new words or new fact need (the embedding model, as the API uses it). */
export type Embed = (texts: string[]) => Promise<number[][]>;
export type ExecDeps = { embed?: Embed };
/** What a handler writes with: the store, the embedder, and who the write is by. */
export type HandlerContext = { store: DecisionExecStore; deps: ExecDeps; by: string };

/**
 * How one decision type's target write is made and undone (docs/learning-loop-types.md, "Applying and rolling back").
 * The executors around it own the decision's status (compare-and-set), the drift checks, the cascade, compensation,
 * markApplied / markStatus, suppression and calibration; a handler only reads and writes targets.
 */
export type DecisionTypeHandler = {
  /**
   * The decision's targets as they are now, comparable with `before` and `after` (same kinds, ids and fingerprint
   * function). Default: snapshotTarget of every kind and id in `before` and `after`.
   */
  snapshot?(c: HandlerContext, d: Decision): Promise<TargetSnapshot[]>;
  /**
   * Write `d.after` over targets that are still `d.before`, all or nothing: a target that is not throws
   * TargetChangedError with nothing written (compare-and-set where the store has one).
   */
  apply(c: HandlerContext, d: Decision): Promise<void>;
  /**
   * Write `d.before` back over targets that are still `from` (`d.after`, or the targets as they are now when the owner
   * restores anyway), all or nothing, TargetChangedError otherwise.
   */
  rollback(c: HandlerContext, d: Decision, from: TargetSnapshot[]): Promise<void>;
};
