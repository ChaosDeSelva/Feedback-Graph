import type { ActivityStore, KnowledgeStore } from '@fb/core';

export type WithdrawDeps = {
  knowledge: Pick<KnowledgeStore, 'lessonDetail' | 'updateLesson' | 'setLessonChecks'>;
  activity: Pick<ActivityStore, 'record'>;
};

/**
 * A memory lesson the agent wrote after feedback already in the Inbox (memory.ts correlation) is not learnt twice: one
 * still undecided and never edited is rejected; one decided or edited gets a duplicate-of check pointing at the
 * feedback's lesson for the owner to review. Each is logged in Activity once; a lesson that is not a live memory
 * lesson, or already carries the check, is left alone.
 */
export async function withdrawDuplicateMemory(d: WithdrawDeps, id: string, feedbackId: string | null): Promise<void> {
  const lesson = (await d.knowledge.lessonDetail(id))?.lesson;
  if (!lesson || lesson.source !== 'memory' || lesson.status === 'rejected' || lesson.status === 'superseded' || lesson.status === 'revoked') return;
  if (lesson.status === 'proposed' && !lesson.decidedAt && !lesson.proposedAs) {
    await d.knowledge.updateLesson(id, { status: 'rejected' }, { by: 'memory-deduplication', note: 'the agent wrote this memory after feedback already represented in the Inbox' });
  } else if (!(lesson.checks ?? []).some((check) => check.name === 'duplicate-of')) {
    await d.knowledge.setLessonChecks(id, [...(lesson.checks ?? []), { name: 'duplicate-of', why: 'This memory was written after the same feedback event; review this existing lesson rather than learning it twice.', ...(feedbackId && { of: `lesson:${feedbackId}` }) }]);
  } else return;
  await d.activity.record({ kind: 'lesson_decided', actor: 'memory-deduplication', projectKey: lesson.projectKey,
    subject: `duplicate feedback memory: ${lesson.title}`, why: 'the persisted agent session wrote this memory after an Inbox feedback event', targets: [id, ...(feedbackId ? [feedbackId] : [])] });
}
