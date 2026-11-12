import { candidateSnapshot, feedbackSkipRule, isSelfReview, type Candidate } from '@fb/core';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';

/** Pending Inbox items looked at each round. */
const PENDING_PAGE = 200;
/** The classifier is this sure it is pushback or a correction: confirm. */
export const CONFIRM_FROM = 0.85;
/** The classifier is this unsure, and no agent reported the miss: reject. */
export const REJECT_BELOW = 0.35;
const DEMO_ITEM = /^demo:/;

/** Why the loop must never triage this item, or null: the demo's, or a run's or a sandbox's. */
export function candidateNeverTarget(c: Candidate): string | null {
  if (DEMO_ITEM.test(c.id)) return 'demo';
  if (c.sandbox || c.run) return 'made in a run';
  return null;
}

type Call = { status: 'confirmed' | 'rejected'; why: string; skipRule: string | null };

/** What the item's evidence says: confirm, reject (and why), or null when it is neither sure enough. */
async function callFor(ctx: LoopTypeContext, c: Candidate): Promise<Call | null> {
  if (c.external) {
    const turn = (await ctx.store.graph.candidateDetail(c.id))?.turn;
    const rule = turn ? feedbackSkipRule(turn.text, c.external) : null;
    if (rule) return { status: 'rejected', why: `a skip rule matches it now (${rule.name}: ${rule.description})`, skipRule: rule.name };
    if (isSelfReview(c.external) || c.classification.signals.includes('self-review')) return { status: 'rejected', why: 'an agent reviewing its own pull request', skipRule: null };
  }
  const agent = c.origins!.includes('agent'); // set by the stores on every item
  const { label, confidence } = c.classification;
  if ((label === 'pushback' || label === 'correction') && confidence >= CONFIRM_FROM) return { status: 'confirmed', why: `the classifier is ${Math.round(confidence * 100)}% sure it is ${label}${agent ? ', and the agent reported the miss itself' : ''}`, skipRule: null };
  if (confidence < REJECT_BELOW && !agent) return { status: 'rejected', why: `the classifier is only ${Math.round(confidence * 100)}% sure it is ${label}, and no agent reported a miss`, skipRule: null };
  return null;
}

/**
 * triage_inbox (tier P: always a proposal): confirm or reject a pending Inbox item. Reject: a skip rule matches the
 * synced comment now, an agent reviewing its own pull request, or the classifier under REJECT_BELOW with no agent
 * report. Confirm: pushback or a correction at CONFIRM_FROM or more. Confirming spends a post-mortem; nothing reaches an
 * agent until a lesson exists. The item is decided by whoever approves the proposal (`decidedBy` left to the executor).
 */
export const triageInbox: LoopType = {
  type: 'triage_inbox',
  weights: { bias: -1, confidence: 2, agentReported: 1, skipRule: 2, external: -0.3 },
  groups: { evidence: ['confidence', 'agentReported', 'skipRule'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const pending = await ctx.store.graph.listCandidates({ status: 'pending', limit: PENDING_PAGE });
    for (const c of pending) {
      if (candidateNeverTarget(c)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(c.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      const call = await callFor(ctx, c);
      if (!call) { skip(skipped, SKIP.belowFloor); continue; }
      candidates.push(triageCandidate(c, call));
    }
    return { candidates, scanned: pending.length, skipped };
  },
};

function triageCandidate(c: Candidate, call: Call): LoopCandidate {
  const agent = c.origins!.includes('agent'); // set by the stores on every item
  const text = (c.classification.summary || c.id).slice(0, 80);
  return {
    projectKey: c.projectKey,
    targets: [{ kind: 'candidate', id: c.id, role: 'primary' }],
    before: [candidateSnapshot(c)],
    after: [candidateSnapshot({ id: c.id, status: call.status, note: `triage: ${call.why}`, decidedBy: null })],
    evidence: [
      { kind: 'candidate', id: c.id, role: `classified ${c.classification.label}`, weight: c.classification.confidence, observedAt: c.createdAt },
      ...(call.skipRule ? [{ kind: 'candidate' as const, id: c.id, role: `skip rule ${call.skipRule}`, weight: 1, observedAt: c.createdAt }] : []),
      ...(agent ? [{ kind: 'candidate' as const, id: c.id, role: 'agent reported', weight: 1, observedAt: c.agentReport?.reportedAt ?? c.createdAt }] : []),
    ],
    features: {
      confidence: call.status === 'confirmed' ? c.classification.confidence : 1 - c.classification.confidence,
      agentReported: agent ? 1 : 0, skipRule: call.skipRule ? 1 : 0, external: c.external ? 1 : 0,
    },
    subject: `${call.status === 'confirmed' ? 'confirm' : 'reject'} Inbox item "${text}"`,
    rationale: `${call.status === 'confirmed' ? 'Confirm' : 'Reject'} this Inbox item: ${call.why}.${call.status === 'confirmed' ? ' Confirming starts its post-mortem; nothing reaches an agent until a lesson is approved.' : ''}`,
  };
}
