# Learning loop: the REST contract the UI uses

The Decisions page, the Learning loop page, the Settings tab, the Dashboard card, the Lessons card and the sidebar badge
read and write the learning loop through these routes. The UI's types are in `packages/ui/src/api.ts` (section
"Learning loop") and mirror core's Decision types; this page says what each route answers. JSON throughout; times are
ISO 8601 strings.

Reads follow the existing auth (browser session or API token; tokenless installs read only). Every write is an owner
route (`OWNER_ROUTES`): approve, reject, keep, rollback, notes and the never-merge pairs under the operator verb
`loop_decide`, settings, pause and resume under `loop_settings` (both off by default in `OPERATOR_ALLOW`). A store outage answers 503 (`withStoreDeadline`); the UI treats any 5xx or no answer as
an outage and keeps retrying reads.

Values the UI does not know (a newer type, status, event kind, reason or phase) are shown as their own text, so the API
may add values without breaking older pages.

## Decisions

### `GET /api/decisions`

Query (all optional): `status`, `type`, `project`, `mode` (`auto` | `propose` | `observe`: the decision's own mode),
`band` (0-4), `target` (any target id), `since` and `until` (ISO times, compared as instants on both stores: any offset
names the same time, and one beyond ±14:00 is a 400; `createdAt >= since` and `< until`), `appliedSince` (an ISO time,
likewise; `appliedAt >= appliedSince`, and the list is then newest applied first), `q` (text search over the rationale
and target ids), `idPrefix` (decisions whose id starts with it; `fg decisions show <prefix>` asks with it), `limit` (default 100, at most 500), `offset`, `after` (the `x-next-after` of the page before). `sort=score` (0.9.4) orders the first 500 matches by approve score, highest first, unscored last, and pages them by `offset`; it does not go with `after` (a 400).

Answers `Decision[]`, newest first, with an `x-next-offset` header when there is another page (the same paging as
`GET /api/candidates`; a page fetched with `after` gets none) and, in created order (no `appliedSince`), an `x-next-after` cursor: the next page by keyset,
which reads a deep page as fast as the first. `after` goes with neither `offset` nor `appliedSince` (a 400), and a
cursor this API did not give is a 400. Only shown projects' decisions (and those of no project) are paged, so a hidden decision never
fills a page or sets the header. Every status is listed, including `observed`, `rolled_back`, `overridden` and `expired`: this
is the audit log. `expired` is a call the loop only observed, measured again once its type proposes or applies and
found no longer to hold (`decidedBy` the loop; the round's skip reason says why); made again later, on its targets as
they were, it is observed again and moves on. The export buttons page through this route with `limit=500`. The
Decisions page's default view, **needs you**, is `status=proposed`.

`Decision` is core's type (`packages/core/src/types.ts`), with `before`, `after` as `TargetSnapshot[]`:

```ts
TargetSnapshot = { kind: 'lesson'|'fact'|'miss'|'candidate'|'project'|'claim'|'conflict'|'question', id: string, fields: Record<string, unknown>, fingerprint: string }
EvidenceRef    = { kind: 'activity'|'miss'|'lesson'|'fact'|'check'|'session'|'candidate'|'claim'|'conflict'|'question', id, role: string, weight: number, observedAt }
confidence     = { p, lower, n, band }   // n: the owner's own labels for this type and band
needsYou?      : string                  // a proposed decision only (0.9.1): why the loop could not decide it, in one line
approveScore   : number | null           // 0.9.4: 0-10, the chance you approve it (proposed by the loop only; else null)
scoreWhy       : string | null           // the score and its top reasons in one line: "6.4 · you confirmed 9 of 10 ..."
```

`approveScore` is core's `scoreDecision` (`packages/core/src/loop/approveScore.ts`). A call on one reviewed item
(`triage_inbox`, `approve_lesson`, `reject_lesson`, `accept_claim`) scores as its item does since 0.9.5 (your verdicts on
similar items and the item's facts; 10 minus that when the call rejects it); any other call reads the type's current
calibrated *p* in the decision's band, pulled toward 5 by the posterior's width. It ranks; it never gates auto-apply. It is not `score`, which stays the loop's raw score. See the
guide's **Approve score**.

`needsYou` is core's `needsYouReason`: the reason the loop gave for proposing rather than applying it (its rationale's
"Proposed rather than applied: …" or "Proposed only: …"), else "always your call" for a tier P type, "not earned yet"
with the reviews of yours it has and needs in its confidence band, "not sure enough to apply" with its confidence and
bar, or that the loop is set to propose this type.

### `GET /api/decisions/:id`

```ts
{
  decision: Decision,
  current: TargetSnapshot[],          // each target now, redacted like the snapshots; a target that is gone is left out
  evidence: (EvidenceRef & {
    label: string,                    // one line to show (a lesson's title, an entry's subject, a session's summary)
    projectKey?: string | null,       // for a fact: where its module panel is
    path?: string | null,
    activity?: Activity | null,       // for kind 'activity': the entry itself (as GET /api/activity/:id)
    missing?: boolean,                // the thing it points at no longer exists, or is of a project not shown
  })[],
  dependsOn: DecisionSummary[],       // of shown projects only, as dependents
  dependents: DecisionSummary[],      // later decisions whose `dependsOn` names this one
  notes: DecisionNote[],              // oldest first
}
DecisionSummary = { id, type, status, createdAt, projectKey, label }
```

The UI computes the field diff itself from `before`, `after` and `current`: a field shows when before ≠ after, or when
after ≠ now. It shows a "now" column when the decision is `overridden` or any target changed since it was applied.
Unknown id: 404.

### `POST /api/decisions/:id/approve | reject | keep | rollback`

Body:

```ts
{
  expect: DecisionStatus,             // the status the page showed; any other current status answers 409
  note?: string,
  reason?: 'wrong_evidence'|'too_broad'|'wording'|'not_now'|'other',
  cascade?: 'preview'|'apply',        // rollback only; default 'apply'
  restoreAnyway?: boolean,            // rollback of an `overridden` decision only (a 400 otherwise): write `before` over the target as an owner edit
}
```

`cascade` or `restoreAnyway` with any action but `rollback` is a 400. Rolling back an `overridden` decision without
`restoreAnyway: true` is a 409.

- `approve` and `reject` take `proposed` or `observed` decisions; `keep` (ratify) takes `applied` ones; `rollback`
  takes `applied` ones, and `overridden` ones with `restoreAnyway`. Each answers the updated `Decision`. The `note` is
  kept among the decision's notes, written after the action: as `agree` for approve and keep, as `disagree` with the
  `reason` for reject and rollback. When it cannot be saved, the action still stands and the answer adds `noteError`
  saying so. A reject's or rollback's `reason` is also on its Activity entry.
- `rollback` with `cascade: 'preview'` changes nothing and answers `{ cascade: DecisionSummary[], blocked: { id, reason }[] }`:
  the dependents it would also undo (newest first) and anything that blocks it (a dependent whose target the owner
  changed). The UI disables the confirm button while `blocked` is not empty. When the decision's own target changed
  since it was applied (the owner's edit, or the worker's), the preview answers 409 with `{ error }` instead and marks
  the decision `overridden`, as `apply` would; the UI then offers **Restore anyway** in the same dialog.
- `rollback` with `cascade: 'apply'` undoes the cascade and the decision, all or nothing, and answers the updated
  `Decision`. When the owner changed a target since the decision was applied, it answers 409 with `{ error }` and marks
  the decision `overridden`; the UI then reloads it and offers **Restore anyway** (`restoreAnyway: true`).
- Two changed targets are not the owner's, so both kinds of rollback answer 409 and mark nothing: a target another
  still-applied decision left as it is answers `{ error, blocked: [{ id, reason }] }` naming that decision (roll it back
  first), and a target already back at `before` (another rollback of the same decision, such as a double click, is
  restoring it) answers `{ error }` asking you to reload.
- A 409 for a stale `expect` also carries `{ error }`, which the UI shows before reloading the decision.
- `approve` whose target changed since the decision was made: 409, and the decision is `overridden` (nothing written).
- `rollback` with `cascade: 'apply'` that a dependent blocks: 409 with `{ error, blocked }`, nothing written and nothing
  marked. A change the executor cannot make (creating or removing a target its type has no handler for): 422. An API with no executor: 501 for
  `approve` and `rollback`.
- Each action is recorded in Activity as the actor (`you`, `operator:<name>`): approve `decision_applied`, reject and
  keep `decision_made`, rollback one `decision_rolled_back` per decision undone (the cascaded ones with
  `details.action: 'cascade'` and `cascadeOf`), Restore anyway `decision_rolled_back` with `action: 'restore_anyway'`,
  and a decision marked overridden by a refused action `decision_made` with `action: 'overridden'`. `details` always
  carries `decisionId`, `decisionType`, `status` and `action`.

- Rolling back a merge (`merge_duplicates`, `merge_claims`), also one a cascade undoes, records its keeper and merged
  record as a never-merge pair (below), with your note in its reason.

### `POST /api/decisions/:id/notes`

Body `{ text: string, verdict?: 'agree'|'disagree'|null, reason?: <reason> }` (reason only with `disagree`, a 400
otherwise). Answers the new `DecisionNote` (`{ id, decisionId, ts, by, text, verdict?, reason? }`) with 201 and logs
`decision_noted`. Not retried by the UI.

### Never-merge pairs (0.9.1)

Two records you said are not the same: `merge_duplicates` and `merge_claims` never merge them, whatever the evidence,
and the near-duplicate judge never asks about them ([types](learning-loop-types.md#applying-and-rolling-back)). A
pair is stored once, its ids in order (`a < b`).

- `GET /api/distinct-pairs?ids=a,b` (up to 200 ids, at least one: a 400 otherwise): the pairs naming any of them, either
  way round, as `{ a, b, by, reason, decisionId, at }[]` (`decisionId`: the rolled-back merge that recorded it, or null).
- `POST /api/distinct-pairs {a, b, reason?}` (two different ids): records one. Answers `{ created, pairs }` (the pairs
  naming `a`), 201 when it is new and 200 when it was there already; a new one logs `decision_noted` with
  `details.distinct: [a, b]`.
- `DELETE /api/distinct-pairs {a, b}`: lifts one, 204 (404 when there is none). Yours alone: the operator token is
  refused with 403. Logs `decision_noted` with `details.distinctLifted: [a, b]`.

The Decisions page shows these on a merge decision's **Never merge** card: **Never merge these two** posts the pair,
and each record listed has **Lift**.

## The loop

### `GET /api/loop`

```ts
{
  mode: 'off'|'observe'|'propose'|'auto',          // as set
  effectiveMode: <mode>,                           // what runs after LOOP_DISABLED, a pause and the tokenless cap
  disabled: boolean,                               // LOOP_DISABLED=1
  paused: { at, by } | null,
  capped: 'tokenless'|'disabled'|'paused'|null,
  policyVersion: number,
  types: {
    type, tier: 'H'|'A'|'P',
    mode: <mode> | null,                           // the per-type override; null follows the global mode
    effectiveMode: <mode>,
    tau: number, tauDefault: number,
    calibration: { p, lower, n },                  // over all bands, owner labels only
    bands: { band, alpha, beta, n, p, lower }[],   // the 5 bands
    rollbackRate: { rolledBack, of },              // over its last applied decisions
    breaker: { tripped: boolean, at: string|null, reason: string|null },   // at: when it tripped, or when you last reset it by setting its mode (it counts from then)
  }[],
  budget: { llmCallsToday, llmCallsPerDay, autoToday, autoPerDay, autoPerProject },
  counts: { proposed, week: { observed, proposed, applied, rolledBack } },   // proposed: waiting now (the sidebar badge); counted in the store, all of them; week: made in the last 7 days
  rollbackRate: { rolledBack, of },                // all types, decisions made in the last 30 days and applied
  round: {
    id, startedAt, finishedAt: string|null,
    phase: 'reading'|'scoring'|'writing'|'done'|'aborted',
    signalsIngested, targetsScored, targetsTotal: number|null,
    decisions: { observed, proposed, applied, skipped },
    skipped: { reason, count }[],                  // e.g. suppressed, owner_touched, budget, below_floor
    llmCalls, error: string|null,
  } | null,                                        // the current round, or the last one
  holdout: { share, treated: Arm, control: Arm } | null,   // Arm = { lessons, repeatRate, helpfulRate, ciLow, ciHigh }
}
```

The counts and the rollback rates are counted in the store (`DecisionsStore.count`), for the shown projects (read once
a request), and only of the loop's own decisions: yours (`resolve_conflict`, `remove_source`, a supersede you set) are
never its proposals or rollbacks. So the route reads the same few queries however many decisions there are. `holdout` is core's
`loopHoldout(store.decisions, LOOP_HOLDOUT, { projectKeys })`. It is intention-to-treat: `treated`
is every eligible lesson outside the holdout, changed or not. Both arms count only lessons served at least once.
`repeatRate` is the share whose miss happened again. `helpfulRate` is addressed and not-addressed verdicts out of
those plus not-applicable ones, and `ciLow`/`ciHigh` are its 95% Wilson interval. It is null when `LOOP_HOLDOUT` is 0
or an arm has no served lesson. docs/operations.md, "Measuring the learning loop", has the details.

### `GET /api/loop/metrics`

The learning loop's value over the last weeks (`weeks`, default 8), as core's `readLoopMetrics` computes it:

```ts
Rate = { k, n, rate, ciLow, ciHigh }               // k of n, 95% Wilson interval; rate 0 and [0, 1] when n is 0
{
  since: string, weeks: number,                     // the window's first ISO week (2026-W40)
  repeatRate: Rate & { weekly: { week, feedback, repeats }[] },
  checksCaughtGap: Rate,                            // done-checks (all time) that found a gap
  gapsFixedPerServed: Rate,                         // over eligible lessons
  notApplicableShare: Rate,                         // not_applicable and cannot_tell of all verdicts
  proposalsPerWeek: { week, proposals }[],          // every week of the window, oldest first
  rollbackRate: { type, rolledBack, of, rate: Rate }[],   // every type, decisions applied in the window
}
```

The decisions are counted in the store, however many (they were read up to 5,000, which on a busy store left the
older weeks at 0). The feedback patterns behind `repeatRate` are kept for a minute per set of shown projects.

An API without the loop answers 404: the UI then shows no badge and no Dashboard card.

### `PUT /api/loop/settings`

Body `{ mode?, types?: { [type]: { mode?: <mode>|null, tau?: number|null } } }`; only what changed is sent. `tau` below
the type's `tauDefault` or above 1 is a 400, and so is `mode: 'auto'` for a tier P type (always a proposal: set
`observe`, `propose` or `off`). Setting a tripped type's mode resets its breaker. Answers the new
`GET /api/loop` body and logs `loop_settings_changed`.

### `POST /api/loop/pause`, `POST /api/loop/resume`

Body `{}`. Answer the new `GET /api/loop` body. Each logs `loop_paused` (`details.paused` true for a pause, false for a resume) when it changes something; a pause while paused, or a resume while running, logs nothing. Refused with 409 while `disabled`.

### `GET /api/loop/events?after=<cursor>`

The live stream, polled every few seconds. Without `after`: the latest events (up to 100); with it: the events after it
(up to 100). Oldest first either way.

```ts
{
  events: { seq: string, ts, kind, actor, subject, decisionId: string|null, decisionType: string|null, status: string|null, projectKey: string|null }[],
  next: string,     // an opaque cursor: send it as `after` next time (it does not change when there were no events; a bare seq as `after` is a 400)
  gap: boolean,     // events after `after` were dropped (it fell behind retention): the page says so and reloads the state
}
```

`kind` is one of the loop's Activity kinds (`decision_made`, `decision_applied`, `decision_rolled_back`,
`decision_noted`, `loop_settings_changed`, `loop_paused`) or `loop_round`, the round-progress record the worker writes
each tick. Run-labelled and sandbox entries are left out, as on the Activity page.

### `GET /api/loop/lessons/:id/track`

Why the loop believes what it does about one lesson:

```ts
{
  lessonId, title, projectKey,
  signals: {
    served, lastServed: string|null, sessions,
    addressed, notAddressed, notApplicable, cannotTell,
    gapsFixed, repeatServed, repeatUnserved, ownerPushbackAfter, ownerEdits, ownerRejects,
    holdout: boolean,                               // in the control group (core's lessonHeldOut(lesson, LOOP_HOLDOUT)): never changed
  },
  timeline: { ts, kind: 'served'|'judged'|'gap_fixed'|'repeat'|'owner'|'decision', label, sessionId: string|null, decisionId: string|null }[],   // newest first
}
```

Unknown lesson, or one of a project not shown (a global lesson by the project it was learned in): 404. The timeline
lists only the shown projects' entries and decisions.

## Activity

The loop's entries use the Activity kinds above and the actor `loop:<policy version>` (`loop:breaker` for the circuit
breaker). `GET /api/activity?kind=<loop kind>` filters to them like any other kind.

Your own change to a lesson, fact or Inbox item (an edit, a decision, a relevance) expires the loop's calls still
observed or proposed on it whose targets it changed, so none waits for an approve that could only fail. Each such change
writes one `decision_made` entry by you, however many it expired (0.9.1): `details.action: 'expired_by_you'`,
`details.expired` the count, and up to 25 of them in `details.decisions`. The Decisions page adds up these entries'
counts over the last 7 days ("N waiting proposals expired in the last 7 days: you decided their targets yourself") with
**Show expired**, which filters the list to `expired`. An applied decision whose target you changed is marked
`overridden` instead, with one entry each (`action: 'overridden'`).
