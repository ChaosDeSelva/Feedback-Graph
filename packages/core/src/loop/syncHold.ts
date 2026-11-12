import { ABSENT, canonicalJson } from '../decisions/record.ts';
import type { Lesson, TargetSnapshot } from '../types.ts';

/**
 * The cloud sync hold (LOOP_SYNC_HOLD_DAYS): a lesson or fact the loop changed on its own is exported as it was before,
 * so a team copy is not approved, revoked or reworded by the loop alone, until the owner keeps the decision (ratifies
 * it) or its syncHoldUntil passes without a rollback. A rolled-back decision restored its targets already, and one the
 * owner overrode leaves the owner's change, which is shared: only applied decisions hold (and one still applying,
 * whose write may have landed before a crash: reconcile settles it later), and only a target still as
 * the loop left it (an owner's edit, revoke or reject since is exported as it is, even before anything marks the
 * decision overridden). Both stores' exportData read the held decisions and apply this, so a file export carries no
 * unratified loop change either.
 */

/** A loop decision still held (applied, or applying): what its targets were before it, and as it leaves them; appliedAt: when it was applied, or began applying. */
export type HeldDecision = { appliedAt: string; before: TargetSnapshot[]; after: TargetSnapshot[] };
/** A held target: the snapshot to export it from, and as the newest held decision left it. */
export type HeldTarget = { before: TargetSnapshot; after: TargetSnapshot | null };

/** The lesson fields an export carries that a decision's snapshot can hold an earlier value of. */
const LESSON_FIELDS = ['projectKey', 'title', 'rule', 'appliesWhen', 'scope', 'paths', 'status', 'decidedAt'] as const;
/** The same for a fact. */
const FACT_FIELDS = ['kind', 'statement', 'path', 'lines', 'why'] as const;

/**
 * Per target (`kind:id`), the snapshot to export it from: the `before` of its earliest held decision (a later one's
 * `before` is the earlier one's `after`, which is held too); and the `after` of its newest, which the target must still
 * be for the hold to apply.
 */
export function heldTargets(held: readonly HeldDecision[]): Map<string, HeldTarget> {
  const out = new Map<string, HeldTarget>();
  for (const d of [...held].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))) {
    for (const s of d.before) {
      const key = `${s.kind}:${s.id}`;
      out.set(key, { before: s, after: out.has(key) ? out.get(key)!.after : (d.after.find((a) => a.kind === s.kind && a.id === s.id) ?? null) });
    }
  }
  return out;
}

/** The ids of held targets of this kind: the stores read these too, whatever their state now (a revoked lesson's earlier approval). */
export const heldIds = (held: Map<string, HeldTarget>, kind: TargetSnapshot['kind']) => [...held.values()].filter((h) => h.before.kind === kind).map((h) => h.before.id);

/** A target that did not exist before its decision (or, a fact, was not current): it is not exported while held. */
const absent = (s: TargetSnapshot) => s.fingerprint === ABSENT || (s.kind === 'fact' && s.fields.current === false);

function overlay<T extends object>(row: T, s: TargetSnapshot, fields: readonly string[]): T {
  const out = { ...row } as Record<string, unknown>;
  for (const f of fields) if (Object.hasOwn(s.fields, f)) out[f] = s.fields[f];
  return out as T;
}

/** Whether the exported row still has, in every field it carries, what the decision left: no one changed it since. */
function asLeft(row: object, after: TargetSnapshot | null, fields: readonly string[]): boolean {
  if (!after) return false;
  const r = row as Record<string, unknown>;
  return fields.every((f) => !Object.hasOwn(after.fields, f) || !Object.hasOwn(r, f) || canonicalJson(r[f] ?? null) === canonicalJson(after.fields[f] ?? null));
}

/** The held snapshot this row is exported from, or null when it is not held (or changed since the loop left it). */
function heldFor(row: { id: string }, kind: TargetSnapshot['kind'], held: Map<string, HeldTarget>, fields: readonly string[]): TargetSnapshot | null {
  const h = held.get(`${kind}:${row.id}`);
  return h && asLeft(row, h.after, fields) ? h.before : null;
}

/**
 * Which project an export is of: one (`key`, its lessons and its global lessons that came from it), some (`keys`, and
 * every global lesson), or all.
 */
export type ExportScope = { key: string | null; keys: string[] | null };

/** Whether a lesson, as exported, belongs in this export: its project, or for a global one the project it came from. */
function inScope(projectKey: string | null, origin: string | null, scope: ExportScope): boolean {
  if (scope.key !== null) return projectKey === scope.key || (projectKey === null && origin === scope.key);
  const home = projectKey ?? origin;
  return scope.keys === null || home === null || scope.keys.includes(home);
}

/**
 * Lessons as exported under the hold; `approvedOnly` applies to the held status (the stores read held ones regardless,
 * in any project). A held lesson goes with its project as it was: one the loop moved (narrow_scope) is exported where it
 * was before, not where the loop moved it. origins: each lesson's originProjectKey.
 */
export function holdLessons(lessons: Lesson[], held: Map<string, HeldTarget>, approvedOnly: boolean, scope: ExportScope, origins: Map<string, string | null>): Lesson[] {
  const out: Lesson[] = [];
  for (const l of lessons) {
    const s = heldFor(l, 'lesson', held, LESSON_FIELDS);
    const shown = s ? (absent(s) ? null : overlay(l, s, LESSON_FIELDS)) : l;
    if (shown && (!approvedOnly || shown.status === 'approved') && inScope(shown.projectKey, origins.get(l.id) ?? null, scope)) out.push(shown);
  }
  return out;
}

/** Facts (with their ids, which the export itself leaves out) as exported under the hold. */
export function holdFacts<T extends { id: string }>(facts: T[], held: Map<string, HeldTarget>): T[] {
  const out: T[] = [];
  for (const f of facts) {
    const s = heldFor(f, 'fact', held, FACT_FIELDS);
    if (!s) out.push(f);
    else if (!absent(s)) out.push(overlay(f, s, FACT_FIELDS));
  }
  return out;
}
