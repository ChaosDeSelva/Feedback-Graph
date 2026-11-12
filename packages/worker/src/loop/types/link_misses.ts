import { missLinkSnapshot, REPEAT_SIMILARITY, type Decision, type LoopMiss } from '@fb/core';
import { primaryOf, SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { missNeverTarget } from './guards.ts';

/** Nearest earlier misses compared with each new one. */
export const LINK_NEIGHBOURS = 10;
/** Shared edited files counted in the feature (more says no more). */
const FILES_CAP = 3;

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The misses new this round: those a post-mortem saved (postmortem_done names `miss:<feedback id>`). */
const freshMisses = (ctx: LoopTypeContext) =>
  [...new Set(ctx.entries.filter((e) => e.kind === 'postmortem_done').flatMap((e) => e.targets.filter((t) => t.startsWith('miss:'))))];

/** Skip reasons of this type: a pair of misses compared and not a repeat; an observed call whose pair no longer is one. */
export const NOT_A_REPEAT = 'not_a_repeat';
export const NO_LONGER_A_REPEAT = 'no_longer_a_repeat';

/**
 * link_misses (tier H): a new miss repeats an earlier one of the same project, recorded as (:Miss)-[:REPEATS]->(:Miss).
 * Floors: cosine ≥ REPEAT_SIMILARITY (the Patterns page's repeat threshold) AND a file both sessions edited or the same
 * cause. It changes only the Patterns view and hotspots; agents are not told anything new.
 *
 * It compares only the misses new this round, so a call it only observed would never be found again: its recheck
 * measures each observed pair again, as the misses are now.
 */
export const linkMisses: LoopType = {
  type: 'link_misses',
  weights: { bias: -1, cosineAbove: 2, sharedFiles: 1.5, sameCause: 1 },
  groups: { evidence: ['cosineAbove', 'sharedFiles', 'sameCause'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const fresh = await ctx.store.decisions.loopMisses(freshMisses(ctx));
    let scanned = 0;
    for (const m of fresh) {
      if (missNeverTarget(m)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(m.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      if (!m.embedding) { skip(skipped, SKIP.belowFloor); continue; }
      const near = await ctx.store.knowledge.relatedMisses({ embedding: m.embedding, projectKey: m.projectKey, k: LINK_NEIGHBOURS + 1, run: null });
      const earlier = (await ctx.store.decisions.loopMisses(near.map((n) => n.missId).filter((id) => id !== m.id)))
        .filter((e) => e.createdAt < m.createdAt || (e.createdAt === m.createdAt && e.id < m.id));
      const linked = new Set((await ctx.store.decisions.missLinks(m.id)).filter((l) => l.from === m.id).map((l) => l.to));
      for (const e of earlier) {
        scanned++;
        if (missNeverTarget(e)) { skip(skipped, SKIP.neverTarget); continue; }
        if (linked.has(e.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
        const c = linkCandidate(m, e);
        if (c) candidates.push(c);
        else skip(skipped, e.embedding ? NOT_A_REPEAT : SKIP.belowFloor);
      }
    }
    return { candidates, scanned, skipped };
  },

  async recheck(ctx: LoopTypeContext, observed: readonly Decision[]): Promise<(LoopCandidate | string)[]> {
    const out: (LoopCandidate | string)[] = [];
    for (const d of observed) {
      const from = primaryOf(d), to = d.targets.find((t) => t.role === 'keeper')!.id;
      const byId = new Map((await ctx.store.decisions.loopMisses([from, to])).map((m) => [m.id, m]));
      const m = byId.get(from), e = byId.get(to);
      if (!m || !e) out.push(NO_LONGER_A_REPEAT);
      else if (missNeverTarget(m) || missNeverTarget(e)) out.push(SKIP.neverTarget);
      else if (!ctx.inScope(m.projectKey)) out.push(SKIP.outOfScope);
      else if ((await ctx.store.decisions.missLinks(m.id)).some((l) => l.from === m.id && l.to === e.id)) out.push(SKIP.alreadyDecided);
      else out.push(linkCandidate(m, e) ?? NO_LONGER_A_REPEAT);
    }
    return out;
  },
};

/** The call for `m` repeating the earlier `e`, or null below the floors. */
export function linkCandidate(m: LoopMiss, e: LoopMiss): LoopCandidate | null {
  if (!m.embedding || !e.embedding) return null;
  const cos = cosine(m.embedding, e.embedding);
  const shared = m.editedFiles.filter((f) => e.editedFiles.includes(f));
  const sameCause = m.cause === e.cause;
  if (cos < REPEAT_SIMILARITY || (!shared.length && !sameCause)) return null;
  const why = [
    `cosine ${round3(cos)}`,
    ...(shared.length ? [`both sessions edited ${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ` and ${shared.length - 3} more` : ''}`] : []),
    ...(sameCause ? [`same cause (${m.cause})`] : []),
  ];
  return {
    projectKey: m.projectKey,
    targets: [{ kind: 'miss', id: m.id, role: 'primary' }, { kind: 'miss', id: e.id, role: 'keeper' }],
    before: [missLinkSnapshot(m.id, e.id, false)],
    after: [missLinkSnapshot(m.id, e.id, true)],
    evidence: [
      { kind: 'miss', id: e.id, role: 'repeated miss', weight: round3(cos), observedAt: e.createdAt },
      { kind: 'miss', id: m.id, role: 'repeat', weight: 1, observedAt: m.createdAt },
      ...shared.map((f) => ({ kind: 'miss' as const, id: m.id, role: `edited ${f}`, weight: 1 / shared.length, observedAt: m.createdAt })),
    ],
    features: {
      cosine: round3(cos),
      cosineAbove: round3(Math.min(1, (cos - REPEAT_SIMILARITY) / (1 - REPEAT_SIMILARITY))),
      sharedFiles: Math.min(shared.length, FILES_CAP) / FILES_CAP,
      sameCause: sameCause ? 1 : 0,
    },
    subject: `miss "${m.missed.slice(0, 60)}" repeats "${e.missed.slice(0, 60)}"`,
    rationale: `A new miss repeats an earlier one in ${m.projectKey}: ${why.join('; ')}. Linking them groups the repeat on the Patterns page and in hotspots; agents are not told anything new.`,
  };
}
