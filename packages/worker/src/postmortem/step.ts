import { modelTimeoutReason, providerUnavailableReason, redactSecrets, type ActivityStore, type KnowledgeStore, type PostMortem, type PostMortemInput } from '@fb/core';
import type { PostMortemTrace } from './postmortem.ts';
import { duplicateFlag } from './recheck.ts';

export type PostmortemStepDeps = {
  k: Pick<KnowledgeStore, 'feedbackNeedingPostmortem' | 'savePostmortem' | 'recordPostmortemFailure'> &
    Partial<Pick<KnowledgeStore, 'similarLessons' | 'setLessonChecks'>>;
  postmortem(input: PostMortemInput): Promise<PostMortem & { trace?: PostMortemTrace }>;
  embed(texts: string[]): Promise<number[][]>;
  batch: number;
  log?: (msg: string, extra?: object) => void;
  activity?: Pick<ActivityStore, 'record'>;
  /** True while a scan is using a model: a timeout then means a queue behind it, not this feedback's fault. */
  modelBusy?: () => boolean;
};

export function embedTexts(pm: PostMortem): { miss: string; lesson: string } {
  return {
    miss: `${pm.missed}\n${pm.causeExplanation}`,
    lesson: `${pm.lesson.title}\n${pm.lesson.rule}\nApplies when: ${pm.lesson.appliesWhen}`,
  };
}

async function duplicateOfSaved(deps: PostmortemStepDeps, id: string) {
  if (!deps.k.similarLessons || !deps.k.setLessonChecks) return null;
  return duplicateFlag({ id, status: 'proposed', createdAt: new Date().toISOString() }, await deps.k.similarLessons(id, 5));
}

/**
 * Post-mortems for confirmed feedback, a batch at a time. A failure counts against that feedback (attempts, backoff),
 * except when the model (or the embedding model) could not be asked at all: that is not the feedback's fault, so
 * nothing is recorded and the rest of the batch waits for the next cycle (`unavailable` says why).
 */
export async function runPostmortems(deps: PostmortemStepDeps): Promise<{ done: number; failed: number; unavailable?: string }> {
  let done = 0;
  let failed = 0;
  for (const input of await deps.k.feedbackNeedingPostmortem(deps.batch)) {
    try {
      const { trace, ...pm } = await deps.postmortem(input);
      const t = embedTexts(pm);
      const [miss, lesson] = await deps.embed([t.miss, t.lesson]);
      await deps.k.savePostmortem(input.feedbackId, pm, { miss, lesson });
      done++;
      // Only a saved lesson has an embedding to compare: one that repeats a lesson of the project is flagged now.
      const dup = await duplicateOfSaved(deps, `lesson:${input.feedbackId}`).catch(() => null);
      if (dup) {
        pm.lessonChecks = [...(pm.lessonChecks ?? []), dup];
        if (trace) trace.lessonFlags = [...trace.lessonFlags, dup];
        await deps.k.setLessonChecks!(`lesson:${input.feedbackId}`, pm.lessonChecks);
      }
      await deps.activity?.record({
        kind: 'postmortem_done',
        actor: trace?.provider ?? 'postmortem',
        projectKey: input.projectKey,
        subject: `missed: ${pm.missed}`,
        why: pm.causeExplanation,
        details: {
          cause: pm.cause,
          task: pm.taskTitle,
          feedback: input.feedback?.text,
          lesson: { title: pm.lesson.title, rule: pm.lesson.rule, appliesWhen: pm.lesson.appliesWhen, scope: pm.lesson.scope, paths: pm.lesson.paths },
          contextGiven: trace && { standing: trace.standing, facts: trace.facts, agentic: trace.agentic },
          contextFound: (pm.contextItems ?? []).map((c) => ({ kind: c.kind, ref: c.ref, why: c.why, wasAvailable: c.wasAvailable })),
          // What the lesson check narrowed or flagged (lessonCheck.ts), for the owner deciding on the lesson.
          lessonChecks: trace?.lessonFlags ?? [],
          lessonShaped: trace?.lessonShaped ?? [],
          // 'process': about how the work was handled, so on no file; 'code' otherwise.
          subject: pm.subject ?? 'code',
          // Facts it noticed beside the lesson: proposals for the owner, never stored as facts or served.
          proposedFacts: pm.facts ?? [],
        },
        targets: [input.feedbackId, `miss:${input.feedbackId}`, `lesson:${input.feedbackId}`],
      });
      deps.log?.('postmortem saved', { feedbackId: input.feedbackId, cause: pm.cause });
    } catch (err) {
      const timeout = modelTimeoutReason(err);
      const unavailable = providerUnavailableReason(err) ?? (timeout && deps.modelBusy?.() ? `the model is busy with a scan: ${timeout}` : null);
      if (unavailable) {
        deps.log?.('postmortem model unavailable, pausing until next cycle', { feedbackId: input.feedbackId, reason: unavailable });
        return { done, failed, unavailable };
      }
      failed++;
      // The error can carry model output (what it read and quoted), so it is redacted before it goes anywhere.
      const error = redactSecrets(String(err));
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
