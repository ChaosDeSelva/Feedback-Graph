# Learning loop: the REST contract the UI uses

The Decisions page, the Learning loop page, the Settings tab, the Dashboard card, the Lessons card and the sidebar badge
read and write the learning loop through these routes. The UI's types are in `packages/ui/src/api.ts` (section
"Learning loop") and mirror core's Decision types; this page says what each route answers. JSON throughout; times are
ISO 8601 strings.

Reads follow the existing auth (browser session or API token; tokenless installs read only). Every write is an owner
route (`OWNER_ROUTES`): approve, reject, keep, rollback and notes under the operator verb `loop_decide`, settings, pause
and resume under `loop_settings`. A store outage answers 503 (`withStoreDeadline`); the UI treats any 5xx or no answer as
an outage and keeps retrying reads.

Values the UI does not know (a newer type, status, event kind, reason or phase) are shown as their own text, so the API
may add values without breaking older pages.

## Decisions

### `GET /api/decisions`

Query (all optional): `status`, `type`, `project`, `mode` (`auto` | `propose` | `observe`: the decision's own mode),
`band` (0-4), `target` (any target id), `since` and `until` (ISO times, compared as instants on both stores: any offset
names the same time, and one beyond ±14:00 is a 400; `createdAt >= since` and `< until`), `appliedSince` (an ISO time,
likewise; `appliedAt >= appliedSince`, and the list is then newest applied first), `q` (text search over the rationale
and target ids), `idPrefix` (decisions whose id starts with it; `fg decisions show <prefix>` asks with it), `limit` (default 100, at most 500), `offset`, `after` (the `x-next-after` of the page before).

Answers `Decision[]`, newest first, with an `x-next-offset` header when there is another page (the same paging as
`GET /api/candidates`; a page fetched with `after` gets none) and, in created order (no `appliedSince`), an `x-next-after` cursor: the next page by keyset,
which reads a deep page as fast as the first. `after` goes with neither `offset` nor `appliedSince` (a 400), and a
cursor this API did not give is a 400. Only shown projects' decisions (and those of no project) are paged, so a hidden decision never
fills a page or sets the header. Every status is listed, including `observed`, `rolled_back`, `overridden` and `expired`: this
is the audit log. `expired` is a call the loop only observed, measured again once its type proposes or applies and
found no longer to hold (`decidedBy` the loop; the round's skip reason says why); made again later, on its targets as
they were, it is observed again and moves on. The export buttons page through this route with `limit=500`.

`Decision` is core's type (`packages/core/src/types.ts`), with `before`, `after` as `TargetSnapshot[]`:

```ts
TargetSnapshot = { kind: 'lesson'|'fact'|'miss'|'candidate'|'project'|'claim'|'conflict'|'question', id: string, fields: Record<string, unknown>, fingerprint: string }
EvidenceRef    = { kind: 'activity'|'miss'|'lesson'|'fact'|'check'|'session'|'candidate'|'claim'|'conflict'|'question', id, role: string, weight: number, observedAt }
confidence     = { p, lower, n, band }   // n: the owner's own labels for this type and band
needsYou?      : string                  // a proposed decision only (0.9.1): why the loop could not decide it, in one line
```

`GET /api/distinct-pairs?ids=a,b`, `POST /api/distinct-pairs {a, b, reason?}` and `DELETE /api/distinct-pairs {a, b}`
(yours only) read, record and lift the pairs the loop never merges (0.9.1, [types](learning-loop-types.md)).

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
  restoreAnyway?: true,               // rollback of an `overridden` decision that was applied (a 409 otherwise): write `before` over the target as an owner edit
}
```

- `approve` and `reject` take `proposed` or `observed` decisions; `keep` (ratify) takes `applied` ones. Each answers the
  updated `Decision`. Their `note` is written after the action: when it cannot be saved, the action still stands and
  the answer adds `noteError` saying so.
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

### `POST /api/decisions/:id/notes`

Body `{ text: string, verdict?: 'agree'|'disagree'|null, reason?: <reason> }` (reason only with `disagree`). Answers the
new `DecisionNote` (`{ id, decisionId, ts, by, text, verdict?, reason? }`) with 201. Not retried by the UI.

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
  counts: { proposed, week: { observed, proposed, applied, rolledBack } },   // proposed: waiting now (the sidebar badge); counted in the store, all of them
  rollbackRate: { rolledBack, of },                // all types, last 30 days
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

The counts and the rollback rate are counted in the store (`DecisionsStore.count`), for the shown projects (read once
a request), so the route reads the same few queries however many decisions there are. `holdout` is core's
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
the type's `tauDefault` or above 1 is a 400. Setting a tripped type's mode resets its breaker. Answers the new
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
