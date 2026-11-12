import type { Decision, DecisionTarget, Supersession, TargetSnapshot } from '../../types.ts';
import type { IntakeSnapshotWrite } from '../../intake/records.ts';
import { snapshotKeys, snapshotOf } from '../snapshot.ts';
import { moveTargets } from './generic.ts';
import type { DecisionTypeHandler, HandlerContext } from './handler.ts';

const isIntake = (kind: DecisionTarget['kind']) => kind === 'claim' || kind === 'conflict';
const facts = (list: TargetSnapshot[]) => list.filter((x) => !isIntake(x.kind));

/**
 * The fact and lesson targets, as the generic write moves them: a loser lesson's status only, never a merge's SUPERSEDES
 * edge (the conflict's own SUPERSEDED_BY link is the record), and a created fact made under its planned id.
 */
const factTargets = (d: Decision): DecisionTarget[] =>
  d.targets.filter((t) => !isIntake(t.kind)).map((t) => ({ ...t, role: t.role === 'created' ? 'created' : 'primary' }));

/**
 * The SUPERSEDED_BY links a resolution makes: each loser (role merged: a losing side, and the fact a losing claim had
 * become) to what won (role keeper: the winning side; or created: the reconciled statement's fact). Read from the
 * targets, which never change, so a rollback removes exactly the links the apply made.
 */
export function supersessionsOf(d: Pick<Decision, 'targets'>): Supersession[] {
  const conflict = d.targets.find((t) => t.kind === 'conflict');
  const winner = d.targets.find((t) => t.role === 'keeper') ?? d.targets.find((t) => t.role === 'created');
  if (!conflict || !winner) return [];
  const ref = (t: DecisionTarget) => ({ kind: t.kind as Supersession['from']['kind'], id: t.id });
  return d.targets.filter((t) => t.role === 'merged').map((t) => ({ from: ref(t), to: ref(winner), conflictId: conflict.id }));
}

/** Claims and conflicts moved from `from` to `to` in one IntakeStore transaction, with the SUPERSEDED_BY links. */
async function moveIntake(c: HandlerContext, d: Decision, from: TargetSnapshot[], to: TargetSnapshot[], links: 'add' | 'remove'): Promise<void> {
  const keys = snapshotKeys([...from, ...to]).filter((k) => isIntake(k.kind));
  const writes = keys.flatMap((k): IntakeSnapshotWrite[] => {
    const was = snapshotOf(from, k);
    const is = snapshotOf(to, k);
    return was.fingerprint === is.fingerprint ? [] : [{ kind: k.kind, id: k.id, expect: was.fingerprint, fields: is.fields } as IntakeSnapshotWrite];
  });
  const supersede = supersessionsOf(d);
  await c.store.intake.writeSnapshots(writes, links === 'add' ? { supersede } : { unsupersede: supersede });
}

/**
 * resolve_conflict (0.9.0 §6): the owner's choice on a conflict. Facts and lessons first (the generic compare-and-set
 * write: a loser fact closed, a loser lesson superseded, a reconciled statement's owner fact made), then the claims and
 * the conflict with the SUPERSEDED_BY links in one intake transaction; when that fails the facts and lessons are moved
 * back. Rolling back is the reverse: the conflict reopened and the claims restored with the links removed, then the
 * facts and lessons (a created fact closed); when those fail the intake write is made again.
 */
export const resolveConflict: DecisionTypeHandler = {
  async apply(c, d) {
    const targets = factTargets(d);
    await moveTargets(c.store, targets, facts(d.before), facts(d.after), c, c.deps);
    try {
      await moveIntake(c, d, d.before, d.after, 'add');
    } catch (error) {
      await moveTargets(c.store, targets, facts(d.after), facts(d.before), c, c.deps);
      throw error;
    }
  },
  async rollback(c, d, from) {
    await moveIntake(c, d, from, d.before, 'remove');
    try {
      await moveTargets(c.store, factTargets(d), facts(from), facts(d.before), c, c.deps);
    } catch (error) {
      await moveIntake(c, d, d.before, from, 'add');
      throw error;
    }
  },
};
