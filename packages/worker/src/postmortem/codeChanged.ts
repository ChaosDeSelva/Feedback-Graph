import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanLessonPath, deriveTriggers, pathMatches, type ActivityStore, type KnowledgeStore, type Lesson, type LessonCheck } from '@fb/core';

/**
 * code-changed: an approved lesson re-checked against the code map each time the map is rebuilt. Its paths and trigger
 * paths must still name something in the repository, and the names it uses (its trigger symbols and the code-shaped
 * names of its rule) that the code defined must not have vanished or moved to other files. What changed is flagged on
 * the lesson for the owner, who decides: the worker never revokes it. The flag goes once nothing it says holds.
 */

/** A name as the code map has it: the last part of a dotted one (`client.fetchAll` is `fetchAll`). */
const bare = (name: string) => name.split('.').pop()!;
const GLOB = /[*?[\]{}]/;
const MAX_LESSONS = 1000;
const MAX_LISTED = 5;

type MapView = { symbols: { name: string; path: string }[] };

export type CodeChangedDeps = {
  k: Pick<KnowledgeStore, 'listLessons' | 'setLessonChecks'>;
  /** The repository's files (repoFileList), for globs. */
  repoFiles: (repoPath: string) => Promise<string[] | null>;
  /** Whether the path is in the repository, following symlinks (default: stat under repoPath). */
  exists?: (repoPath: string, path: string) => Promise<boolean>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
};

/** A path through a symlinked folder is the folder's: stat follows links, and git lists the link, not what is under it. */
export const existsFollowingLinks = async (repoPath: string, path: string) => !!(await stat(join(repoPath, path)).catch(() => null));

const filesOf = (m: MapView) => {
  const out = new Map<string, Set<string>>();
  for (const s of m.symbols) (out.get(s.name) ?? out.set(s.name, new Set()).get(s.name)!).add(s.path);
  return out;
};

const listed = (xs: string[]) => xs.slice(0, MAX_LISTED).map((x) => `\`${x}\``).join(', ') + (xs.length > MAX_LISTED ? ` and ${xs.length - MAX_LISTED} more` : '');

/** What no longer holds for lesson `l`, in words; [] when all of it does. */
async function changes(l: Lesson, listing: string[] | null, before: Map<string, Set<string>> | null, after: Map<string, Set<string>>, exists: (p: string) => Promise<boolean>, flagged: string): Promise<string[]> {
  const out: string[] = [];
  const gone: string[] = [];
  for (const raw of l.paths) {
    const p = cleanLessonPath(raw)?.replace(/\/+$/, '');
    if (!p) continue;
    if (GLOB.test(p) ? listing && !listing.some((f) => pathMatches(p, f)) : !(await exists(p))) gone.push(p);
  }
  if (gone.length) out.push(`its path ${listed(gone)} ${gone.length === 1 ? 'is' : 'are'} not in the repository now`);
  const deadTriggers = listing ? (l.triggers?.paths ?? []).filter((g) => !listing.some((f) => pathMatches(g, f))) : [];
  if (deadTriggers.length) out.push(`its trigger ${listed(deadTriggers)} matches no file now`);
  const names = [...new Set([...(l.triggers?.symbols ?? []), ...deriveTriggers({ rule: l.rule, appliesWhen: '', files: [] }).symbols])];
  const vanished: string[] = [];
  const moved: string[] = [];
  for (const name of names) {
    const was = before?.get(bare(name));
    const now = after.get(bare(name));
    // Gone in this rebuild, or flagged gone before and still not back.
    if (!now && (was || flagged.includes(`\`${name}\``))) vanished.push(name);
    else if (was && now && ![...was].some((f) => now.has(f))) moved.push(`\`${name}\` (now in ${[...now].slice(0, 2).join(', ')})`);
  }
  if (vanished.length) out.push(`${listed(vanished)} ${vanished.length === 1 ? 'is' : 'are'} gone from the code`);
  if (moved.length) out.push(`moved to other files: ${moved.slice(0, MAX_LISTED).join(', ')}`);
  return out;
}

/**
 * Check the approved lessons of a project whose map was just rebuilt against it (before: the map it replaced, null for
 * the first). Each lesson gets code-changed with what changed, or loses it once nothing does; its status is never
 * touched. Activity names the lessons flagged and cleared.
 */
export async function checkLessonsAgainstMap(d: CodeChangedDeps, p: { key: string; repoPath: string }, before: MapView | null, after: MapView): Promise<{ flagged: string[]; cleared: string[] }> {
  const out = { flagged: [] as string[], cleared: [] as string[] };
  const lessons = (await d.k.listLessons({ projectKey: p.key, status: 'approved', limit: MAX_LESSONS }))
    .filter((l) => (l.projectKey === p.key || (l.projectKey === null && l.origin === p.key)) && !l.sandbox);
  if (!lessons.length) return out;
  const listing = await d.repoFiles(p.repoPath).catch(() => null);
  const exists = (path: string) => (d.exists ?? existsFollowingLinks)(p.repoPath, path).catch(() => true);
  const was = before ? filesOf(before) : null;
  const now = filesOf(after);
  for (const l of lessons) {
    const prior = l.checks?.find((c) => c.name === 'code-changed');
    const what = await changes(l, listing, was, now, exists, prior?.why ?? '');
    const flag: LessonCheck | null = what.length ? { name: 'code-changed', why: `the code changed since it was approved: ${what.join('; ')}. Edit, keep or revoke it` } : null;
    if (flag?.why === prior?.why) continue;
    const checks = [...(l.checks ?? []).filter((c) => c.name !== 'code-changed'), ...(flag ? [flag] : [])];
    if (!(await d.k.setLessonChecks(l.id, checks, l.checksVersion ?? 0))) continue;
    (flag ? out.flagged : out.cleared).push(l.id);
    d.log?.(flag ? 'approved lesson flagged: its code changed' : 'approved lesson no longer flagged: its code is back', { id: l.id, project: p.key, ...(flag && { why: flag.why }) });
  }
  if (out.flagged.length || out.cleared.length) {
    await d.activity?.record({
      kind: 'lessons_checked', actor: 'lesson-check', projectKey: p.key,
      subject: `code map rebuilt: ${out.flagged.length} approved lesson${out.flagged.length === 1 ? '' : 's'} flagged as about code that changed${out.cleared.length ? `, ${out.cleared.length} no longer` : ''}`,
      why: 'an approved lesson whose paths, triggers or named code changed or vanished may no longer apply; it stays approved and served until you edit, keep or revoke it',
      details: { flagged: out.flagged.length, cleared: out.cleared.length },
      targets: [...out.flagged, ...out.cleared].slice(0, 500),
    });
  }
  return out;
}
