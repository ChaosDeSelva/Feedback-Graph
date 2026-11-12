# Learning loop: adding a decision type

Each decision type is one file, `packages/worker/src/loop/types/<type>.ts`, exporting a `LoopType` (the contract is in
`packages/worker/src/loop/plugin.ts`), listed in `packages/worker/src/loop/types/index.ts`. `link_misses.ts` is the
reference implementation.

## What a type does, and what it does not

A type only **finds calls**. Each round the engine (`loop/engine.ts`) hands it a read-only `LoopTypeContext`:

| Field | What it is |
|---|---|
| `now` | The round's clock in ms. Use it instead of `Date.now()`. |
| `store` | The store, read only: `knowledge`, `facts`, `graph`, `codegraph`, `insights`, `decisions`, `activity`, `intake`, `links`, `docs`. |
| `entries` | The Activity entries new since the last round, oldest first. Sandbox, run-labelled and demo entries, and entries of projects out of scope, are already gone. Use them to work incrementally: `link_misses` looks only at the misses `postmortem_done` entries name. |
| `mode` | This type's mode this round (`observe`, `propose` or `auto`). Outside `observe` the engine also asks `recheck` (below) about the calls the type only observed. |
| `lessons()` | The lessons to judge on their record this round, of every status, read once and shared by the types: those the round's entries name or whose signals it folded, and the next page (`LOOP_SWEEP`, 500) of a slow sweep through every lesson by id, which reaches what changes without an entry (a lesson's age, a check added later). Their signals are read with them. `retire_lesson`, `reject_lesson` and `reword_lesson` read these instead of listing every lesson, so a round costs what changed, not the store's size. |
| `signals(lessonId)` | The lesson's outcome counts (`LessonSignals`: served, verdicts, gapsFixed, repeats, owner edits and rejects, `lastOwnerTouch`) as folded up to this round. |
| `inScope(projectKey)` | Whether the loop may act in that project (selected, not excluded). `null`, a global lesson, is in scope. |
| `holdout` | `LOOP_HOLDOUT`. The engine drops a call on a lesson where `inHoldout(id, holdout)`; a type that asks the model checks it first, so no call is spent on a lesson the loop may never change. |
| `recall(key)` | What this type returned under `key` in `remember` in an earlier round, or `null`. `reword_lesson` remembers a refused rewrite against the lesson's words, so it does not ask the model about the same text every round. |
| `llm` | The loop's model (`LOOP_LLM`), metered by `LOOP_LLM_CALLS_PER_DAY`, or `null`. A call over budget throws `LoopBudgetSpent`: let it propagate. Fence anything you send it as data. |

