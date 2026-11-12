import type { Decision, Question, TargetSnapshot } from '../../types.ts';
import { changedError } from '../record.ts';
import { snapshotOf, snapshotTarget } from '../snapshot.ts';
import type { DecisionTypeHandler, HandlerContext } from './handler.ts';

/**
 * Move each question target from `from` to `to` (status, assignee, the claim answering it). Questions have no
 * compare-and-set write: each is compared just before it is written. Both types that use this (assign_question,
 * close_question) are tier P, so the window is the owner's own click.
 */
async function move(c: HandlerContext, d: Decision, from: TargetSnapshot[], to: TargetSnapshot[]): Promise<void> {
  for (const t of d.targets.filter((x) => x.kind === 'question')) {
    const was = snapshotOf(from, t);
    const is = snapshotOf(to, t);
    if (was.fingerprint === is.fingerprint) continue;
    const cur = await snapshotTarget(c.store, t);
    if (cur.fingerprint !== was.fingerprint) throw changedError(t.id, was.fingerprint, cur);
    const f = is.fields as Pick<Question, 'status' | 'assignee' | 'answerClaimId'>;
    await c.store.intake.updateQuestion(t.id, { status: f.status, assignee: f.assignee, answerClaimId: f.answerClaimId }, c.by);
  }
}

/** assign_question and close_question: a question's status, assignee and answering claim, as the decision's snapshots say. */
export const questionHandler: DecisionTypeHandler = {
  apply: (c, d) => move(c, d, d.before, d.after),
  rollback: (c, d, from) => move(c, d, from, d.before),
};
