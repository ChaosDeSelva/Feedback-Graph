import type { DecisionNoteReason, DecisionType, DocsStore } from '@fb/core';
import type { LoopType } from './plugin.ts';

/**
 * Scoring: s = σ(bias + Σ weight·feature) over a type's hand weights (its LoopType.weights, stamped LOOP_POLICY_VERSION),
 * with each rollback reason the owner gave scaling down the matching feature group (§6.7 of the design): wrong_evidence
 * the type's evidence features, too_broad its scope features. The penalties are kept per type in a cursor.
 */

export const LOOP_PENALTY_PREFIX = 'loop-penalty:';
/** Each penalty scales the group's weights by this much. */
export const PENALTY_FACTOR = 0.9;
export type LoopPenalties = { evidence: number; scope: number };
const NONE: LoopPenalties = { evidence: 0, scope: 0 };

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** The type's raw score for these features under these penalties. */
export function score(t: Pick<LoopType, 'weights' | 'groups'>, features: Record<string, number>, p: LoopPenalties = NONE): number {
  const scale = (f: string) =>
    (t.groups?.evidence?.includes(f) ? PENALTY_FACTOR ** p.evidence : 1) * (t.groups?.scope?.includes(f) ? PENALTY_FACTOR ** p.scope : 1);
  let x = t.weights.bias;
  for (const [f, v] of Object.entries(features)) x += (t.weights[f] ?? 0) * scale(f) * v;
  return sigmoid(x);
}

type Cursors = Pick<DocsStore, 'getCursor' | 'setCursor'>;

export async function readPenalties(cursors: Cursors, type: DecisionType): Promise<LoopPenalties> {
  try {
    const o = JSON.parse((await cursors.getCursor(LOOP_PENALTY_PREFIX + type)) ?? 'null') as Partial<LoopPenalties> | null;
    return { evidence: Number(o?.evidence) || 0, scope: Number(o?.scope) || 0 };
  } catch {
    return NONE;
  }
}

/** The group a rollback reason penalises; null for reasons that say nothing about the features (wording, not_now, other). */
export const penaltyGroup = (reason: DecisionNoteReason | null): keyof LoopPenalties | null =>
  reason === 'wrong_evidence' ? 'evidence' : reason === 'too_broad' ? 'scope' : null;

/** Count one rollback reason against the type's features. */
export async function addPenalty(cursors: Cursors, type: DecisionType, reason: DecisionNoteReason | null): Promise<void> {
  const group = penaltyGroup(reason);
  if (!group) return;
  const p = await readPenalties(cursors, type);
  await cursors.setCursor(LOOP_PENALTY_PREFIX + type, JSON.stringify({ ...p, [group]: p[group] + 1 }));
}
