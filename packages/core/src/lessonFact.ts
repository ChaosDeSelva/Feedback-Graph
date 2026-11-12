import { cleanLessonPath } from './codegraph.ts';
import { EVERYDAY_FROM } from './relevance.ts';
import type { FactKind, Lesson } from './types.ts';

/** Where a fact from a lesson is filed: the lesson's first path (a glob cut back to its folder), else the project ('.'). */
export function lessonFactPath(paths: string[]): string {
  const first = paths.length ? cleanLessonPath(paths[0]) : null;
  if (!first) return '.';
  const segments = first.split('/');
  const glob = segments.findIndex((s) => /[*?[\]{}]/.test(s));
  return (glob < 0 ? segments : segments.slice(0, glob)).join('/').replace(/\/+$/, '') || '.';
}

/** A lesson as a project fact (lessonToFact), before it is embedded. */
export type LessonFact = { projectKey: string; kind: FactKind; statement: string; path: string; lines: null; why: string; relevance: number };

/**
 * A lesson converted to a fact, as the Lessons page's "convert to a fact" and the learning loop's record_fact both make
 * it: its rule as the statement, filed under its first path (lessonFactPath) in its project, why naming the lesson and
 * what was missed. null: the lesson has no project to file it under.
 */
export function lessonToFact(l: Pick<Lesson, 'title' | 'rule' | 'paths' | 'projectKey' | 'origin'>, missed: string | null, o: { kind?: FactKind; relevance?: number } = {}): LessonFact | null {
  const projectKey = l.projectKey ?? l.origin ?? null;
  if (!projectKey) return null;
  return {
    projectKey, kind: o.kind ?? 'convention', statement: l.rule, path: lessonFactPath(l.paths), lines: null,
    why: `From the lesson "${l.title}"${missed ? `: ${missed}` : ''}`, relevance: o.relevance ?? EVERYDAY_FROM,
  };
}
