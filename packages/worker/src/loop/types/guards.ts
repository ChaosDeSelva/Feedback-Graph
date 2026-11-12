import { DEMO_SOURCE, type Claim, type DecisionTarget, type IntakeMeta, type Lesson, type LessonSignals, type LoopMiss, type StoredFact } from '@fb/core';
import type { LoopReads } from '../plugin.ts';

/** The owner touched it within this many days: the loop proposes at most. */
export const OWNER_TOUCH_DAYS = 14;
const DEMO_MISS = /^miss:demo:/;

/**
 * Why the loop must never target this lesson, or null: one you wrote (manual), the demo's, a run's or a sandbox's,
 * one a redaction rule read a secret in, or one telling agents to run a risky command (the owner reads that first).
 */
export function lessonNeverTarget(l: Lesson): string | null {
  if (l.source === 'manual') return 'written by you';
  if (l.source === 'demo') return 'demo';
  if (l.sandbox || l.run) return 'made in a run';
  if ((l.checks ?? []).some((c) => c.name === 'may-hold-secret')) return 'may hold a secret';
  if ((l.checks ?? []).some((c) => c.name === 'risky-command')) return 'tells agents to run a risky command';
  return null;
}

/**
 * The lesson was learned from a GitHub or Linear comment: anyone who can comment there wrote its source, which the
 * lesson checks read only for the shapes they know, so the loop proposes a change to what agents are told at most.
 */
export const fromComment = (l: Pick<Lesson, 'from'>, feedback: { external?: unknown } | null) => !!feedback?.external || l.from === 'github' || l.from === 'linear';

/** Why the loop must never target this miss, or null: the demo's, or a run's or a sandbox's. */
export function missNeverTarget(m: LoopMiss): string | null {
  if (DEMO_MISS.test(m.id)) return 'demo';
  if (m.sandbox || m.run) return 'made in a run';
  return null;
}

/** A source an agent submitted (submit_notes): its claims are never the loop's to accept (0.9.0 §9). */
export const agentSubmitted = (m: Pick<IntakeMeta, 'origin'> | null | undefined) => !!m?.origin?.startsWith('agent:');

/**
 * Why the loop must never change this claim, or null: a run's or a sandbox's, one from a source an agent submitted,
 * the owner's own answer to a question, or one whose quote matched loosely or whose statement adds to its quote (the
 * owner reads those first). `meta`: its source's details (null when it has none).
 */
export function claimNeverTarget(c: Pick<Claim, 'run' | 'sandbox' | 'docId' | 'flags'>, meta: Pick<IntakeMeta, 'origin'> | null): string | null {
  if (c.sandbox || c.run) return 'made in a run';
  if (c.docId.startsWith('answer:')) return 'your answer to a question';
  if (agentSubmitted(meta)) return 'from notes an agent submitted';
  if (c.flags.includes('quote-fuzzy')) return 'its quote matched the source only loosely';
  if (c.flags.includes('statement-adds')) return 'its statement adds to what was said';
  return null;
}

/** The owner decided or edited the lesson within OWNER_TOUCH_DAYS of `now`. */
export const ownerTouchedRecently = (s: LessonSignals | null, now: number) =>
  !!s?.lastOwnerTouch && now - Date.parse(s.lastOwnerTouch) < OWNER_TOUCH_DAYS * 86_400_000;

/**
 * Why the loop must never target this fact, or null: one you wrote, the demo's, or one whose relevance you or an
 * operator set (only a model's relevance is the loop's to change).
 */
export function factNeverTarget(f: Pick<StoredFact, 'origin' | 'source' | 'relevanceBy'>): string | null {
  if (f.origin === 'you') return 'written by you';
  if (f.source === DEMO_SOURCE) return 'demo';
  if (f.relevanceBy && f.relevanceBy !== 'model') return 'its relevance was set by you or an operator';
  return null;
}

/** The owner (you or an operator) decided the lesson within OWNER_TOUCH_DAYS: seen before the Activity fold has it. */
const ownerDecidedRecently = (l: Lesson, now: number) =>
  !!l.decidedAt && !!l.decidedBy && !l.decidedBy.startsWith('loop:') && now - Date.parse(l.decidedAt) < OWNER_TOUCH_DAYS * 86_400_000;

/**
 * The never-target and owner-touched rules again, on the targets as they are at apply time (a type checked them when
 * it found the call; the owner may have acted since): why the call may only be proposed, or null. A target that does
 * not exist (yet: one the decision creates) has nothing to check.
 */
export async function applyTimeVeto(store: Pick<LoopReads, 'knowledge' | 'facts' | 'decisions' | 'intake'>, targets: readonly DecisionTarget[], now: number): Promise<string | null> {
  for (const t of targets) {
    if (t.kind === 'lesson') {
      const l = (await store.knowledge.lessonDetail(t.id))?.lesson;
      if (!l) continue;
      const never = lessonNeverTarget(l);
      if (never) return `${t.id}: ${never}`;
      if (ownerDecidedRecently(l, now) || ownerTouchedRecently(await store.decisions.signals(t.id), now)) return `you changed ${t.id} in the last ${OWNER_TOUCH_DAYS} days`;
    } else if (t.kind === 'fact') {
      const f = await store.facts.fact(t.id);
      const never = f && factNeverTarget(f);
      if (never) return `${t.id}: ${never}`;
    } else if (t.kind === 'miss' && DEMO_MISS.test(t.id)) {
      return `${t.id}: demo`;
    } else if (t.kind === 'claim') {
      const c = await store.intake.claim(t.id);
      if (!c) continue;
      const [meta] = c.docId.startsWith('answer:') ? [] : await store.intake.metas([c.docId]);
      const never = claimNeverTarget(c, meta ?? null);
      if (never) return `${t.id}: ${never}`;
    }
  }
  return null;
}
