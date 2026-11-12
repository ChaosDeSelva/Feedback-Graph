import { cleanLessonPath, inHoldout, lessonPathsSnapshot, readRenames, type Lesson, type LessonTriggers } from '@fb/core';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { decidedAlready } from './approve_lesson.ts';
import { lessonNeverTarget } from './guards.ts';

const live = (l: Lesson) => l.status === 'proposed' || l.status === 'approved';

/** The new name of each path git renamed: only when the old one is gone from the code map and the new one is in it. */
type Renamer = (path: string) => string | null;

async function renamerFor(ctx: LoopTypeContext, projectKey: string): Promise<Renamer | null> {
  const renames = await readRenames(ctx.store.docs, projectKey);
  if (!Object.keys(renames).length) return null;
  const map = await ctx.store.codegraph.codeMap(projectKey);
  if (!map) return null;
  const files = new Set([...map.files, ...map.outside].map((f) => f.path));
  return (raw) => {
    const p = cleanLessonPath(raw);
    const to = p ? renames[p] : undefined;
    return to && !files.has(p!) && files.has(to) ? to : null;
  };
}

/**
 * update_paths (tier H, housekeeping, 0.9.1): a proposed or approved lesson whose paths or trigger paths name a file git
 * renamed (the code map's churn window, -M) gets the new name: exactly that path, only when the old name is gone from
 * the code map and the new one is in it. Globs and folders are left alone. Without it the lesson silently stops firing
 * for the file it was learned on (and code-changed flags it). Rolling back restores the old names.
 */
export const updatePaths: LoopType = {
  type: 'update_paths',
  weights: { bias: 2, renamed: 1 },
  groups: { scope: ['renamed'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const renamers = new Map<string, Promise<Renamer | null>>();
    let scanned = 0;
    for (const l of await ctx.lessons()) {
      if (!live(l) || !l.projectKey) continue;
      const trigs = l.triggers?.paths ?? [];
      if (!l.paths.length && !trigs.length) continue;
      if (!renamers.has(l.projectKey)) renamers.set(l.projectKey, renamerFor(ctx, l.projectKey));
      const rename = await renamers.get(l.projectKey)!;
      if (!rename) continue;
      const moved = [...new Set([...l.paths, ...trigs])].flatMap((p) => { const to = rename(p); return to ? [[p, to] as const] : []; });
      if (!moved.length) continue;
      scanned++;
      if (lessonNeverTarget(l)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(l.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      if (inHoldout(l.id, ctx.holdout)) { skip(skipped, SKIP.holdout); continue; }
      if (await decidedAlready(ctx, 'update_paths', l.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
      candidates.push(pathsCandidate(l, new Map(moved), ctx.now));
    }
    return { candidates, scanned, skipped };
  },
};

/** The call moving each renamed path of `l` to its new name. */
export function pathsCandidate(l: Lesson, moved: Map<string, string>, now: number): LoopCandidate {
  const to = (p: string) => moved.get(p) ?? p;
  const dedupe = (xs: string[]) => [...new Set(xs.map(to))];
  const triggers: LessonTriggers | null = l.triggers ? { ...l.triggers, paths: dedupe(l.triggers.paths) } : null;
  const after: Lesson = { ...l, paths: dedupe(l.paths), triggers };
  const pairs = [...moved];
  return {
    projectKey: l.projectKey,
    targets: [{ kind: 'lesson', id: l.id, role: 'primary' }],
    before: [lessonPathsSnapshot(l)],
    after: [lessonPathsSnapshot(after)],
    evidence: pairs.map(([from, toPath]) => ({ kind: 'lesson' as const, id: l.id, role: `git renamed ${from} to ${toPath}`, weight: 1, observedAt: new Date(now).toISOString() })),
    features: { renamed: Math.min(pairs.length, 3) / 3 },
    subject: `update paths of "${l.title.slice(0, 60)}": ${pairs.map(([a, b]) => `${a} → ${b}`).join(', ').slice(0, 160)}`,
    rationale: `git renamed ${pairs.map(([a, b]) => `${a} to ${b}`).join(', ')}; the old name is no longer in the code map and the new one is, so the lesson names the new one${l.triggers ? ' (its trigger paths too)' : ''} and keeps firing for that file.`,
  };
}
