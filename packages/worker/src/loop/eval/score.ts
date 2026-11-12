import { createHash } from 'node:crypto';
import { proportion, type Activity, type Decision, type DecisionType, type Proportion } from '@fb/core';
import { statusSet } from './timeTravel.ts';

/**
 * Scoring a replay: the loop's would-be decisions at T0 against what the owner actually did after it, per type.
 * Only the owner's own actions (actor `you`) count; an operator's, the worker's and the loop's never do.
 */

/** One thing the owner did after T0, on records that existed at T0. */
export type OwnerAction = {
  kind: 'approved' | 'rejected' | 'revoked' | 'edited_text' | 'edited_scope' | 'merged' | 'to_fact' | 'inbox_confirmed' | 'inbox_rejected' | 'kept_decision' | 'undid_decision';
  /** The record acted on: a lesson, an Inbox item; for `merged`, the lesson kept. */
  target: string;
  /** merged: the lesson merged into `target`. kept_decision, undid_decision: the decision's type and other targets. */
  other?: string;
  decisionType?: DecisionType;
  targets?: string[];
  ts: string;
  projectKey: string | null;
};

const TEXT = ['title', 'rule', 'appliesWhen'];
const SCOPE = ['scope', 'paths', 'projectKey'];

/** The owner's actions in these entries (any order), oldest first. */
export function ownerActions(entries: readonly Activity[]): OwnerAction[] {
  const out: OwnerAction[] = [];
  for (const e of [...entries].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (e.actor !== 'you') continue;
    const base = { ts: e.ts, projectKey: e.projectKey };
    const target = e.targets[0];
    if (e.kind === 'lesson_decided' && target) {
      const set = statusSet(e);
      if (set === 'approved' || set === 'rejected' || set === 'revoked') out.push({ ...base, kind: set, target });
      const changed = Object.keys((e.details.changed as object | undefined) ?? {});
      if (changed.some((k) => TEXT.includes(k))) out.push({ ...base, kind: 'edited_text', target });
      if (changed.some((k) => SCOPE.includes(k))) out.push({ ...base, kind: 'edited_scope', target });
      if (typeof e.details.supersedes === 'string') out.push({ ...base, kind: 'merged', target, other: e.details.supersedes });
    } else if (e.kind === 'lesson_to_fact' && target) {
      out.push({ ...base, kind: 'to_fact', target });
    } else if (e.kind === 'feedback_decided' && target && (e.details.status === 'confirmed' || e.details.status === 'rejected')) {
      out.push({ ...base, kind: e.details.status === 'confirmed' ? 'inbox_confirmed' : 'inbox_rejected', target });
    } else if ((e.kind === 'decision_applied' || e.kind === 'decision_made' || e.kind === 'decision_rolled_back') && typeof e.details.decisionType === 'string') {
      const action = e.details.action;
      // As the API logs them (docs/learning-loop-api.md): approve is decision_applied, keep and reject decision_made.
      const kept = e.kind === 'decision_applied' || action === 'keep';
      const undone = e.kind === 'decision_rolled_back' || action === 'reject';
      if (kept || undone) {
        out.push({ ...base, kind: kept ? 'kept_decision' : 'undid_decision', target: target ?? '', decisionType: e.details.decisionType as DecisionType, targets: e.targets.slice(1).sort() });
      }
    }
  }
  return out;
}

/** What each owner action is evidence for: the decision type that would have made the same call. */
export const ACTION_TYPE: Partial<Record<OwnerAction['kind'], DecisionType>> = {
  approved: 'approve_lesson', rejected: 'reject_lesson', revoked: 'retire_lesson', edited_text: 'reword_lesson', edited_scope: 'narrow_scope',
  merged: 'merge_duplicates', to_fact: 'record_fact', inbox_confirmed: 'triage_inbox', inbox_rejected: 'triage_inbox',
};

export type Verdict = 'agree' | 'contradict' | 'unlabelled';

