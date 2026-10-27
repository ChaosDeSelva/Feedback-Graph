import { modelTimeoutReason, providerUnavailableReason, redactSecrets, type ActivityStore, type KnowledgeStore, type Lesson, type LlmProvider, type PostMortem, type PostMortemInput } from '@fb/core';
import type { PostMortemTrace } from './postmortem.ts';
import { duplicateFlag } from './recheck.ts';

export type PostmortemStepDeps = {
  k: Pick<KnowledgeStore, 'feedbackNeedingPostmortem' | 'savePostmortem' | 'recordPostmortemFailure'> &
    Partial<Pick<KnowledgeStore, 'similarLessons' | 'setLessonChecks' | 'updateLesson' | 'lessonDetail'>>;
  postmortem(input: PostMortemInput): Promise<PostMortem & { trace?: PostMortemTrace }>;
  embed(texts: string[]): Promise<number[][]>;
  batch: number;
  log?: (msg: string, extra?: object) => void;
  activity?: Pick<ActivityStore, 'record'>;
  /** True while a scan is using a model: a timeout then means a queue behind it, not this feedback's fault. */
  modelBusy?: () => boolean;
  /**
   * The feedback whose post-mortem was last found "unavailable", and how many cycles it was while the provider was
   * otherwise healthy: kept by the caller across cycles. After `unavailableCap` (default UNAVAILABLE_CAP) such cycles
   * the same item is charged a failure (attempts, backoff), so one item that always reads as unavailable (its own text
   * trips the provider) cannot hold the queue forever.
   */
  unavailableStreak?: { feedbackId: string | null; count: number };
  unavailableCap?: number;
  /**
   * Whether the post-mortem's provider answers a neutral ask now (providerAnswers). Asked only when an item reads as
   * unavailable and no scan holds the model; a cycle counts toward the cap only when it says true. Unset: never true,
   * so nothing is charged for unavailability (an outage must never use up the backlog's attempts).
   */
  providerHealthy?: () => Promise<boolean>;
};

/**
 * Cycles the same feedback may pause the queue as "model unavailable", while the provider answers other asks, before
 * it is charged a failure. Cycles of an outage (no answer to the health ask) or of a busy model never count.
 */
export const UNAVAILABLE_CAP = 5;

const HEALTH_ASK = {
  system: 'Health check. Answer only with the JSON asked for.',
  user: 'Reply with {"ok": true}.',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  maxTokens: 16,
};

/**
 * Whether `llm` answers a tiny neutral ask: false when it is unavailable or times out, true on any answer (a bad one
 * still means it is up). Tells an outage from one feedback whose own post-mortem reads as "unavailable".
 */
export async function providerAnswers(llm: Pick<LlmProvider, 'json'>, timeoutMs = 60_000): Promise<boolean> {
  try {
    await llm.json({ ...HEALTH_ASK, timeoutMs });
    return true;
  } catch (err) {
    return !providerUnavailableReason(err) && !modelTimeoutReason(err);
  }
}

export function embedTexts(pm: PostMortem): { miss: string; lesson: string } {
  return {
    miss: `${pm.missed}\n${pm.causeExplanation}`,
    lesson: `${pm.lesson.title}\n${pm.lesson.rule}\nApplies when: ${pm.lesson.appliesWhen}`,
  };
}

/** Who rejects the lesson of a post-mortem that found no miss. */
export const NO_MISS_DECIDER = 'postmortem';

/** The no-miss flag's why, for a lesson the owner touched (decided only by the owner). */
export const noMissWhy = (said: string) => `the post-mortem found no miss ("${said.slice(0, 300)}"): this lesson may be invented; it is yours to decide`;

/**
 * The stored lesson when the owner has touched it (edited it while proposed, or decided it): a re-save keeps the owner's
 * words (the stores), and nothing here may change it but a flag. Null: the writer's alone (or not known).
 */
async function ownersLesson(deps: PostmortemStepDeps, id: string): Promise<Lesson | null> {
  const l = (await deps.k.lessonDetail?.(id).catch(() => null))?.lesson;
  return l && (l.proposedAs || l.status !== 'proposed') ? l : null;
}

async function duplicateOfSaved(deps: PostmortemStepDeps, id: string) {
  if (!deps.k.similarLessons || !deps.k.setLessonChecks) return null;
  return duplicateFlag({ id, status: 'proposed', createdAt: new Date().toISOString() }, await deps.k.similarLessons(id, 5));
}

/**
 * Post-mortems for confirmed feedback, a batch at a time. A failure counts against that feedback (attempts, backoff),
 * except when the model (or the embedding model) could not be asked at all: that is not the feedback's fault, so
 * nothing is recorded and the rest of the batch waits for the next cycle (`unavailable` says why). Only when the same
 * feedback reads as unavailable `unavailableCap` times while the provider answers other asks is it charged like any
 * other failure.
 */
