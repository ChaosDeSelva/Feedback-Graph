import type { Decision, TargetSnapshot } from '../types.ts';
import { ABSENT } from './record.ts';
import { currentTargets } from './apply.ts';
import { snapshotOf, type DecisionExecStore } from './snapshot.ts';

/** Why a decision in a rollback cannot be undone. */
export type Blocked = { id: string; reason: string };
/**
 * What a rollback undoes besides the decision: its applied dependents, newest first, and what blocks any of it. own: the
 * decision's own target that changed since (also in blocked), so the caller can tell whose change it was.
 */
export type CascadePlan = { cascade: Decision[]; blocked: Blocked[]; own: OwnChange | null };

/** Applied decisions by when they were applied (fixed-width ISO times), then id. */
const newestFirst = (a: Decision, b: Decision) => `${b.appliedAt}|${b.id}`.localeCompare(`${a.appliedAt}|${a.id}`);

/**
 * The earlier applied decisions a new one builds on: those whose `after` is, for one of its targets, exactly that
 * target's `before`. What Decision.dependsOn records when the engine proposes it.
 */
export async function dependenciesOf(s: Pick<DecisionExecStore, 'decisions'>, before: TargetSnapshot[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const b of before) {
    if (b.fingerprint === ABSENT) continue;
    for (const d of await s.decisions.forTarget(b.id)) {
      if (d.status === 'applied' && d.after.some((a) => a.id === b.id && a.kind === b.kind && a.fingerprint === b.fingerprint)) ids.add(d.id);
    }
  }
  return [...ids].sort();
}

/** Every applied decision that depends on `d`, directly or through another, newest first. */
export async function appliedDependents(s: Pick<DecisionExecStore, 'decisions'>, d: Pick<Decision, 'id'>): Promise<Decision[]> {
  const seen = new Map<string, Decision>();
  const queue = [d.id];
  while (queue.length) {
    for (const dep of await s.decisions.dependents(queue.shift()!)) {
      if (dep.status !== 'applied' || seen.has(dep.id)) continue;
      seen.set(dep.id, dep);
      queue.push(dep.id);
    }
  }
  return [...seen.values()].sort(newestFirst);
}

/** A target of `d` itself changed since it was applied (the owner's edit): what a rollback refuses with a 409. */
export type OwnChange = { targetId: string; expected: string; actual: string | null };

/**
 * Check a rollback's chain (the dependents, newest first, then `d`): every target must still be as the newest decision
 * in the chain that touched it left it. A target that is not blocks that decision. own: one of `d`'s own (skipped with
 * restoreAnyway, which writes over it).
 */
export async function checkChain(s: DecisionExecStore, d: Decision, cascade: Decision[], o: { restoreAnyway?: boolean } = {}): Promise<{ blocked: Blocked[]; own: OwnChange | null }> {
  const expected = new Map<string, { snapshot: TargetSnapshot; by: Decision }>();
  for (const x of [...cascade, d]) {
    for (const a of x.after) if (!expected.has(`${a.kind}:${a.id}`)) expected.set(`${a.kind}:${a.id}`, { snapshot: a, by: x });
  }
  const now = new Map<string, TargetSnapshot[]>();
  const blocked = new Map<string, Blocked>();
  let own: OwnChange | null = null;
  for (const e of expected.values()) {
    if (e.by === d && o.restoreAnyway) continue;
    if (!now.has(e.by.id)) now.set(e.by.id, await currentTargets(s, e.by));
    const cur = snapshotOf(now.get(e.by.id)!, e.snapshot);
    if (cur.fingerprint === e.snapshot.fingerprint || blocked.has(e.by.id)) continue;
    blocked.set(e.by.id, { id: e.by.id, reason: `${cur.kind} ${cur.id} changed since it was applied` });
    if (e.by === d) own = { targetId: cur.id, expected: e.snapshot.fingerprint, actual: cur.fingerprint === ABSENT ? null : cur.fingerprint };
  }
  return { blocked: [...blocked.values()], own };
}

/**
 * What someone changed since `d` (applied) was applied: the first of its targets, or of a later decision built on it,
 * that is no longer as the newest decision in that chain left it (why, in words); null when none. An owner's edit,
 * revoke or reject of a loop-changed target reads here, which no rollback attempt has to find first.
 */
export async function changedSince(s: DecisionExecStore, d: Decision): Promise<string | null> {
  const { blocked, own } = await checkChain(s, d, await appliedDependents(s, d));
  return own ? `${own.targetId} changed since it was applied` : (blocked[0]?.reason ?? null);
}
