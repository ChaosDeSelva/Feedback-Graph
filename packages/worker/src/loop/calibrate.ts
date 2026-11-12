import { bandOf, betaSummary, LOOP_ACTOR, LOOP_TYPE_INFO, type Activity, type ActivityStore, type CalibrationBucket, type Decision, type DecisionConfidence, type DecisionNoteReason, type DecisionsStore, type DecisionType, type DocsStore } from '@fb/core';
import { addPenalty } from './policy.ts';

/**
 * Calibration: per (type, band) a Beta posterior of "the owner kept it", starting from the type's prior. Labels come
 * from the owner's own actions on decisions, read from Activity: approve and keep are positive; reject, roll back
 * and an override are negative (restore anyway, which follows an override, is not counted again); and an auto-applied decision the owner left alone for
 * KEPT_AFTER_DAYS while its lesson was served is positive, one whose target the owner changed since negative
 * (labelUntouched). Only `you` counts: an operator's label carries no weight, so an agent holding the operator
 * token cannot vote the loop into autonomy.
 */

/** A decision's confidence for this score: its band's posterior (the prior when the band has none), and its owner labels. */
export function confidenceOf(type: DecisionType, score: number, buckets: CalibrationBucket[]): DecisionConfidence {
  const band = bandOf(score);
  const b = buckets.find((x) => x.band === band);
  const { alpha, beta } = b ?? LOOP_TYPE_INFO[type].prior;
  const { p, lower } = betaSummary(alpha, beta);
  return { p, lower, n: b?.n ?? 0, band };
}

export type OwnerLabel = { decisionId: string; kept: boolean; reason: DecisionNoteReason | null };

const REASONS = new Set<string>(['wrong_evidence', 'too_broad', 'wording', 'not_now', 'other']);

/** The owner's label in this entry, or null (not the owner's, or not a label). */
export function ownerLabel(e: Activity): OwnerLabel | null {
  if (e.actor !== 'you') return null;
  const id = e.details.decisionId;
  if (typeof id !== 'string') return null;
  const reason = typeof e.details.reason === 'string' && REASONS.has(e.details.reason) ? e.details.reason as DecisionNoteReason : null;
  if (e.kind === 'decision_applied') return { decisionId: id, kept: true, reason };
  // A cascade undid a dependent along with the decision the owner rolled back: the owner did not judge the dependent.
  // Restore anyway undoes a decision already overridden, and the override was its negative label.
  if (e.kind === 'decision_rolled_back') return e.details.action === 'cascade' || e.details.action === 'restore_anyway' ? null : { decisionId: id, kept: false, reason };
  if (e.kind !== 'decision_made') return null;
  if (e.details.status === 'rejected' || e.details.status === 'overridden') return { decisionId: id, kept: false, reason };
  if (e.details.status === 'applied' && e.details.action === 'keep') return { decisionId: id, kept: true, reason };
  return null;
}

/** Marks an Activity entry whose label is counted (loop-label:<entry id>): a round retried over it counts it once. */
const LABEL_PREFIX = 'loop-label:';

/**
 * Fold the owner's labels in these entries into the calibration buckets of each decision's type, band and policy
 * version; a rollback's reason also penalises the matching feature group. Each entry is counted once (a marker),
 * however often a retried round reads it. Returns how many labels were counted.
 */
export async function foldLabels(entries: readonly Activity[], d: { decisions: Pick<DecisionsStore, 'get' | 'bumpCalibration'>; cursors: Pick<DocsStore, 'getCursor' | 'setCursor'> }): Promise<number> {
  let n = 0;
  for (const e of entries) {
    const label = ownerLabel(e);
    if (!label || (await d.cursors.getCursor(LABEL_PREFIX + e.id))) continue;
    const dec = await d.decisions.get(label.decisionId);
    if (!dec) continue;
    // Marked first: a failure after it loses this one label rather than counting it again.
    await d.cursors.setCursor(LABEL_PREFIX + e.id, e.ts);
    await d.decisions.bumpCalibration({
      type: dec.type, band: dec.confidence.band, policyVersion: dec.policyVersion, prior: LOOP_TYPE_INFO[dec.type].prior,
      alpha: label.kept ? 1 : 0, beta: label.kept ? 0 : 1, n: 1,
    });
    if (!label.kept) await addPenalty(d.cursors, dec.type, label.reason);
    n++;
  }
  return n;
}

const KEPT_PAGE = 500;

/** An auto-applied decision left alone this long counts as kept. */
export const KEPT_AFTER_DAYS = 14;
/**
 * An auto-applied decision still unlabelled this long after it was applied (its lesson never served since), and past
 * its sync hold, is not checked again: it leaves the list with no label.
 */
export const LABEL_WINDOW_DAYS = 90;