export async function runPostmortems(deps: PostmortemStepDeps): Promise<{ done: number; failed: number; unavailable?: string }> {
  let done = 0;
  let failed = 0;
  const streak = deps.unavailableStreak;
  const cap = deps.unavailableCap ?? UNAVAILABLE_CAP;
  for (const input of await deps.k.feedbackNeedingPostmortem(deps.batch)) {
    let charged: string | null = null;
    try {
      const { trace, ...pm } = await deps.postmortem(input);
      const t = embedTexts(pm);
      // A dropped lesson (no rule even after the retry, postmortem.ts) is not saved, so it needs no embedding.
      const [miss, lesson = []] = await deps.embed(pm.lessonDropped ? [t.miss] : [t.miss, t.lesson]);
      await deps.k.savePostmortem(input.feedbackId, pm, { miss, lesson });
      done++;
      const lessonId = `lesson:${input.feedbackId}`;
      const owners = pm.lessonDropped && !pm.noMiss ? null : await ownersLesson(deps, lessonId);
      // Its own miss says there was none: the lesson it wrote is invented, so it is saved rejected, never proposed. One
      // the owner edited or decided is the owner's: it is flagged no-miss for them to decide, never decided here.
      if (pm.noMiss && !owners) await deps.k.updateLesson?.(lessonId, { status: 'rejected' }, { by: NO_MISS_DECIDER, note: `no miss: the post-mortem said "${pm.noMiss.slice(0, 300)}", so no lesson` });
      if (pm.noMiss && owners && owners.status !== 'rejected' && owners.status !== 'superseded' && !(owners.checks ?? []).some((c) => c.name === 'no-miss')) {
        await deps.k.setLessonChecks?.(lessonId, [...(owners.checks ?? []), { name: 'no-miss', why: noMissWhy(pm.noMiss) }]);
      }
      if (streak) Object.assign(streak, { feedbackId: null, count: 0 });
      // Only a saved lesson has an embedding to compare: one that repeats a lesson of the project is flagged now (the
      // writer's lesson only: an owner's keeps its checks).
      const dup = pm.lessonDropped || owners ? null : await duplicateOfSaved(deps, lessonId).catch(() => null);
      if (dup) {
        pm.lessonChecks = [...(pm.lessonChecks ?? []), dup];
        if (trace) trace.lessonFlags = [...trace.lessonFlags, dup];
        await deps.k.setLessonChecks!(lessonId, pm.lessonChecks);
      }
      await deps.activity?.record({
        kind: 'postmortem_done',
        actor: trace?.provider ?? 'postmortem',
        projectKey: input.projectKey,
        subject: pm.noMiss ? `no miss, no lesson: ${pm.missed}` : `missed: ${pm.missed}`,
        why: pm.causeExplanation,
        details: {
          cause: pm.cause,
          task: pm.taskTitle,
          feedback: input.feedback?.text,
          lesson: pm.lessonDropped ? null : { title: pm.lesson.title, rule: pm.lesson.rule, appliesWhen: pm.lesson.appliesWhen, scope: pm.lesson.scope, paths: pm.lesson.paths },
          ...(pm.lessonDropped && { lessonDropped: pm.lessonDropped }),
          contextGiven: trace && { standing: trace.standing, facts: trace.facts, agentic: trace.agentic },
          contextFound: (pm.contextItems ?? []).map((c) => ({ kind: c.kind, ref: c.ref, why: c.why, wasAvailable: c.wasAvailable })),
          // What the lesson check narrowed or flagged (lessonCheck.ts), for the owner deciding on the lesson.
          lessonChecks: trace?.lessonFlags ?? [],
          lessonShaped: trace?.lessonShaped ?? [],
          // 'process': about how the work was handled, so on no file; 'code' otherwise.
          subject: pm.subject ?? 'code',
          // Facts it noticed beside the lesson: proposals for the owner, never stored as facts or served.
          proposedFacts: pm.facts ?? [],
          // A comment's post-mortem: the session it was worked out against and how it was matched (null: none matched).
          ...(trace?.workSession !== undefined && { workSession: trace.workSession }),
          // The lessons shown to the writer as the owner's examples (examples.ts), by id: [] when none were.
          ...(trace && { examples: trace.examples ?? [] }),
          ...(pm.noMiss && { noLesson: pm.noMiss }),
        },
        targets: [input.feedbackId, ...(pm.noMiss ? [] : [`miss:${input.feedbackId}`]), ...(pm.lessonDropped ? [] : [`lesson:${input.feedbackId}`])],
      });
      deps.log?.('postmortem saved', { feedbackId: input.feedbackId, cause: pm.cause });
    } catch (err) {
      const timeout = modelTimeoutReason(err);
      const unavailable = providerUnavailableReason(err) ?? (timeout && deps.modelBusy?.() ? `the model is busy with a scan: ${timeout}` : null);
      if (unavailable) {
        const prev = streak?.feedbackId === input.feedbackId ? streak.count : 0;
        // Only a cycle where the provider answers everything else counts: a busy model or an outage is not this item.
        const busy = !providerUnavailableReason(err);
        const counts = !!streak && !busy && !!deps.providerHealthy && (await deps.providerHealthy().catch(() => false));
        const count = prev + (counts ? 1 : 0);
        if (!streak || count < cap) {
          if (streak) Object.assign(streak, { feedbackId: input.feedbackId, count });
          deps.log?.('postmortem model unavailable, pausing until next cycle', { feedbackId: input.feedbackId, reason: unavailable, inARow: count, providerHealthy: counts });
          return { done, failed, unavailable };
        }
        // The same item read as unavailable `cap` times while the provider answered other asks: charge it (attempts,
        // backoff) so the queue moves on.
        Object.assign(streak, { feedbackId: null, count: 0 });
        charged = `model unavailable ${count} times in a row on this feedback while the provider answered other asks: ${unavailable}`;
      }
      failed++;
      // The error can carry model output (what it read and quoted), so it is redacted before it goes anywhere.
      const error = redactSecrets(charged ? `${charged} (${String(err)})` : String(err));
      const next = await deps.k.recordPostmortemFailure(input.feedbackId, error);
      await deps.activity?.record({
        kind: 'postmortem_failed', actor: 'postmortem', projectKey: input.projectKey,
        subject: `post-mortem failed (attempt ${next.attempts}); ${next.retryAt ? `retrying at ${next.retryAt}` : 'gave up, retry it from the API'}`,
        why: error, targets: [input.feedbackId],
      });
      deps.log?.('postmortem failed', { feedbackId: input.feedbackId, error });
    }
  }
  return { done, failed };
}
