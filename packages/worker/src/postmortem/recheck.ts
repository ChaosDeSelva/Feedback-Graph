import type { ActivityStore, KnowledgeStore } from '@fb/core';
import { recheckLesson } from './lessonCheck.ts';

/** More proposed lessons than any instance holds; one pass, so a store that cannot save never loops. */
const MAX_LESSONS = 10_000;

/**
 * The lesson checks for proposed lessons that never had them (proposed before the checks were stored): flags only,
 * the lessons are left as they are (recheckLesson), so the owner sees on the Lessons page what the checks would have
 * said. Runs once at worker start; a lesson checked once has `checks` ([] when clean) and is not checked again.
 */
export async function recheckProposedLessons(d: {
  k: Pick<KnowledgeStore, 'listLessons' | 'lessonDetail' | 'setLessonChecks'>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
}): Promise<number> {
  const todo = (await d.k.listLessons({ status: 'proposed', limit: MAX_LESSONS })).filter((l) => l.checks == null);
  const counts: Record<string, number> = {};
  let flagged = 0;
  for (const l of todo) {
    const detail = await d.k.lessonDetail(l.id);
    const flags = recheckLesson(l, detail?.feedback?.text ?? '');
    await d.k.setLessonChecks(l.id, flags);
    if (flags.length) flagged++;
    for (const f of flags) counts[f.name] = (counts[f.name] ?? 0) + 1;
  }
  if (todo.length) {
    d.log?.('proposed lessons checked', { checked: todo.length, flagged });
    await d.activity?.record({
      kind: 'lessons_checked', actor: 'lesson-check', projectKey: null,
      subject: `${todo.length} proposed lesson${todo.length === 1 ? '' : 's'} checked: ${flagged} flagged`,
      why: 'proposed before the lesson checks were stored; the flags are shown on each lesson, nothing was changed',
      details: { checked: todo.length, flagged, flags: counts },
    });
  }
  return todo.length;
}
