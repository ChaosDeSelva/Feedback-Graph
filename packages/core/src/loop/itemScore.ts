// Browser-safe (the UI reads approveScore.ts, which uses this): type imports only, besides the thresholds.
import type { Candidate, Claim, Lesson, LessonCheckName } from '../types.ts';
import type { VerdictKind, VerdictNeighbour } from '../store.ts';
import { APPROVE_SCORE_MODEL, VERDICT_CROSS_PROJECT_WEIGHT, VERDICT_PRIOR_LABELS, type ScoreModel } from '../thresholds.ts';

/**
 * The per-item approve score (0.9.5): the chance you approve an item, read off your own past verdicts on the items most
 * like it (by their stored embeddings) and a few cheap features of the item, combined by a logistic model whose
 * coefficients were fitted offline on your verdicts (thresholds.ts APPROVE_SCORE_MODEL, scripts/score-eval.ts). No model
 * call: the same inputs always give the same score.
 */

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const logit = (p: number) => {
  const q = clamp(p, 0.02, 0.98);
  return Math.log(q / (1 - q));
};
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Your verdicts near the item, folded: p is a Beta-smoothed, similarity-weighted approve rate. */
export type VerdictEvidence = { p: number; weight: number; n: number; approved: number; projects: (string | null)[]; sameProject: boolean };

/**
 * Each verdict at cosine c >= floor (the kind's ScoreModel.floor) weighs (c - floor) / (1 - floor), times VERDICT_CROSS_PROJECT_WEIGHT
 * when learned in another project; the rate is shrunk toward `base` (your approve rate for the kind) by
 * VERDICT_PRIOR_LABELS labels, so one close verdict moves it, but not all the way.
 */
export function verdictEvidence(near: readonly VerdictNeighbour[] | undefined, base: number, floor: number): VerdictEvidence {
  const used = (near ?? []).filter((n) => n.cosine >= floor);
  let yes = 0;
  let weight = 0;
  for (const n of used) {
    const w = ((n.cosine - floor) / (1 - floor)) * (n.sameProject ? 1 : VERDICT_CROSS_PROJECT_WEIGHT);
    weight += w;
    if (n.approved) yes += w;
  }
  return {
    p: (yes + VERDICT_PRIOR_LABELS * base) / (weight + VERDICT_PRIOR_LABELS),
    weight,
    n: used.length,
    approved: used.filter((n) => n.approved).length,
    projects: [...new Set(used.map((n) => n.projectKey))],
    sameProject: used.length > 0 && used.every((n) => n.sameProject),
  };
}

/** One input of the model: its value, and the words that say it (for the why line). */
export type Feature = { name: string; x: number; why: string };

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** An Inbox item's features. */
export function candidateFeatures(c: Pick<Candidate, 'classification' | 'source' | 'external'>): Feature[] {
  const { label, confidence, signals } = c.classification;
  const pushback = label === 'pushback' || label === 'correction';
  const p = pushback ? confidence : 1 - confidence;
  const e = c.external ?? null;
  const byAuthor = !!e && !!e.threadAuthor && lower(e.threadAuthor) === lower(e.author);
  const bot = (!!e?.authorKind && e.authorKind !== 'human') || signals.includes('self-review');
  return [
    { name: 'classifier', x: logit(p), why: `classifier ${Math.round(confidence * 100)}% sure it is ${label}` },
    { name: 'synced', x: e ? 1 : 0, why: 'a synced review comment' },
    { name: 'prAuthor', x: byAuthor ? 1 : 0, why: "the PR author's own comment" },
    { name: 'reply', x: e?.isReply ? 1 : 0, why: 'a reply in a thread' },
    { name: 'merged', x: e?.threadState === 'merged' ? 1 : 0, why: 'its PR merged' },
    { name: 'closedUnmerged', x: e?.threadState === 'closed' ? 1 : 0, why: 'its PR closed unmerged' },
    { name: 'bot', x: bot ? 1 : 0, why: 'written by a bot or an agent' },
  ];
}