It returns `{ candidates, scanned, skipped }`, and optionally `remember` (key → value, which the engine stores for `recall`). Everything after that is the engine's, the same for every type:
suppression after a rollback, the holdout (a call on a lesson in `LOOP_HOLDOUT`'s control group is never made), the
"already decided" check (the decisions still open on all the round's calls are read at once, not per call), scoring, calibration, the mode and tier gate, caps, the daily budget, writing the Decision and
its Activity entries, and applying it through the executor. **A type never writes.** The replay
(`scripts/loop-replay.ts`) scores a type's calls against what the owner did later by the type's rule in
`loop/eval/score.ts` (`AGREES`).

## Calls it only observed: `recheck`

The engine moves a call it only observed on to proposed or applied when the type makes the same call again (same
targets, the targets as they were, the same change). A type that finds calls from the round's `entries` alone, or that
counts a call already on record as `already_decided`, would never make it again, so it also implements
`recheck(ctx, observed)`. Outside `observe` the engine hands it the type's decisions still `observed` that this round's
`candidates` did not find again (newest first, at most `recheckLimit`, default `RECHECK_OBSERVED` = 500), and the type
answers, in order, the call as things are now, or why it no longer holds (`holdsStill` maps a floor it is now below to
`no_longer_holds`). A call on targets changed since counts as `target_changed`, another change to them as
`no_longer_holds`; the call found now is made in its place. The engine marks a call that no longer holds `expired`,
so it is not measured again round after round; the same call made again later, on its targets as they were, is
observed again (and moves on outside `observe`). A decision's id includes its targets' `before` fingerprints, so the
same change asked of targets changed since is a new call: one the type finds again on changed targets expires the
observed one and is made in its place, and an applied decision is never the same call: one that left a target as a
new call finds it (the previous `rank_weight` step) is that call's dependency, and one whose targets later steps
brought back to where it found them is history (the new step's `dependsOn` differs, so its id does). A recheck never asks the model: a type whose call rests on
the model's answer (`reword_lesson`'s rewrite, `approve_lesson`'s replay verdict) checks the floors before the model
and keeps the observed call's own text (`callOf`), at most `RECHECK_MODEL_CALLS` (5) a round. `link_misses`,
`rank_weight`, `narrow_scope`, `tune_threshold`, `approve_lesson`, `reword_lesson` and `record_fact` recheck; the
types that read the round's `lessons()` (`retire_lesson`, `reject_lesson`) find their calls again when the sweep comes
round. `link_misses` counts a
pair that no longer repeats as `no_longer_a_repeat` (a neighbour that is not a repeat is `not_a_repeat`).

## Writing one

1. **Hard floors in code.** Apply the type's floors in `candidates`: the least evidence it needs before it makes a call at all (for `approve_lesson`, no lesson check finding, a confirmed miss, paths that resolve and a 60% as-written rate over 10 or more of your decisions; for `retire_lesson`, 60 days, 15 servings and 8 verdicts). A record below a floor is not a
   candidate: count it with `skip(skipped, SKIP.belowFloor)`. Calibration only ever raises the bar above the floors.
2. **Never-target rules.** Use `types/guards.ts`: `lessonNeverTarget` (manual, demo, run or sandbox, may-hold-secret,
   risky-command), `missNeverTarget` (demo, run or sandbox) and `factNeverTarget` (written by you, demo, or a relevance
   you or an operator set); count them as `SKIP.neverTarget`. Check `ctx.inScope(projectKey)` (`SKIP.outOfScope`).
3. **Propose-only.** A call that passes the floors but must not apply on its own sets `proposeOnly` to the reason:
   `ownerTouchedRecently(await ctx.signals(id), ctx.now)` (14 days), or a type's own auto-only rule (merge_duplicates:
   "both approved needs cosine ≥ .95 and paths ⊆ keeper's"). The engine then proposes it at most.
4. **Snapshots.** `before` is each target as it is now, `after` as the decision leaves it, each with its fingerprint:
   `lessonFingerprint` / `factFingerprint` from `@fb/core` (fields in `LESSON_FINGERPRINT_FIELDS`), or `missLinkSnapshot`
   for a miss link. The executor writes `after` with `expect: before.fingerprint`, and a rollback restores `before`.
5. **Evidence.** Pointers (`kind`, `id`, `role`, `weight`, `observedAt`). The decision id hashes the type, targets, policy
   version, each target's `before` fingerprint, the decisions it builds on (`dependsOn`, when any) and each evidence pointer's `kind:id:role`, so keep `role` a stable label ("repeated miss", "verdict
   not_applicable") and put numbers in `features`. Then a second round over the same, unchanged data makes the same id, and nothing new.
6. **Features and weights.** Features in [0, 1] (or small capped counts scaled to [0, 1]). `weights` are the hand-set
   starting weights, `bias` the intercept; the score is `σ(bias + Σ weight·feature)`. Put evidence-strength features in
   `groups.evidence` and blast-radius features in `groups.scope`: an owner's rollback with reason `wrong_evidence` or
   `too_broad` scales those down. Changing weights or features bumps `LOOP_POLICY_VERSION` (core `loop/state.ts`).
7. **Text.** `subject` is one line for Activity and the Decisions list; `rationale` says why for the owner. Both are
   redacted when stored.
8. **Register** the type in `types/index.ts`. Its tier, τ and prior are in core `LOOP_TYPE_INFO`.
9. **Apply and roll back.** The type's target write lives in the core executors (`packages/core/src/decisions`), keyed on
   the decision type: what `after` says must be what it writes, and the rollback restores `before`.
10. **Tests** in `types/<type>.test.ts`, deterministic, with `fakeContext` and the fixtures in `loop/testing/context.ts`:
    each floor on both sides, each never-target rule, propose-only, the features, and "nothing new: nothing read".
    `loop/testing/lessons.ts` has lesson and lesson-detail fixtures.

A type that asks the model does so last, after every deterministic floor, the holdout and its own "already decided"
check, so a round spends no call on a record it cannot act on, and counts its per-round cap in calls asked. `loop/replay.ts` (used by `approve_lesson`) is the example: the pre-done judge's question asked of the
work the owner pushed back on, prompt-only, its data fenced, a call counted only when it cites lines of the diff;
`LoopBudgetSpent` propagates and any other failure is a skip. Tests use a deterministic fake `LlmProvider`.

## Tiers and modes

The tier, τ and prior are per type in `LOOP_TYPE_INFO`. Under `auto`, tier H applies when the 10th percentile of its
calibrated Beta is at least τ (housekeeping starts trusted, at Beta(4,1)); tier A also needs 20 of the owner's own
labels in that confidence band and stays within `LOOP_AUTO_PER_DAY` / `LOOP_AUTO_PER_PROJECT`; tier P is always a
proposal. `observe` records `observed` decisions only; `propose` makes every call a proposal. A call observed in an earlier
round that a later round makes again under `propose` or `auto` moves on from it, recorded with the mode, score and
confidence it is made with then: `mode` always says what the loop did (applied it, proposed it, only observed it).

## The near-duplicate band (0.9.1)

`merge_duplicates` works on two kinds of pair. A lesson the re-check flagged `duplicate-of` (cosine ≥ `DUPLICATE_FLAG`,
0.92) is merged by the rules above. A pair of the round's live lessons of one project with a cosine from
`NEAR_DUPLICATE_FROM` (0.85) up to 0.92 is the middle band: exact and structural rules first (the same title and rule,
case, punctuation and spacing ignored, need no model); otherwise the loop's model (`LOOP_LLM`, metered by
`LOOP_LLM_CALLS_PER_DAY`, at most 5 a round, `loop/nearDuplicate.ts`) answers yes, no or unsure to "do these two say the
same thing?", fenced as data. Yes and unsure are a merge proposed for you (`proposeOnly`: never applied on its own),
no is dropped (`judged_different`); each answer is remembered against both lessons' fingerprints, so an unchanged pair
is never asked twice. The values are in `packages/core/src/thresholds.ts`.

## Renamed files: `update_paths` (0.9.1)

Tier H. After each code map build the worker keeps the renames git saw in the churn window (`git log -M`: old path to
the name the file has now; core `loop/renames.ts`). A proposed or approved lesson whose paths or trigger paths name an
old path gets the new name, exactly that path, only when the old name is gone from the code map and the new one is in
it; globs and folders are left alone. Its handler (`decisions/types/update_paths.ts`) compares paths and triggers
(`lessonPathsFingerprint`, since triggers are not part of the lesson fingerprint) just before writing, so an edit of
yours since is never overwritten, and a rollback restores the old names. A lesson you touched in the last 14 days is
proposed instead (the apply-time veto).

## Knowledge intake's types (0.9.1)

Six types work on what knowledge intake drew from calls and notes. They read claims, questions and conflicts from
`store.intake` (newest first, a page a round; a run's or a sandbox's never), and every one is refused for a claim
`claimNeverTarget` (`types/guards.ts`) names: made in a run, your own answer to a question, from notes an agent
submitted (`origin: agent:<client>`), or flagged `quote-fuzzy` or `statement-adds`. The engine checks that again at
apply time (`applyTimeVeto`). **Choosing which side of a conflict is true is never automatic**: the only type that
touches a conflict is tier P, and `PUT /api/loop/settings` refuses `auto` for every tier P type.

| Type | Tier | What it does | Floors | Handler and rollback |
|---|---|---|---|---|
| `link_claims` | H | Records `(:Claim)-[:CORROBORATES]->(:Claim)` from the newer of two claims from different sources that say the same thing to the older. Detection links the pairs it compares; this finds proposed ones it never compares (a claim waiting for review is compared only within its source). | Same project and type, the same statement once case, punctuation and spacing are ignored (`normalizeStatement`, at least 16 characters), not linked yet. | `link_claims`: the link compared just before it is added (`claimLinkSnapshot`); rollback removes it (`IntakeStore.removeLinks`). |
| `merge_claims` | H | Folds a proposed claim into the claim it corroborates, so you review one: the duplicate becomes `superseded` and keeps its link. | Both live (proposed or accepted), same type and project; the duplicate proposed, never a fact, in no open conflict. The keeper is the accepted one, else the older. | The claims' snapshots in one intake transaction (the `resolve_conflict` handler with no conflict); rollback makes the duplicate proposed again. |
| `accept_claim` | A, τ 0.92 | Accepts a proposed `fact` or `decision` claim and files its fact (origin `claim`, kind `decision` or `convention`, relevance 0.8, embedded from its statement), as the review route does. | No flag; not from an agent's notes; a speaker you confirmed; confidence ≥ 0.8; no open conflict; a project to file it under; your as-written accept rate on claims of its type ≥ 70% over ≥ 20 of your own `claim_decided` decisions (accepted with only the status changed, out of accepted or rejected; an operator's or the loop's are left out). Never an opinion, a plan or a commitment. | The fact first (a created target under a planned id, `addOwnerFact(..., { origin: 'claim' })`), then the claim accepted with its `factId`; rollback makes the claim proposed and closes the fact, and a redo reopens it. |
| `propose_resolution` | P | Suggests how to settle an open conflict: a probable supersession as **B is true**; one whose sides no longer share a scope (a claim re-scoped, a lesson narrowed, a project link removed) as **not a conflict: different scope**. | Both sides still there (an accepted or proposed claim, a current fact, an approved or proposed lesson). | Built by `resolutionDecision`, so approving it is exactly your `resolve_conflict` (the loser superseded, never deleted), with the conflict recording this decision and you as who settled it; rollback reopens the conflict. |
| `assign_question` | P | Suggests who should answer an open, unassigned question: the person who said the most accepted claims on its subject (a shared subject word, `subjectTokens`). | At least 2 such claims and strictly more than anyone else; a person you confirmed. | `updateQuestion` (status `assigned`, the assignee), compared just before; rollback reopens it unassigned. |
| `close_question` | P | Proposes an open or assigned question answered by a later accepted claim, which it cites. | A claim (not an opinion) accepted after the question was asked, sharing at least 2 of the question's subject words and half of them. | `updateQuestion` (status `answered`, `answerClaimId`), compared just before; rollback reopens it. |

Questions are decision targets (kind `question`, `questionSnapshot`: status, assignee, the claim answering it). The
replay (`loop/eval/score.ts`) leaves these types unlabelled for now: your actions on claims are not replayed as labels.

## Triage earned, and what needs you (0.9.1)

A type's `minLabels` can be raised above its tier's: `triage_inbox` is tier A since 0.9.1, with τ 0.9 and 30 labels
(`LOOP_TYPE_INFO`). Its labels from when it was tier P stay: calibration is keyed by type, band and policy version, and
neither its prior nor the policy version changed. Its own floors keep some calls proposals (`triageProposeOnly`): a
confirm of an agent's report or of an item from your own sessions, and any call on words that read as a risky command
or instructions to an agent. Every proposed decision carries `needsYou` on the wire (`needsYouReason`, core
`loop/state.ts`): the reason the loop gave for proposing it, else its tier, the reviews it lacks or its bar.

## Decisions only you make: `resolve_conflict`, `remove_source`

Two decision types are the owner's, never the loop's (`OWNER_DECISION_TYPES` in core `types.ts`, `author: 'owner'`).
They exist so a change you make to what agents see is audited and rolls back through the same executor, not to be
proposed: no loop type returns them, and they have no file in `worker/src/loop/types/`.

| Type | What it records | Rollback |
|---|---|---|
| `resolve_conflict` | Your choice on a knowledge-intake conflict (A is true, B is true, both partly, not a conflict). The API builds the decision with the conflict, the losing side (both, for both partly) and any reconciled fact as targets, and applies it at once (`apply(id, { by: 'you' })`). The loser is superseded, never deleted: a claim marked superseded and the fact it became closed, a fact closed, a lesson superseded, with a `SUPERSEDED_BY` link to the winner. | Reopens the conflict and restores the loser exactly, removing the links; rolling back a loop decision it built on (a reworded lesson) undoes it first. |
| `remove_source` | Deleting an intake source with `keep=none`: the facts its accepted claims became are closed. | Re-opens those facts. |

A lesson you mark as superseding another (`PATCH /api/lessons/:id` with `supersedes`) is a `merge_duplicates` decision
with `author: 'owner'`: the API builds it (the edited lesson the keeper, the other the merged duplicate, set
superseded with your note) and applies it at once through the executor, as a loop merge is applied. It is on the
Decisions page, rolls back the same way (both lessons restored, the SUPERSEDES edge removed), and, as an owner's
decision, is never calibrated, budgeted or counted as the loop's.

Both are tier P in `LOOP_TYPE_INFO`, so they never apply on their own under any mode, and they are left out of
`LOOP_DECISION_TYPES`: never in `LOOP_TYPES`, the loop's settings, its engine, its budgets or its metrics. The
calibration fold (`loop/calibrate.ts`) skips owner-authored decisions (`author: 'owner'`): they carry no loop score, so they never raise or lower a type's earned confidence and never
count as the loop's proposals or rollbacks.

## Applying and rolling back

The engine and the API apply and undo every decision through one executor, `decisionExecutor(store, { embed })` in
`packages/core/src/decisions/executor.ts` (`loopExecutor` is the same `apply` as the engine's `LoopExecutor`). Around
the type's write it owns what is the same for every type:

- **apply**: only an `observed` or `proposed` decision (`DecisionStateError` otherwise; the engine sees `lost`). The
  targets are read and compared with `before`: one that differs means the owner changed it since, so the decision is
  `overridden` and `TargetChangedError` is thrown (the engine sees `changed`). Then `markApplying` (compare-and-set),
  the handler's write, `markApplied` with the targets as written and `decidedBy`. A write that fails puts the decision
  back (`overridden` when it was a `TargetChangedError`).
- **rollback**: only an `applied` decision. Its applied dependents (`dependsOn`, transitively) are undone first,
  newest first, all or nothing: every target must still be as the newest decision in that chain left it. A target of
  the decision itself that differs throws `TargetChangedError` (the API marks it `overridden` and answers 409, unless
  the target is as another applied decision left it: then it answers 409 naming that one and marks nothing); a
  changed dependent throws `CascadeBlockedError`. `cascade: 'preview'` answers `{ cascade, blocked }` and writes
  nothing. `restoreAnyway` (an applied or overridden decision that was applied) writes `before` over the target as it
  is now. Afterwards: `rolled_back` (the cascade on the decision's own record) and the call suppressed (`suppress`).
  The executor writes no Activity and no calibration: the caller records the rollback in Activity, and the loop's next
  fold of that entry (`loop/calibrate.ts`) turns the owner's own rollback into a negative calibration label and its
  reason into a penalty (`loop-penalty:<type>`).
- **never merge** (0.9.1): rolling back a merge (`merge_duplicates`, `merge_claims`, also when a cascade undoes it)
  records its keeper and merged record as a pair you said are not the same (`DecisionsStore.markDistinct`, the decision
  and your note with it); `POST /api/distinct-pairs {a, b, reason?}` records one directly. Unlike the suppression, which
  lifts after 30 days or 1.5 times the evidence, it is permanent: `merge_duplicates` and `merge_claims` skip the pair
  (`distinct`) whatever the evidence, and the near-duplicate judge never asks about it. Only you lift it
  (`DELETE /api/distinct-pairs`), never the operator token.
- **redo**: a `rolled_back` decision applied again, only while its targets are still `before`; its suppression is lifted.
- **reconcile**: at worker start and before each loop round, a decision left `applying` whose lease was not renewed
  for two minutes (`RECONCILE_AFTER_MS`; an apply still running, in any process, renews it every 30 seconds however
  long its embeddings take, so only one whose process died is settled) is `applied` (targets as `after`, by whom and
  with the sync hold its apply recorded at `markApplying`), `proposed` (each target as `before` or `after`: the part a
  crash left written, such as a `record_fact`'s new fact or a split's reworded lesson, is undone by the type's
  rollback) or `overridden` (a target someone else changed). An apply that finds its decision settled meanwhile
  returns it when it was applied, and is refused otherwise.
- `dependenciesOf(store, before)` gives the `dependsOn` of a new decision: the applied decisions whose `after` is its
  `before`. The engine records it on every call it makes, whatever the types, so rolling back a lesson's weight step
  also undoes a later retire of that lesson first.

### A type's handler

`packages/core/src/decisions/types/handler.ts`. A type with its own target write has one file
`decisions/types/<type>.ts` with one named export (`linkMisses` in `link_misses.ts`), listed in
`decisions/types/index.ts` (`DECISION_HANDLERS`); `handlerFor(type)` takes it before the built-in `genericHandler`.

```ts
type HandlerContext = { store: DecisionExecStore; deps: { embed?: Embed }; by: string };
type DecisionTypeHandler = {
  snapshot?(c, d): Promise<TargetSnapshot[]>;   // the targets now, comparable with before/after (default below)
  apply(c, d): Promise<void>;                    // write d.after over targets still d.before
  rollback(c, d, from): Promise<void>;           // write d.before over targets still `from` (d.after, or now)
};
```

A handler only writes targets, all or nothing, with the `from` fingerprints as `expect`, and throws
`TargetChangedError` for a target that differs (nothing written). It never touches the decision's status.

`genericHandler` covers most types with no file of their own. Its targets are the kinds and ids `before` and `after`
name, each read by `snapshotTarget`, and it moves them in this order, moving back what it wrote when a later kind fails:

| Kind | Snapshot | Write |
|---|---|---|
| `fact` | `factSnapshot`: `factStateFingerprint` (ABSENT when closed or gone) plus `projectKey` and `why` | `writeFactSnapshots` (relevance, relevanceBy, current; closing keeps the scores); a fact absent in `from` and not stored is added under its planned id (`addOwnerFact(..., { id })`, needs `embed`) |
| `candidate` | `candidateSnapshot`: status, note, decidedBy | compared just before; `decide`, or `undoDecision` back to pending (refused once a post-mortem tried it) |
| `lesson` | `lessonSnapshot`: `LESSON_FINGERPRINT_FIELDS` | `writeLessonSnapshots`, one transaction, the fields to the letter (decidedAt, decidedBy, decisionNote and servingWeight included, so `rank_weight` needs no handler of its own); new words re-embedded when `embed` is given; a `merged` target newly superseded gets the `keeper`'s SUPERSEDES edge (removed when it is no longer superseded), whether or not the keeper itself changes |

Creating or removing a lesson and a miss, and any project write, are not generic: `UnsupportedTargetError`. A project
target snapshots as its own floors (`thresholdsSnapshot`), which `tune_threshold`'s handler writes
(`setProjectThresholds`, with `expect`). A target that does not
exist is `absentSnapshot` (`ABSENT`), which is how a decision's `before` names a record it creates.

Types with their own handler:

| Type | Handler |
|---|---|
| `link_misses` | the REPEATS link, compared just before it is made or removed |
| `merge_duplicates` | both lessons and the keeper's SUPERSEDES edge over the duplicate in one transaction (`writeLessonTargets` with `supersede`), every lesson target written even when unchanged so the keeper is compared; rollback restores both and removes the edge |
| `retire_lesson` | the lesson's snapshot written in one transaction (`writeLessonTargets`): revoked as the loop decided; rollback restores it approved with your original decision |
| `reject_lesson` | the lesson's snapshot written in one transaction (`writeLessonTargets`): rejected; rollback returns it to proposed and undecided |
| `tune_threshold` | the project's own floors (`setProjectThresholds`, `expect` the `from` fingerprint) |
| `reword_lesson` | the new words are the generic lesson write; a split also creates the lesson it splits off (role `created`, ABSENT before) with `addLoopLesson`, from the same miss and marked `splitFrom`. Rollback removes it first (`removeLoopLesson`, only a lesson the loop split off, only as `from` has it) and then restores the original; each step moves back what it wrote when the next fails |
| `record_fact` | a fact the decision creates is added as the loop's (`addOwnerFact(..., { id, origin: 'loop' })`: no scan closes, replaces or re-checks it), then the generic write rejects the lesson; the fact is closed again when that fails. Rollback is the generic one (the fact closed, the lesson restored); a redo reopens the fact |
| `resolve_conflict` | the fact and lesson targets through the generic write (a created reconciled fact under its planned id), then the claims and the conflict with the `SUPERSEDED_BY` links in one intake transaction (`IntakeStore.writeSnapshots`); the facts and lessons are moved back when that fails. Rollback is the reverse |

`accept_claim` and `merge_claims` use `resolve_conflict`'s handler, `propose_resolution` wraps it (the conflict records the decision that settled it and who approved it), `link_claims` has its own (the CORROBORATES link, like `link_misses`), and `assign_question` and `close_question` share `question.ts`.

`rank_weight`, `approve_lesson`, `narrow_scope` and `triage_inbox` have no handler of their own: `genericHandler`.
