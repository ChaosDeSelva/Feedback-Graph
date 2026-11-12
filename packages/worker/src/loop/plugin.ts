import type { Activity, Decision, DecisionTarget, DecisionType, EvidenceRef, Lesson, LessonSignals, LlmProvider, LoopMode, Store, TargetSnapshot } from '@fb/core';

/**
 * The contract a learning-loop decision type implements (one file per type in loop/types/, listed in types/index.ts).
 * docs/learning-loop-types.md walks through it with link_misses as the example.
 *
 * A type only FINDS calls. Each round the engine gives it a read-only context (the round's new Activity entries, the
 * folded per-lesson signals, the store) and the type returns candidates that passed its hard floors. The engine does
 * everything else, the same way for every type: suppression and "already decided" checks, scoring (policy.ts:
 * σ(bias + Σ weight·feature) with the type's hand weights), calibration (calibrate.ts), the mode and tier gate, caps
 * and budget, writing the Decision, its Activity entries, and applying it through the executor (executor.ts). A type
 * never writes to the store.
 *
 * Applying: the decision's `after` snapshots say what the target write must produce, and its `before` snapshots what a
 * rollback restores; the core executor (packages/core/src/decisions) does both writes per type, comparing fingerprints
 * (`expect`) so a target the owner changed since is never overwritten.
 */
export interface LoopType {
  readonly type: DecisionType;
  /**
   * Hand-set starting weights over this type's features (stamped LOOP_POLICY_VERSION: changing one bumps it). `bias` is
   * the intercept; a feature with no weight counts 0. Features should be in [0, 1] (or small counts) so weights compare.
   */
  readonly weights: Readonly<{ bias: number } & Record<string, number>>;
  /**
   * The features a rollback reason penalises for this type: `wrong_evidence` scales down the `evidence` group's
   * weights, `too_broad` the `scope` group's (policy.ts). A type with no such features leaves a group out.
   */
  readonly groups?: Readonly<{ evidence?: readonly string[]; scope?: readonly string[] }>;
  /**
   * This round's calls. Hard floors are applied here: a call below one is not returned (count it in `skipped`). A call
   * that passes the floors but must never apply on its own (an auto-only rule failed, the owner touched the target
   * recently) is returned with `proposeOnly`. Reads only; throw on a store error (the round aborts and is retried).
   */
  candidates(ctx: LoopTypeContext): Promise<LoopTypeResult>;
  /**
   * For a type that finds calls only from the round's `entries`, so a call it only observed would never be found again.
   * Outside observe the engine hands it the calls of its type still observed (newest first, at most `recheckLimit`)
   * that `candidates` did not find again this round; it measures each again as things are now and answers, in order,
   * the call (the engine moves it on to proposed or applied when its targets are as they were) or why it no longer
   * holds (the engine counts that skip and marks the decision expired). Reads only; no model call: re-measure by the
   * cheap floors and keep the call's own model output.
   */
  recheck?(ctx: LoopTypeContext, observed: readonly Decision[]): Promise<(LoopCandidate | string)[]>;
  /** Observed calls rechecked per round at most; default RECHECK_OBSERVED. */
  readonly recheckLimit?: number;
}

/** What a type may read. Everything here is already filtered: no sandbox or run-labelled entry, no demo, no project out of scope. */
export type LoopTypeContext = {
  /** The round's clock (ms). Use it, never Date.now(), so rounds are deterministic under test. */
  now: number;
  /** The store, read-only (the engine makes every write). */
  store: LoopReads;
  /** Activity entries new since the last round, oldest first: what changed, so a type can work incrementally. */
  entries: readonly Activity[];
  /** This type's mode this round (never off). Outside observe, `recheck` is asked about the calls it only observed. */
  mode: Exclude<LoopMode, 'off'>;
  /**
   * The lessons to judge on their record this round (any status, read once and shared by the types, their signals read
   * with them): those this round's entries name or whose signals it folded, and the next page of a slow sweep through
   * every lesson (LOOP_SWEEP a round), which finds what changed without an entry (a lesson's age, its checks). A type
   * that would otherwise list every lesson each round reads these, so a round costs what changed, not the store's size.
   */
  lessons: () => Promise<readonly Lesson[]>;
  /** A lesson's outcome counts as folded up to this round (signals.ts); null: none yet. */
  signals: (lessonId: string) => Promise<LessonSignals | null>;
  /** Whether the loop may act in this project: selected and not excluded. null (a global lesson): true. */
  inScope: (projectKey: string | null) => boolean;
  /**
   * LOOP_HOLDOUT: a call on a lesson in its control group is never made (the engine drops it). A type that asks the
   * model checks inHoldout(id, holdout) first, so no call is spent on a lesson the loop may never change.
   */
  holdout: number;
  /** What this type remembered under `key` in an earlier round (LoopTypeResult.remember); null: nothing. */
  recall: (key: string) => Promise<string | null>;
  /**
   * The loop's model (LOOP_LLM), its calls counted against LOOP_LLM_CALLS_PER_DAY; null when none is configured. A
   * call over the day's budget throws LoopBudgetSpent: let it propagate (the engine counts the skip). Anything sent to it
   * is data: fence it as such in the prompt.
   */
  llm: LlmProvider | null;
  log: (msg: string, extra?: object) => void;
};