/** The lesson checks that block a lesson: reject_lesson proposes rejecting one carrying any (its floor). */
export const LESSON_BLOCKING_CHECKS: readonly LessonCheckName[] = ['platitude', 'generic', 'meta-lesson', 'not-pushback', 'no-miss', 'self-review', 'wrong-session'];
const PATH_CHECKS: readonly LessonCheckName[] = ['bad-path', 'path-missing', 'non-repo-path'];

/** A proposed lesson's features: its lesson check flags, and whether the paths it names exist. */
export function lessonFeatures(l: Pick<Lesson, 'checks'>): Feature[] {
  const names = [...new Set((l.checks ?? []).map((c) => c.name))];
  const blocking = names.filter((n) => LESSON_BLOCKING_CHECKS.includes(n));
  const paths = names.filter((n) => PATH_CHECKS.includes(n));
  const other = names.filter((n) => !blocking.includes(n) && !paths.includes(n));
  return [
    { name: 'failsCheck', x: blocking.length ? 1 : 0, why: `fails check ${blocking.slice(0, 2).join(', ')}` },
    { name: 'badPath', x: paths.length ? 1 : 0, why: 'a path it names does not exist' },
    { name: 'flagged', x: other.length ? 1 : 0, why: `flagged ${other.slice(0, 2).join(', ')}` },
    { name: 'unchecked', x: l.checks == null ? 1 : 0, why: 'not checked yet' },
  ];
}

/** A proposed claim's features: the extraction's confidence, its flags and its type. */
export function claimFeatures(c: Pick<Claim, 'confidence' | 'flags' | 'type'>): Feature[] {
  return [
    { name: 'confidence', x: logit(c.confidence), why: `extraction ${Math.round(c.confidence * 100)}% sure` },
    { name: 'flagged', x: c.flags.length ? 1 : 0, why: `flagged ${c.flags.join(', ')}` },
    { name: 'opinion', x: c.type === 'opinion' ? 1 : 0, why: 'an opinion, not a fact or decision' },
  ];
}

const NOUN: Record<VerdictKind, string> = { candidate: 'Inbox items', lesson: 'lessons', claim: 'claims' };
const VERB: Record<VerdictKind, string> = { candidate: 'confirmed', lesson: 'approved', claim: 'accepted' };

/** What the item's neighbours are called in the why line: for a synced comment, the kind of comment it is. */
export function neighbourNoun(kind: VerdictKind, features: readonly Feature[]): string {
  const on = (n: string) => features.some((f) => f.name === n && f.x > 0);
  if (kind === 'candidate' && on('synced')) return on('prAuthor') ? 'PR-author comments' : 'reviewer comments';
  return NOUN[kind];
}

/** The model's chance of approve, how many labels it rests on, and the reasons, the one that moved it most first. */
export type ItemChance = { p: number; labels: number; reasons: string[] };

/** model: the fitted one (thresholds.ts) unless given (scripts/score-eval.ts fits others). */
export function itemChance(kind: VerdictKind, features: Feature[], near: readonly VerdictNeighbour[] | undefined, model: ScoreModel = APPROVE_SCORE_MODEL[kind]): ItemChance {
  const ev = verdictEvidence(near, model.base, model.floor);
  const where = ev.sameProject && ev.projects.length === 1 && ev.projects[0] ? `in ${ev.projects[0]}` : 'across projects';
  const terms = [
    { c: model.verdicts * (logit(ev.p) - logit(model.base)), why: `you ${VERB[kind]} ${ev.approved} of ${ev.n} similar ${neighbourNoun(kind, features)} ${where}` },
    ...features.map((f) => ({ c: (model.features[f.name] ?? 0) * f.x, why: f.why })),
  ];
  const z = model.intercept + terms.reduce((s, t) => s + t.c, 0);
  const p = sigmoid(z);
  // The reasons that push the way the score leans, strongest first; with none, the base rate is the reason.
  const lean = p >= 0.5 ? 1 : -1;
  const reasons = terms.filter((t) => Math.abs(t.c) >= 0.05 && Math.sign(t.c) === lean).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).map((t) => t.why);
  if (!ev.n) reasons.push(`none of your verdicts on similar ${NOUN[kind]} yet`);
  return { p, labels: ev.weight + model.featureLabels, reasons: reasons.length ? reasons : [`you ${VERB[kind]} ${Math.round(model.base * 100)}% of ${NOUN[kind]}`] };
}
