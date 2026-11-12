import {
  indexMatches, inHoldout, LESSON_CHECKS_VERSION, LOOP_ACTOR, lessonQuality, lessonSnapshot, pathIndex, type Candidate, type CandidateDetail, type Decision, type EvidenceRef, type Lesson,
  type LessonDetail, type LoopMiss, type PathIndex,
} from '@fb/core';
import { junkPathReason } from '../../postmortem/paths.ts';
import { callOf, holdsStill, primaryOf, RECHECK_MODEL_CALLS, SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { replayJudge, type ReplayVerdict } from '../replay.ts';
import { fromComment, lessonNeverTarget, missNeverTarget, ownerTouchedRecently } from './guards.ts';
import { LINK_NEIGHBOURS, linkCandidate } from './link_misses.ts';

/** The owner's as-written rate in the lesson's project must be at least this, over at least QUALITY_MIN_DECIDED decisions. */
export const QUALITY_MIN_RATE = 0.6;
export const QUALITY_MIN_DECIDED = 10;
/** The window lessonQuality counts the owner's decisions in (LESSON_QUALITY_DAYS' longest). */
export const QUALITY_DAYS = 90;
/** Decided lessons read per project for the rate (newest first). */
const QUALITY_LESSONS = 500;
/** Decisions of a type still standing on a target: one of these and the loop makes no second call on it. */
export const OPEN_STATUSES: readonly Decision['status'][] = ['observed', 'proposed', 'applying', 'applied'];
/** Skip reasons of this type. */
export const APPROVE_SKIP = { judgeFailed: 'judge_failed', noJudge: 'no_judge' } as const;

const NOTE = 'approved by the learning loop';

/** The lessons this round's entries name: directly, or by their miss (`miss:<feedback>` is `lesson:<feedback>`'s). */
export function namedLessons(ctx: LoopTypeContext): string[] {
  const ids = ctx.entries.flatMap((e) => e.targets.flatMap((t) => (t.startsWith('lesson:') ? [t] : t.startsWith('miss:') ? [`lesson:${t.slice(5)}`] : [])));
  return [...new Set(ids)].sort();
}

/** The loop already made a call of `type` on this target that still stands. */
export const decidedAlready = async (ctx: LoopTypeContext, type: Decision['type'], id: string) =>
  (await ctx.store.decisions.forTarget(id)).some((d) => d.type === type && OPEN_STATUSES.includes(d.status));

/** The owner's own decisions (operator ones left out) counted the way the Lessons page does. */
export async function ownerQuality(ctx: LoopTypeContext, projectKey: string) {
  const [approved, rejected] = await Promise.all((['approved', 'rejected'] as const).map((status) => ctx.store.knowledge.listLessons({ projectKeys: [projectKey], status, limit: QUALITY_LESSONS })));
  const own = [...approved, ...rejected].filter((l) => !l.decidedBy?.startsWith('operator'));
  const q = lessonQuality(own, QUALITY_DAYS, new Date(ctx.now));
  return { decided: q.decided, rate: q.decided ? q.asWritten / q.decided : 0 };
}

/** Each path is a repository path that matches a file in the project's code map (indexed); null map: cannot tell (false). */
export function pathsResolve(paths: string[], files: PathIndex | null): boolean {
  if (!paths.length || !files) return false;
  return paths.every((p) => !junkPathReason(p) && indexMatches(files, p));
}

/** The misses the lesson's miss repeats or is repeated by: the loop's links, and the link_misses floors over its neighbours. */
export async function repeatsOf(ctx: LoopTypeContext, missId: string): Promise<LoopMiss[]> {
  const [m] = await ctx.store.decisions.loopMisses([missId]);
  if (!m) return [];
  const linked = (await ctx.store.decisions.missLinks(missId)).map((l) => (l.from === missId ? l.to : l.from));
  const near = m.embedding ? await ctx.store.knowledge.relatedMisses({ embedding: m.embedding, projectKey: m.projectKey, k: LINK_NEIGHBOURS + 1, run: null }) : [];
  const others = await ctx.store.decisions.loopMisses([...new Set([...linked, ...near.map((n) => n.missId)])].filter((id) => id !== missId));
  return others.filter((e) => !missNeverTarget(e) && e.projectKey === m.projectKey && (linked.includes(e.id) || !!linkCandidate(m, e) || !!linkCandidate(e, m)));
}

/** The work the owner pushed back on, as the replay judge sees it: only a synced review comment carries its diff. */
export function replayWork(c: Pick<CandidateDetail, 'candidate' | 'turn' | 'before'>) {
  const ext = c.turn.external ?? c.candidate.external;
  if (!ext?.diffHunk) return null;
  return { task: [ext.title, ext.description ?? ''].filter(Boolean).join('\n\n') || (c.before.at(-1)?.text ?? ''), summary: c.turn.precedingAssistantText, diff: ext.diffHunk };
}

const confirmedByYou = (c: Candidate) => c.status === 'confirmed' && (c.decidedBy == null || c.decidedBy === 'you');

/**
 * approve_lesson (tier A, the highest bar): a proposed lesson becomes approved. Floors (never lowered): no lesson check
 * flag at all under the current checks version (so no blocking check, no may-hold-secret, no contradicts-evidence: the
 * cause is not contradicted); its miss comes from an Inbox item you confirmed (an operator's confirmation does not count);
 * your as-written rate in its project is ≥ 60% over ≥ 10 of your decisions (lessonQuality, 90 days, operator decisions
 * left out); every path resolves to a file of the code map; and either its miss repeats (a pattern group of ≥ 2: a
 * loop link, or the link_misses floors over its neighbours) or the replay judge flags the original diff. The judge is
 * asked last, only when no repeat stands, and only for a lesson the round's entries name and not held out, so a round
 * spends no model call on a lesson it cannot approve. A global lesson, one you touched in 14 days, or one learned from
 * a GitHub or Linear comment is proposed at most.
 */
export const approveLesson: LoopType = {
  type: 'approve_lesson',
  weights: { bias: -3, asWrittenAbove: 2, ownerDecisions: 1, repeats: 2, replayFlagged: 2 },
  groups: { evidence: ['repeats', 'replayFlagged'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const caches: Caches = { quality: new Map(), maps: new Map() };
    let scanned = 0;
    for (const id of namedLessons(ctx)) {
      const r = await approval(ctx, id, caches);
      if (r === null) continue;
      scanned++;
      if (typeof r === 'string') skip(skipped, r);
      else candidates.push(r);
    }
    return { candidates, scanned, skipped };
  },

  /**
   * Found only from the lessons a round's entries name: an observed approval is measured again by its floors, never
   * by the replay judge (one that rested on the judge's flag keeps it), at most RECHECK_MODEL_CALLS a round.
   */
  recheckLimit: RECHECK_MODEL_CALLS,
  async recheck(ctx: LoopTypeContext, observed: readonly Decision[]): Promise<(LoopCandidate | string)[]> {
    const caches: Caches = { quality: new Map(), maps: new Map() };
    const out: (LoopCandidate | string)[] = [];
    for (const d of observed) out.push(holdsStill(await approval(ctx, primaryOf(d), caches, d)));
    return out;
  },
};

type Caches = { quality: Map<string, Promise<{ decided: number; rate: number }>>; maps: Map<string, Promise<PathIndex | null>> };

/**
 * The approval of lesson `id`, why there is none, or null when it is not a proposed post-mortem lesson. again: the
 * observed decision a recheck measures again; its call is kept, and its replay flag stands in for asking the judge.
 */
async function approval(ctx: LoopTypeContext, id: string, caches: Caches, again?: Decision): Promise<LoopCandidate | string | null> {
  const d = await ctx.store.knowledge.lessonDetail(id);
  if (!d || d.lesson.status !== 'proposed' || d.lesson.source !== 'postmortem') return null;
  const l = d.lesson;
  const project = l.projectKey ?? l.origin ?? null;
  if (lessonNeverTarget(l)) return SKIP.neverTarget;
  const external = fromComment(l, d.feedback) ? 'its miss came from a GitHub or Linear comment' : undefined;
  if (!ctx.inScope(project)) return SKIP.outOfScope;
  if (inHoldout(id, ctx.holdout)) return SKIP.holdout;
  if (!again && await decidedAlready(ctx, 'approve_lesson', id)) return SKIP.alreadyDecided;
  if (!l.checks || (l.checksVersion ?? 0) < LESSON_CHECKS_VERSION || l.checks.length) return SKIP.belowFloor;
  if (!d.miss || !d.feedback || !project) return SKIP.belowFloor;
  const inbox = await ctx.store.graph.candidateDetail(d.feedback.id);
  if (inbox?.candidate.run || inbox?.candidate.sandbox) return SKIP.neverTarget;
  if (!inbox || !confirmedByYou(inbox.candidate)) return SKIP.belowFloor;
  if (!caches.quality.has(project)) caches.quality.set(project, ownerQuality(ctx, project));
  const q = await caches.quality.get(project)!;
  if (q.decided < QUALITY_MIN_DECIDED || q.rate < QUALITY_MIN_RATE) return SKIP.belowFloor;
  if (!caches.maps.has(project)) caches.maps.set(project, ctx.store.codegraph.codeMap(project).then((m) => (m ? pathIndex([...m.files, ...m.outside].map((f) => f.path)) : null)));
  if (!pathsResolve(l.paths, await caches.maps.get(project)!)) return SKIP.belowFloor;
  const repeats = await repeatsOf(ctx, d.miss.id);
  const touched = ownerTouchedRecently(await ctx.signals(id), ctx.now);
  const proposeOnly = touched ? SKIP.ownerTouched : l.projectKey === null ? 'a global lesson' : external;
  if (again) return repeats.length || again.features.replayFlagged ? callOf(again, `approve "${l.title.slice(0, 80)}"`, { proposeOnly }) : SKIP.belowFloor;
  let replay: ReplayVerdict | null = null;
  if (!repeats.length) {
    const work = replayWork(inbox);
    if (!work) return SKIP.belowFloor;
    if (!ctx.llm) return APPROVE_SKIP.noJudge;
    replay = await replayJudge(ctx.llm, l, work);
    if (replay.error) {
      ctx.log('approve_lesson: the replay judge gave no usable answer', { lessonId: id, error: replay.error });
      return APPROVE_SKIP.judgeFailed;
    }
    if (!replay.flagged) return SKIP.belowFloor;
  }
  return approveCandidate(d, { candidate: inbox.candidate, quality: q, repeats, replay, now: ctx.now, model: replay ? ctx.llm!.id : undefined, proposeOnly });
}

type ApproveInput = {
  candidate: Candidate; quality: { decided: number; rate: number }; repeats: LoopMiss[]; replay: ReplayVerdict | null; now: number;
  model?: string; proposeOnly?: string;
};

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The call for a lesson that passed every floor. */
export function approveCandidate(d: LessonDetail, o: ApproveInput): LoopCandidate {
  const l = d.lesson;
  const why = o.replay
    ? `the replay judge, given the work you pushed back on, flags it: ${o.replay.why}`
    : `its miss repeats ${o.repeats.length} other miss${o.repeats.length === 1 ? '' : 'es'}`;
  const note = `${NOTE}: ${o.replay ? 'the replay judge flags the original diff' : 'its miss repeats'}`;
  const after: Lesson = { ...l, status: 'approved', decidedAt: new Date(o.now).toISOString(), decidedBy: LOOP_ACTOR, decisionNote: note };
  const evidence: EvidenceRef[] = [
    { kind: 'candidate', id: o.candidate.id, role: 'confirmed by you', weight: 1, observedAt: o.candidate.decidedAt ?? o.candidate.createdAt },
    { kind: 'miss', id: d.miss!.id, role: 'lesson miss', weight: 1, observedAt: d.feedback!.ts },
    ...o.repeats.map((m) => ({ kind: 'miss' as const, id: m.id, role: 'repeated miss', weight: 1, observedAt: m.createdAt })),
    ...(o.replay ? [{ kind: 'lesson' as const, id: l.id, role: 'replay judge flags the original diff', weight: 1, observedAt: new Date(o.now).toISOString() }] : []),
  ];
  return {
    projectKey: l.projectKey,
    targets: [{ kind: 'lesson', id: l.id, role: 'primary' }],
    before: [lessonSnapshot(l)],
    after: [lessonSnapshot(after)],
    evidence,
    features: {
      asWrittenRate: round3(o.quality.rate),
      asWrittenAbove: round3(Math.max(0, (o.quality.rate - QUALITY_MIN_RATE) / (1 - QUALITY_MIN_RATE))),
      ownerDecisions: Math.min(o.quality.decided, 40) / 40,
      repeats: Math.min(o.repeats.length, 3) / 3,
      replayFlagged: o.replay?.flagged ? 1 : 0,
    },
    subject: `approve "${l.title.slice(0, 80)}"`,
    rationale: `Its miss came from an Inbox item you confirmed, the lesson checks found nothing, its paths resolve, and you approved ${Math.round(o.quality.rate * 100)}% of the last ${o.quality.decided} lessons in ${l.projectKey ?? l.origin} as written; ${why}. Approving it changes what agents are told when they edit ${l.paths.slice(0, 3).join(', ')}${l.paths.length > 3 ? ` and ${l.paths.length - 3} more` : ''}.`,
    ...(o.model && { model: o.model }),
    ...(o.proposeOnly && { proposeOnly: o.proposeOnly }),
  };
}