const primary = (d: Decision) => (d.targets.find((t) => t.role === 'primary') ?? d.targets[0])?.id;
const role = (d: Decision, r: string) => d.targets.find((t) => t.role === r)?.id;
const on = (as: OwnerAction[], id: string | undefined, ...kinds: OwnerAction['kind'][]) => as.filter((a) => a.target === id && kinds.includes(a.kind));
/** The first of these actions decides: agree when it is one of `yes`, contradict when one of `no`. */
const first = (as: OwnerAction[], id: string | undefined, yes: OwnerAction['kind'][], no: OwnerAction['kind'][] = []): Verdict => {
  const a = on(as, id, ...yes, ...no)[0];
  return !a ? 'unlabelled' : yes.includes(a.kind) ? 'agree' : 'contradict';
};

/**
 * Per type, whether the owner's later actions agree with a would-be decision. Housekeeping the owner never does by hand
 * (linking misses, ranking, thresholds) is unlabelled unless he judged the loop's own decision on the same call.
 */
const AGREES: Record<DecisionType, (d: Decision, as: OwnerAction[]) => Verdict> = {
  approve_lesson: (d, as) => first(as, primary(d), ['approved'], ['rejected', 'revoked']),
  reject_lesson: (d, as) => first(as, primary(d), ['rejected'], ['approved']),
  retire_lesson: (d, as) => first(as, primary(d), ['revoked', 'rejected']),
  reword_lesson: (d, as) => first(as, primary(d), ['edited_text']),
  narrow_scope: (d, as) => first(as, primary(d), ['edited_scope']),
  record_fact: (d, as) => first(as, primary(d), ['to_fact']),
  merge_duplicates: (d, as) => {
    const keeper = role(d, 'keeper');
    const merged = role(d, 'merged');
    const pair = as.some((a) => a.kind === 'merged' && ((a.target === keeper && a.other === merged) || (a.target === merged && a.other === keeper)));
    return pair ? 'agree' : first(as, merged, ['rejected', 'revoked']);
  },
  triage_inbox: (d, as) => {
    const to = d.after.find((s) => s.kind === 'candidate')?.fields.status;
    return to === 'confirmed' ? first(as, primary(d), ['inbox_confirmed'], ['inbox_rejected']) : first(as, primary(d), ['inbox_rejected'], ['inbox_confirmed']);
  },
  link_misses: () => 'unlabelled',
  rank_weight: () => 'unlabelled',
  tune_threshold: () => 'unlabelled',
  // The owner's own decision: nothing of the loop's to score.
  resolve_conflict: () => 'unlabelled',
  remove_source: () => 'unlabelled',
};

/** The owner's verdict on a would-be decision: his verdict on the loop's real decision for the same call, else the type's rule. */
export function verdictOf(d: Decision, as: OwnerAction[]): Verdict {
  const ids = d.targets.map((t) => t.id).sort().join('|');
  const judged = as.find((a) => (a.kind === 'kept_decision' || a.kind === 'undid_decision') && a.decisionType === d.type && a.targets!.join('|') === ids);
  if (judged) return judged.kind === 'kept_decision' ? 'agree' : 'contradict';
  return AGREES[d.type](d, as);
}

/**
 * A frozen held-out set, never used for tuning (the discipline of the redaction held-out corpora): what falls in one of
 * its projects, or a cut in one of its months (YYYY-MM), is reported apart.
 */
export type ReplaySplit = { projects: string[]; months: string[] };
export const NO_SPLIT: ReplaySplit = { projects: [], months: [] };

export const isHeldOut = (split: ReplaySplit, projectKey: string | null, t0: string) =>
  (projectKey !== null && split.projects.includes(projectKey)) || split.months.includes(t0.slice(0, 7));

/** Freeze `share` of these projects as held out, chosen by a fixed hash (so the same projects every time). */
export function freezeSplit(projectKeys: string[], share: number): ReplaySplit {
  const rank = (k: string) => createHash('sha256').update(`fg-replay-split|${k}`).digest().readUInt32BE(0);
  const keys = [...new Set(projectKeys)].sort((a, b) => rank(a) - rank(b));
  return { projects: keys.slice(0, Math.round(keys.length * share)).sort(), months: [] };
}

