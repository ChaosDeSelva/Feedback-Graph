import { LESSON_CHECKS_VERSION, type Lesson, type LessonDetail } from '@fb/core';

/** A proposed post-mortem lesson of demo, checked with nothing found, on src/a.ts. */
export function lesson(id: string, o: Partial<Lesson> = {}): Lesson {
  return {
    id, projectKey: 'demo', origin: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing src/a.ts', scope: 'project', paths: ['src/a.ts'],
    status: 'proposed', source: 'postmortem', cause: 'verification_gap', missId: id.replace('lesson:', 'miss:'), createdAt: '2026-11-01T00:00:00.000Z',
    decidedAt: null, decidedBy: null, checks: [], checksVersion: LESSON_CHECKS_VERSION, decisionNote: null, ...o,
  };
}
/** The lesson with its miss and the feedback it came from (`lesson:<f>` from feedback `<f>`, miss `miss:<f>`). */
export function detail(l: Lesson, o: Partial<LessonDetail> = {}): LessonDetail {
  const fb = l.id.replace('lesson:', '');
  return {
    lesson: l, miss: { id: `miss:${fb}`, missed: 'missed it', cause: 'verification_gap', causeExplanation: 'why' },
    feedback: { id: fb, text: 'no', status: 'addressed', sessionId: `s-${fb}`, ts: '2026-11-01T00:00:00.000Z' }, contextItems: [], fixCommits: [], supersedes: [], ...o,
  };
}