export type LoopReads = Pick<Store, 'knowledge' | 'facts' | 'graph' | 'codegraph' | 'insights' | 'decisions' | 'activity' | 'intake' | 'links' | 'docs'>;

/** One call a type would make. */
export type LoopCandidate = {
  /** The project it acts in (null: global), for scope, caps and the Decisions filter. */
  projectKey: string | null;
  targets: DecisionTarget[];
  /** Each target as it is now, and as the decision would leave it (snapshot helpers: lessonFingerprint, missLinkSnapshot...). */
  before: TargetSnapshot[];
  after: TargetSnapshot[];
  /**
   * What it rests on, by pointer. Part of the decision's id (kind, id and role; not weight or time), so keep roles
   * stable labels ("repeat of"), with numbers in features: the same call on the same evidence is the same decision.
   */
  evidence: EvidenceRef[];
  features: Record<string, number>;
  /** One line for Activity and the Decisions list. */
  subject: string;
  /** Why, for the owner; redacted when stored. */
  rationale: string;
  /** The model's provider spec when one was used; default 'deterministic'. */
  model?: string;
  /** Earlier loop decisions whose `after` this one's `before` is; the engine adds every applied one it finds (dependenciesOf). */
  dependsOn?: string[];
  /** Set when this call may only be proposed, never applied on its own: the reason, added to its rationale. */
  proposeOnly?: string;
  /** Added to the type's τ for this call alone (reword_lesson on an approved lesson: +0.05); never lowers it. */
  tauRaise?: number;
};

/**
 * scanned: how many records the type looked at; skipped: why the others made no call (reason -> count); remember:
 * values the engine keeps for this type (key -> value), read back by LoopTypeContext.recall in later rounds.
 */
export type LoopTypeResult = { candidates: LoopCandidate[]; scanned: number; skipped: Record<string, number>; remember?: Record<string, string> };

/** Skip reasons shared by the engine and the types; a type may add its own. */
export const SKIP = {
  belowFloor: 'below_floor',
  neverTarget: 'never_target',
  outOfScope: 'out_of_scope',
  ownerTouched: 'owner_touched',
  suppressed: 'suppressed',
  alreadyDecided: 'already_decided',
  budget: 'budget',
  cap: 'auto_cap',
  targetChanged: 'target_changed',
  paused: 'paused',
  /** A target lesson is in the control group (LOOP_HOLDOUT): the loop never changes it. */
  holdout: 'holdout',
  /** You said the two records are not the same (a merge rolled back, or marked distinct): never merged again. */
  distinct: 'distinct',
  /** An observed call measured again (recheck) that is now below a floor: it is expired. */
  noLongerHolds: 'no_longer_holds',
} as const;

/** Observed calls a type rechecks per round at most, unless it sets fewer (LoopType.recheckLimit). */
export const RECHECK_OBSERVED = 500;
/** Rechecks per round for a type whose calls rest on a model's answer: re-measured by their floors only, a few at a time. */
export const RECHECK_MODEL_CALLS = 5;

/** The decision's primary target (a lesson, miss, project...). */
export const primaryOf = (d: Decision) => (d.targets.find((t) => t.role === 'primary') ?? d.targets[0]).id;

/**
 * An observed decision's own call, as a candidate again: for a recheck that keeps what a model answered (a rewrite, a
 * replay verdict) once its floors still hold. The engine scores its features again.
 */
export function callOf(d: Decision, subject: string, o: Pick<LoopCandidate, 'proposeOnly' | 'tauRaise'> = {}): LoopCandidate {
  return {
    projectKey: d.projectKey, targets: d.targets, before: d.before, after: d.after, evidence: d.evidence, features: d.features, subject,
    rationale: d.rationale, ...(d.model && { model: d.model }), ...(d.dependsOn.length && { dependsOn: d.dependsOn }), ...o,
  };
}

/** A recheck's answer from a type's own finding: below a floor (or nothing to find) is no longer holding. */
export const holdsStill = (r: LoopCandidate | string | null): LoopCandidate | string => (r === null || r === SKIP.belowFloor ? SKIP.noLongerHolds : r);

/** Count one skip. */
export const skip = (skipped: Record<string, number>, reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };

/** Whether you said these two records are not the same (DecisionsStore.distinctPairs): a merge of them is never made. */
export const markedDistinct = async (store: Pick<LoopReads, 'decisions'>, x: string, y: string) =>
  (await store.decisions.distinctPairs([x])).some((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x));
