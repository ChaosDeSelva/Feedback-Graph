import { CLAIM_FACT_RELEVANCE, type Activity, type Claim, type IntakeMeta } from '@fb/core';
import type { LoopTypeContext } from '../plugin.ts';
import { claimNeverTarget } from './guards.ts';

/**
 * What knowledge intake's loop types (0.9.1) share: the claims a round reads, their sources, the owner's own record of
 * deciding claims, and how an accepted claim's fact is described. Reads only.
 */

/** Claims read per round, newest first: more than a review queue holds. */
export const CLAIM_PAGE = 500;
/** The owner's claim decisions read for the as-written rate (Activity, newest first). */
const DECISIONS_READ = 1000;

/** The newest claims of these statuses that no run made (a sandbox run's are never listed). */
export async function claimsOf(ctx: LoopTypeContext, status: Claim['status'][], o: { type?: Claim['type'][]; limit?: number } = {}): Promise<Claim[]> {
  return (await ctx.store.intake.listClaims({ status, ...(o.type && { type: o.type }), limit: o.limit ?? CLAIM_PAGE })).filter((c) => !c.run && !c.sandbox);
}

/** The sources of these claims by Doc id (an answer has none). */
export async function metasOf(ctx: LoopTypeContext, claims: Pick<Claim, 'docId'>[]): Promise<Map<string, IntakeMeta>> {
  const ids = [...new Set(claims.map((c) => c.docId).filter((id) => !id.startsWith('answer:')))];
  return new Map((ids.length ? await ctx.store.intake.metas(ids) : []).map((m) => [m.docId, m]));
}

/** Why the loop must never change this claim (claimNeverTarget), with its source read from `metas`. */
export const neverTarget = (c: Claim, metas: Map<string, IntakeMeta>) => claimNeverTarget(c, metas.get(c.docId) ?? null);

/** The owner's decisions on claims of each type: how many, and how many accepted exactly as the extraction wrote them. */
export type ClaimQuality = { decided: number; asWritten: number; rate: number };

const EDITS = new Set(['statement', 'type', 'scope', 'about']);
/** One of your claim decisions: a status set to accepted or rejected (an edit alone is not one). */
const decision = (e: Activity) => {
  const d = e.details as { status?: unknown; type?: unknown; changed?: unknown };
  const changed = Array.isArray(d.changed) ? (d.changed as string[]) : [];
  if (e.actor !== 'you' || !changed.includes('status') || (d.status !== 'accepted' && d.status !== 'rejected') || typeof d.type !== 'string') return null;
  return { type: d.type, asWritten: d.status === 'accepted' && !changed.some((k) => EDITS.has(k)) };
};

/**
 * Your own claim decisions (claim_decided by you; an operator's or the loop's are left out), per claim type as decided:
 * accepted as written (the status the only change) out of those accepted or rejected.
 */
export async function claimQuality(ctx: LoopTypeContext): Promise<Map<string, ClaimQuality>> {
  const out = new Map<string, ClaimQuality>();
  for (const e of await ctx.store.activity.list({ kind: 'claim_decided', limit: DECISIONS_READ, unlabelled: true })) {
    const d = decision(e);
    if (!d) continue;
    const q = out.get(d.type) ?? { decided: 0, asWritten: 0, rate: 0 };
    q.decided++;
    if (d.asWritten) q.asWritten++;
    q.rate = q.asWritten / q.decided;
    out.set(d.type, q);
  }
  return out;
}

const SOURCE_WORD: Record<IntakeMeta['kind'], string> = { transcript: 'call', notes: 'notes', doc: 'doc' };

/** Where an accepted claim's fact is filed and why, as the review route files it: its first scoped file (else its source), and "Ana, 2026-11-10 call". */
export async function claimFactOf(ctx: LoopTypeContext, c: Claim, meta: IntakeMeta | null) {
  const who = c.speakerId ? (await ctx.store.intake.person(c.speakerId))?.displayName ?? 'someone' : 'someone';
  const when = (c.assertedAt ?? meta?.occurredAt ?? null)?.slice(0, 10);
  return {
    path: c.scope.files[0] ?? `source:${c.docId}`,
    why: [who, [when, meta ? SOURCE_WORD[meta.kind] : 'source'].filter(Boolean).join(' ')].join(', '),
    relevance: CLAIM_FACT_RELEVANCE,
  };
}
