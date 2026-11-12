import {
  LOOP_ACTOR, resolutionDecision, scopesOverlap, type Conflict, type ConflictSide, type ConflictSideInfo, type DecisionExecStore, type EvidenceRef,
} from '@fb/core';
import { claimSide, factSide, lessonSide } from '../../conflicts/stage.ts';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { decidedAlready } from './approve_lesson.ts';

/** Open conflicts looked at per round, newest first. */
const CONFLICT_PAGE = 200;

/** A side as detection reads it (its project, files, area, subject), or null when it is gone, closed or superseded. */
async function sideInfo(ctx: LoopTypeContext, s: ConflictSide): Promise<ConflictSideInfo | null> {
  if (s.kind === 'claim') {
    const c = await ctx.store.intake.claim(s.id);
    return c && (c.status === 'accepted' || c.status === 'proposed') ? claimSide(c, false) : null;
  }
  if (s.kind === 'fact') {
    const f = await ctx.store.facts.fact(s.id);
    return f?.current ? factSide(f, f.projectKey) : null;
  }
  const l = (await ctx.store.knowledge.lessonDetail(s.id))?.lesson;
  return l && (l.status === 'approved' || l.status === 'proposed') ? lessonSide(l) : null;
}

type Suggestion = { choice: 'b' | 'none'; why: string; role: string };

/**
 * propose_resolution (tier P: always a proposal, never applied on its own): a suggested settlement of an open conflict,
 * which you approve or reject on the Decisions page. A probable supersession (the newer side, a decision or plan said
 * later by the same person or by you) is proposed as "B is true"; a conflict whose sides no longer share a scope (a
 * claim re-scoped, a lesson narrowed, a project link removed) as "not a conflict: different scope". Approving it is
 * exactly your resolve_conflict: the loser superseded, never deleted, and a rollback restores it. Choosing which side
 * is true is never automatic: the engine never applies a tier P call.
 */
export const proposeResolution: LoopType = {
  type: 'propose_resolution',
  weights: { bias: 0, supersession: 1.5, scopesApart: 1.5 },
  groups: { evidence: ['supersession'], scope: ['scopesApart'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const open = (await ctx.store.intake.listConflicts({ status: ['open'], limit: CONFLICT_PAGE })).filter((k) => !k.run && !k.sandbox);
    const confirmed = open.length ? new Set((await ctx.store.links.listLinks({})).filter((l) => l.status === 'confirmed').flatMap((l) => [`${l.a}|${l.b}`, `${l.b}|${l.a}`])) : new Set<string>();
    for (const k of open) {
      if (!ctx.inScope(k.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      const [a, b] = await Promise.all([sideInfo(ctx, k.a), sideInfo(ctx, k.b)]);
      if (!a || !b) { skip(skipped, SKIP.belowFloor); continue; }
      const s: Suggestion | null = k.kind === 'supersession'
        ? { choice: 'b', role: 'probable supersession', why: `B (${k.b.kind} ${k.b.id}) was said ${gap(k)} after A by the same person or by you, and is a decision or plan: it probably replaces A` }
        : !scopesOverlap(a, b, (x, y) => confirmed.has(`${x}|${y}`))
          ? { choice: 'none', role: 'scopes apart', why: 'the two sides no longer share a scope (project, files, area or subject), so they cannot contradict each other' }
          : null;
      if (!s) { skip(skipped, SKIP.belowFloor); continue; }
      if (await decidedAlready(ctx, 'propose_resolution', k.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
      candidates.push(await resolutionCandidate(ctx, k, s));
    }
    return { candidates, scanned: open.length, skipped };
  },
};

function gap(k: Conflict): string {
  const ms = Date.parse(k.b.assertedAt ?? '') - Date.parse(k.a.assertedAt ?? '');
  if (!Number.isFinite(ms) || ms <= 0) return 'later';
  const days = Math.round(ms / 86_400_000);
  return days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : 'the same day';
}

/** The suggestion as the decision your own resolution would be (resolutionDecision), on stable evidence. */
async function resolutionCandidate(ctx: LoopTypeContext, k: Conflict, s: Suggestion): Promise<LoopCandidate> {
  const now = new Date(ctx.now).toISOString();
  const r = await resolutionDecision(ctx.store as unknown as DecisionExecStore, k, s.choice === 'b' ? { choice: 'b' } : { choice: 'none', reason: 'scope' }, { by: LOOP_ACTOR, now });
  const evidence: EvidenceRef[] = [
    { kind: 'conflict', id: k.id, role: s.role, weight: 1, observedAt: k.createdAt },
    { kind: k.a.kind, id: k.a.id, role: 'side a', weight: 1, observedAt: k.a.assertedAt ?? k.createdAt },
    { kind: k.b.kind, id: k.b.id, role: 'side b', weight: 1, observedAt: k.b.assertedAt ?? k.createdAt },
  ];
  return {
    projectKey: k.projectKey, targets: r.targets, before: r.before, after: r.after, evidence, dependsOn: r.dependsOn,
    features: { supersession: s.choice === 'b' ? 1 : 0, scopesApart: s.choice === 'none' ? 1 : 0 },
    subject: s.choice === 'b' ? `suggest B is true in ${k.id}` : `suggest ${k.id} is not a conflict (different scope)`,
    rationale: `${s.choice === 'b' ? 'Suggested: B is true, A superseded' : 'Suggested: not a conflict (different scope)'}, because ${s.why}. Only you settle a conflict: approving this applies it as your resolution would, and rolling it back reopens the conflict.`,
  };
}