/** One cut: each would-be decision with the owner's verdict, and each owner action with whether the loop made that call. */
export type CutResult = {
  t0: string;
  decisions: { decision: Decision; verdict: Verdict; heldOut: boolean }[];
  actions: { action: OwnerAction; type: DecisionType; caught: boolean; heldOut: boolean }[];
};

/** Score the would-be decisions of one cut against the owner's actions after it. */
export function scoreCut(t0: string, decisions: Decision[], actions: OwnerAction[], split: ReplaySplit): CutResult {
  const scored = decisions.map((decision) => ({ decision, verdict: verdictOf(decision, actions), heldOut: isHeldOut(split, decision.projectKey, t0) }));
  const agreed = scored.filter((s) => s.verdict === 'agree').map((s) => s.decision);
  const out: CutResult['actions'] = [];
  for (const action of actions) {
    const type = ACTION_TYPE[action.kind];
    if (!type) continue;
    const caught = agreed.some((d) => d.type === type && verdictOf(d, [action]) === 'agree');
    out.push({ action, type, caught, heldOut: isHeldOut(split, action.projectKey, t0) });
  }
  return { t0, decisions: scored, actions: out };
}

/**
 * Per type: the would-be decisions, how many the owner's later actions agree with or contradict, precision over the
 * labelled ones (agree / (agree + contradict)), strict precision over all (an unlabelled call counts against it), and
 * recall: the owner's actions of that kind the loop also made.
 */
export type TypeScore = {
  type: DecisionType; decisions: number; agree: number; contradict: number; unlabelled: number;
  precision: Proportion; strictPrecision: Proportion; recall: Proportion;
};
export type ReplayReport = { cuts: string[]; tuning: TypeScore[]; heldOut: TypeScore[] };

function scores(cuts: CutResult[], heldOut: boolean): TypeScore[] {
  const ds = cuts.flatMap((c) => c.decisions.filter((d) => d.heldOut === heldOut));
  const as = cuts.flatMap((c) => c.actions.filter((a) => a.heldOut === heldOut));
  const types = [...new Set([...ds.map((d) => d.decision.type), ...as.map((a) => a.type)])].sort();
  return types.map((type) => {
    const mine = ds.filter((d) => d.decision.type === type);
    const agree = mine.filter((d) => d.verdict === 'agree').length;
    const contradict = mine.filter((d) => d.verdict === 'contradict').length;
    const acts = as.filter((a) => a.type === type);
    return {
      type, decisions: mine.length, agree, contradict, unlabelled: mine.length - agree - contradict,
      precision: proportion(agree, agree + contradict), strictPrecision: proportion(agree, mine.length),
      recall: proportion(acts.filter((a) => a.caught).length, acts.length),
    };
  });
}

export const replayReport = (cuts: CutResult[]): ReplayReport => ({ cuts: cuts.map((c) => c.t0), tuning: scores(cuts, false), heldOut: scores(cuts, true) });

const pct = (p: Proportion) => (p.n ? `${Math.round(p.rate * 100)}% [${Math.round(p.ciLow * 100)}–${Math.round(p.ciHigh * 100)}] n=${p.n}` : '–');

/** The report as Markdown tables: the tuning set, then the held-out set. */
export function formatReplayReport(r: ReplayReport): string {
  const table = (rows: TypeScore[]) => [
    '| type | decisions | agree | contradict | unlabelled | precision | strict precision | recall |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((s) => `| ${s.type} | ${s.decisions} | ${s.agree} | ${s.contradict} | ${s.unlabelled} | ${pct(s.precision)} | ${pct(s.strictPrecision)} | ${pct(s.recall)} |`),
  ].join('\n');
  return [
    `Cuts: ${r.cuts.join(', ')}`, '',
    '## Tuning set', '', r.tuning.length ? table(r.tuning) : 'Nothing to score.', '',
    '## Held-out set (frozen; never tune against it)', '', r.heldOut.length ? table(r.heldOut) : 'Nothing to score.', '',
  ].join('\n');
}