/** A lesson as the decision left it can be served (approved, or proposed and approved later); one it rejected, revoked, superseded or removed cannot. */
const servable = (dec: Decision, id: string) => {
  const s = dec.after.find((a) => a.kind === 'lesson' && a.id === id);
  return s?.fields.status === 'approved' || s?.fields.status === 'proposed';
};

/**
 * The label for each decision the loop applied on its own that is KEPT_AFTER_DAYS old and not ratified. One whose
 * targets someone changed since (`changed`: the owner edited, revoked or rejected a loop-changed lesson) was overridden:
 * it is marked so, logged, and counted negative. One left alone (still as the loop left it) while its lesson targets
 * were served since is positive. Targets that are not lessons are not served, nor is a lesson the decision itself made
 * unservable (rejected, revoked, superseded: a reject_lesson, retire_lesson, record_fact or merge): being left alone is
 * enough. The list asks for mode auto: applied by the loop, not approved by the owner. Each decision is labelled once
 * (markLabelled, also set on one whose label is the owner's, and with no label on one still unserved after
 * LABEL_WINDOW_DAYS and its sync hold; an overridden one is no longer applied).
 */
export async function labelUntouched(d: {
  decisions: Pick<DecisionsStore, 'list' | 'bumpCalibration' | 'markStatus' | 'markLabelled'>;
  activity: Pick<ActivityStore, 'record'>;
  signals: (lessonId: string) => Promise<{ lastServed: string | null } | null>;
  changed: (dec: Decision) => Promise<string | null>;
  now: number;
}): Promise<{ kept: number; overridden: number }> {
  const out = { kept: 0, overridden: 0 };
  const before = new Date(d.now - KEPT_AFTER_DAYS * 86_400_000).toISOString();
  const windowStart = new Date(d.now - LABEL_WINDOW_DAYS * 86_400_000).toISOString();
  const nowIso = new Date(d.now).toISOString();
  // Only those applied before `before` and not yet labelled, newest applied first, page by page: an older one (not
  // labelled because its lesson was not served since) is reached however many came after it, and a labelled one is
  // never read again. One labelled or overridden here leaves the list, so the next page starts that many earlier.
  for (let offset = 0; ;) {
    const page = await d.decisions.list({ status: ['applied'], mode: 'auto', unlabelled: true, appliedBefore: before, order: 'applied', limit: KEPT_PAGE, offset });
    let left = 0;
    for (const dec of page) if (!(await stays(dec))) left++;
    if (page.length < KEPT_PAGE) return out;
    offset += KEPT_PAGE - left;
  }

  /** Label `dec` if it is due; whether it is still applied and unlabelled after. */
  async function stays(dec: Decision): Promise<boolean> {
    // Applied by the loop: mode auto alone also matches one the loop meant to apply, paused, and the owner approved.
    // That one, and one the owner kept, has its label from the owner (foldLabels): it waits for none.
    if (dec.ratifiedAt || !dec.decidedBy?.startsWith('loop:')) return !(await d.decisions.markLabelled(dec.id));
    const why = await d.changed(dec);
    if (why !== null) {
      if (!(await d.decisions.markStatus(dec.id, { status: 'overridden', from: ['applied'] }))) return true;
      await d.activity.record({
        kind: 'decision_made', actor: LOOP_ACTOR, projectKey: dec.projectKey, subject: `${dec.type.replace('_', ' ')} overridden: ${why}`.slice(0, 300),
        why: 'its target was changed since the loop applied it', details: { decisionId: dec.id, decisionType: dec.type, status: 'overridden', action: 'overridden', tier: dec.tier, confidence: dec.confidence },
        targets: [dec.id, ...dec.targets.map((t) => t.id)],
      });
      await d.decisions.bumpCalibration({ type: dec.type, band: dec.confidence.band, policyVersion: dec.policyVersion, prior: LOOP_TYPE_INFO[dec.type].prior, alpha: 0, beta: 1, n: 1 });
      out.overridden++;
      return false;
    }
    const lessons = dec.targets.filter((t) => t.kind === 'lesson' && servable(dec, t.id));
    const served = await Promise.all(lessons.map(async (t) => ((await d.signals(t.id))?.lastServed ?? '') > dec.appliedAt!));
    if (!served.every(Boolean)) {
      // Past its window and its hold: not read again, and counted neither way.
      if (dec.appliedAt! >= windowStart || (dec.syncHoldUntil ?? '') > nowIso) return true;
      return !(await d.decisions.markLabelled(dec.id));
    }
    // Marked first: a failure after it loses this one label rather than counting it again.
    if (!(await d.decisions.markLabelled(dec.id))) return true;
    await d.decisions.bumpCalibration({
      type: dec.type, band: dec.confidence.band, policyVersion: dec.policyVersion, prior: LOOP_TYPE_INFO[dec.type].prior, alpha: 1, beta: 0, n: 1,
    });
    out.kept++;
    return false;
  }
}
