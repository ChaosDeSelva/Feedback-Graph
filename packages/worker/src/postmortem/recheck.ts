import { LESSON_CHECKS_VERSION, type ActivityStore, type KnowledgeStore, type Lesson, type LessonCheck, type LessonCheckName, type SimilarLesson } from '@fb/core';
import { MODEL_FACT_WHY, recheckLesson, saysWrongSession } from './lessonCheck.ts';
import { junkPathReason, repoHas } from './paths.ts';

/** More lessons than any instance holds; one pass, so a store that cannot save never loops. */
const MAX_LESSONS = 10_000;

/** Lessons this close (cosine of their stored embeddings, same project) say the same thing. */
export const DUPLICATE_COSINE = 0.92;
/** Neighbours looked at per lesson: the nearest that counts is enough. */
const NEIGHBOURS = 5;

const MAX_TARGETS = 500;

const GLOB = /[*?[\]{}]/;

/**
 * Flags a re-check cannot work out again, kept from the earlier checks: made from the comment's metadata (who wrote
 * it, the matched session) or by the model, neither of which is stored with the lesson; or a repair already applied to
 * the lesson (a dropped path, the title used as the rule).
 */
const kept = (c: LessonCheck) =>
  c.name === 'wrong-session' || c.name === 'self-review' || c.name === 'non-repo-path' || c.name === 'broken-rule' ||
  (c.name === 'looks-like-a-fact' && c.why === MODEL_FACT_WHY);

/**
 * duplicate-of, when a near-identical lesson of the same project (DUPLICATE_COSINE) is the one to keep: an approved one
 * over one that is not, else the older. Rejected and superseded lessons do not count. Of a pair, only one is flagged.
 */
export function duplicateFlag(me: Pick<Lesson, 'id' | 'status' | 'createdAt'>, near: SimilarLesson[]): LessonCheck | null {
  const rank = (s: string) => (s === 'approved' ? 1 : 0);
  const older = (a: Pick<SimilarLesson, 'createdAt' | 'id'>, b: Pick<SimilarLesson, 'createdAt' | 'id'>) =>
    a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
  const other = near.find((n) =>
    n.id !== me.id && n.cosine >= DUPLICATE_COSINE && (n.status === 'approved' || n.status === 'proposed') &&
    (rank(n.status) > rank(me.status) || (rank(n.status) === rank(me.status) && older(n, me))));
  return other ? { name: 'duplicate-of', of: other.id, why: `repeats ${other.id} (cosine ${other.cosine.toFixed(2)}): merge them or reject one` } : null;
}

export type RecheckDeps = {
  k: Pick<KnowledgeStore, 'listLessons' | 'lessonDetail' | 'setLessonChecks'> & Partial<Pick<KnowledgeStore, 'staleLessonChecks' | 'similarLessons'>>;
  /** Each project's repository folder as the worker sees it; unset or missing a project: its paths are not looked up. */
  repoPaths?: () => Promise<Map<string, string>>;
  /** Whether the repository has the path (default repoHas: true when the repository is not mounted). */
  exists?: (repoPath: string, path: string) => Promise<boolean>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
};

/**
 * The lesson checks of today over every proposed and approved lesson checked with an older LESSON_CHECKS_VERSION (or
 * never): the text checks, and the data checks only a stored lesson can have (its miss saying the session was the wrong
 * one, its paths against the mounted repository, a near-duplicate by stored embedding). Flags only: the lessons are
 * left as they are, so the owner sees what the checks say now. Each lesson is stamped with the version, so it runs once
 * per version (and again after requestLessonRecheck); Activity says how many were checked and which flags came and went.
 */
