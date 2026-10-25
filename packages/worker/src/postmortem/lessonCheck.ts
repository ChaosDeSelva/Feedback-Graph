import type { HumanTurn, PostMortem } from '@fb/core';

/**
 * A cheap check on a proposed lesson before the owner sees it: is it scoped and falsifiable, or has one comment been
 * turned into a rule for everything? It narrows only what is clearly wrong (a path outside the repository, a universal
 * rule drawn from one nit) and flags the rest; the owner still approves every lesson.
 */

export type LessonFlag = { name: 'non-repo-path' | 'universal-from-nit' | 'meta-lesson'; why: string };

const UNIVERSAL = /\b(always|never|every|all|any|mandatory|must|regardless)\b/i;
const NIT = /\bnit\b|nitpick|\bminor\b|\boptional\b|\bLOW\b|\btypo\b|\bcosmetic\b/;
/** A rule about how to treat feedback or reviewers rather than about the work. */
const META = /\b(treat|ignore|prioriti[sz]e|defer to|obey|disregard)\b[^.]{0,60}\b(feedback|review(er)?s?|nitpicks?|comments?)\b|\b(feedback|review(er)?s?|nitpicks?|comments?)\b[^.]{0,60}\b(as mandatory|must be followed)\b/i;

export function checkLesson(lesson: PostMortem['lesson'], feedback: HumanTurn): { lesson: PostMortem['lesson']; flags: LessonFlag[] } {
  const flags: LessonFlag[] = [];
  let out = lesson;
  const paths = lesson.paths.filter((p) => !p.startsWith('~') && !p.includes(':'));
  if (paths.length !== lesson.paths.length) {
    flags.push({ name: 'non-repo-path', why: `dropped ${lesson.paths.filter((p) => !paths.includes(p)).join(', ')}: not a repository path` });
    out = { ...out, paths };
  }
  const nit = NIT.test(feedback.text) || feedback.external?.reviewState === 'APPROVED';
  if (nit && lesson.scope !== 'task' && UNIVERSAL.test(lesson.rule)) {
    flags.push({ name: 'universal-from-nit', why: `a ${lesson.scope}-wide rule from one minor comment; narrowed to the task` });
    out = { ...out, scope: 'task' };
  }
  if (META.test(`${lesson.title}. ${lesson.rule}`)) flags.push({ name: 'meta-lesson', why: 'about how to treat feedback, not about the work' });
  return { lesson: out, flags };
}