export async function recheckLessons(d: RecheckDeps): Promise<{ checked: number; flagged: number; changed: number }> {
  const todo = d.k.staleLessonChecks
    ? await d.k.staleLessonChecks(LESSON_CHECKS_VERSION, MAX_LESSONS)
    : (await d.k.listLessons({ limit: MAX_LESSONS })).filter((l) => (l.status === 'proposed' || l.status === 'approved') && (l.checksVersion ?? 0) < LESSON_CHECKS_VERSION);
  if (!todo.length) return { checked: 0, flagged: 0, changed: 0 };
  const repos = (await d.repoPaths?.().catch(() => null)) ?? new Map<string, string>();
  const exists = d.exists ?? repoHas;
  const counts: Record<string, number> = {};
  const added: Record<string, number> = {};
  const removed: Record<string, number> = {};
  let flagged = 0;
  let changed = 0;
  const changedIds: string[] = [];
  for (const l of todo) {
    const detail = await d.k.lessonDetail(l.id);
    const fresh = recheckLesson(l, detail?.feedback?.text ?? '');
    const usable = l.paths.filter((p) => !junkPathReason(p));
    const data: LessonCheck[] = [];
    if (!usable.length && l.scope !== 'global' && l.source === 'postmortem') {
      data.push({ name: 'needs-path', why: 'no file the evidence supports: as it is, it would apply anywhere in the project' });
    }
    const repo = repos.get(l.projectKey ?? l.origin ?? '');
    if (repo) {
      const missing: string[] = [];
      for (const p of usable) if (!GLOB.test(p) && !(await exists(repo, p))) missing.push(p);
      if (missing.length) data.push({ name: 'path-missing', why: `not in the repository: ${missing.join(', ')}` });
    }
    if ((l.from === 'github' || l.from === 'linear') && detail?.miss && saysWrongSession(detail.miss)) {
      data.push({ name: 'wrong-session', why: 'the post-mortem says the matched session did other work: what it took from that session is likely wrong' });
    }
    const dup = d.k.similarLessons ? duplicateFlag(l, await d.k.similarLessons(l.id, NEIGHBOURS)) : null;
    if (dup) data.push(dup);
    // bad-path first, as at proposal time, then the data checks, then the rest of the text checks.
    const computed = [...fresh.filter((f) => f.name === 'bad-path'), ...data, ...fresh.filter((f) => f.name !== 'bad-path')];
    const keep = (l.checks ?? []).filter(kept);
    const flags = [...keep, ...computed.filter((c) => !keep.some((k) => k.name === c.name))];
    await d.k.setLessonChecks(l.id, flags, LESSON_CHECKS_VERSION);
    const before = new Set((l.checks ?? []).map((c) => c.name));
    const after = new Set<LessonCheckName>(flags.map((c) => c.name));
    const plus = [...after].filter((n) => !before.has(n));
    const minus = [...before].filter((n) => !after.has(n));
    if (plus.length || minus.length) {
      changed++;
      changedIds.push(l.id);
    }
    for (const n of plus) added[n] = (added[n] ?? 0) + 1;
    for (const n of minus) removed[n] = (removed[n] ?? 0) + 1;
    if (flags.length) flagged++;
    for (const f of flags) counts[f.name] = (counts[f.name] ?? 0) + 1;
  }
  const checked = todo.length;
  d.log?.('lessons re-checked', { checked, flagged, changed, version: LESSON_CHECKS_VERSION, added, removed });
  await d.activity?.record({
    kind: 'lessons_checked', actor: 'lesson-check', projectKey: null,
    subject: `${checked} lesson${checked === 1 ? '' : 's'} re-checked (checks v${LESSON_CHECKS_VERSION}): ${flagged} flagged, ${changed} changed`,
    why: 'their checks were older than the current ones (or a re-check was asked for); the flags are shown on each lesson, nothing else was changed',
    details: { checked, flagged, changed, version: LESSON_CHECKS_VERSION, flags: counts, added, removed },
    // The lessons whose flags changed, so each one's history shows it (capped: a big backlog is one entry, not a list).
    targets: changedIds.slice(0, MAX_TARGETS),
  });
  return { checked, flagged, changed };
}
