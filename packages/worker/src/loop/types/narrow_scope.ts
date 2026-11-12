import { lessonSnapshot, suggestLessonPaths, touchedAround, type Activity, type Decision, type EvidenceRef, type Lesson, type LessonDetail, type LessonSignals } from '@fb/core';
import { junkPathReason } from '../../postmortem/paths.ts';
import { holdsStill, primaryOf, SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { decidedAlready } from './approve_lesson.ts';
import { lessonNeverTarget, ownerTouchedRecently } from './guards.ts';

/** A global lesson needs at least this many judged verdicts, all from one project, to be narrowed to it. */
export const NARROW_MIN_VERDICTS = 5;
/** Activity entries read per page, and at most, when a lesson's verdict history is counted. */
const HISTORY_PAGE = 500;
export const HISTORY_MAX = 50_000;
export const NARROW_SKIP = { historyTooLong: 'history_too_long' } as const;

/** Where a lesson was judged and served: project -> verdicts; and the projects it was served in. */
export type UseHistory = { verdicts: Map<string, number>; served: Set<string> };

const judged = (s: LessonSignals | null) => (s ? s.counts.addressed + s.counts.notAddressed + s.counts.notApplicable + s.counts.cannotTell : 0);
const idOf = (x: unknown) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' ? (x as { id: string }).id : null);

/** The lessons an entry judged (predone_check verdicts) and served (context_served, linked projects' too). */
export function lessonsOf(e: Activity): { judged: string[]; served: string[] } {
  const d = e.details as { verdicts?: unknown; lessons?: unknown; linked?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' && 'lessonId' in x ? (x as { lessonId: unknown }).lessonId : idOf(x))).filter((x): x is string => typeof x === 'string') : []);
  if (e.kind === 'predone_check') return { judged: list(d.verdicts), served: [] };
  if (e.kind === 'context_served') return { judged: [], served: [...list(d.lessons), ...(Array.isArray(d.linked) ? d.linked.flatMap((x) => list((x as { lessons?: unknown })?.lessons)) : [])] };
  return { judged: [], served: [] };
}

/**
 * Every project these lessons were judged and served in, from the whole Activity log (runs' and sandboxes' entries
 * left out: a tester's use is not the owner's). Null when the log is longer than HISTORY_MAX entries of these kinds.
 */
export async function useHistory(ctx: LoopTypeContext, ids: Set<string>): Promise<Map<string, UseHistory> | null> {
  const out = new Map([...ids].map((id) => [id, { verdicts: new Map<string, number>(), served: new Set<string>() }]));
  let after: string | null = null;
  let read = 0;
  do {
    const page = await ctx.store.activity.since({ after, kinds: ['predone_check', 'context_served'], limit: HISTORY_PAGE });
    for (const e of page.entries) {
      if (e.run || e.sandbox || !e.projectKey) continue;
      const u = lessonsOf(e);
      for (const id of u.judged) { const h = out.get(id); if (h) h.verdicts.set(e.projectKey, (h.verdicts.get(e.projectKey) ?? 0) + 1); }
      for (const id of u.served) out.get(id)?.served.add(e.projectKey);
    }
    read += page.entries.length;
    if (read > HISTORY_MAX) return null;
    after = page.next;
  } while (after);
  return out;
}

/** The lessons this round's entries name: as a target, or judged or served in them. */
export function touchedLessons(ctx: LoopTypeContext): string[] {
  const ids = ctx.entries.flatMap((e) => [...e.targets.filter((t) => t.startsWith('lesson:')), ...lessonsOf(e).judged, ...lessonsOf(e).served]);
  return [...new Set(ids)].sort();
}

/** The paths the files edited to fix the lesson's miss give (postmortem/paths.ts' rule): repository paths only. */
export async function fixPaths(ctx: LoopTypeContext, d: LessonDetail): Promise<{ paths: string[]; files: string[] }> {
  if (!d.feedback?.sessionId) return { paths: [], files: [] };
  const files = touchedAround(await ctx.store.codegraph.sessionFiles(d.feedback.sessionId), d.feedback.ts).fixed.filter((f) => !junkPathReason(f));
  return { paths: files.length ? suggestLessonPaths([], { edited: [], fixed: files }) : [], files };
}

type Plan = { d: LessonDetail; global: boolean; paths: string[]; files: string[] };

/**
 * narrow_scope (tier A): a lesson reaches fewer agents. A global lesson becomes its project's, and a lesson with no
 * paths gets the files edited to fix its miss (the post-mortem's own path rule). Floors: those fix files are known
 * (for paths); every verdict on the lesson, from the whole Activity log, comes from one project, at least
 * NARROW_MIN_VERDICTS of them for a global lesson, and it was served in no other project (narrowing would take it from
 * agents there). Never targeted: what lessonNeverTarget names. You touched it in 14 days: proposed at most.
 */
export const narrowScope: LoopType = {
  type: 'narrow_scope',
  weights: { bias: -1.5, verdicts: 1.5, fixFiles: 1, fixCommits: 0.5, toProject: 0.5, addPaths: 0.5 },
  groups: { evidence: ['verdicts', 'fixFiles', 'fixCommits'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const found = await narrowings(ctx, touchedLessons(ctx), false);
    for (const r of found.values()) {
      if (r === null) continue;
      if (typeof r === 'string') skip(skipped, r);
      else candidates.push(r);
    }
    return { candidates, scanned: [...found.values()].filter((r) => r !== null).length, skipped };
  },

  /** Found only from the lessons a round's entries name: an observed narrowing is measured again as the lesson is now. */
  async recheck(ctx: LoopTypeContext, observed: readonly Decision[]): Promise<(LoopCandidate | string)[]> {
    const found = await narrowings(ctx, observed.map(primaryOf), true);
    return observed.map((d) => holdsStill(found.get(primaryOf(d)) ?? null));
  },
};

/**
 * For each lesson id: its call, why there is none, or null when it is not one to narrow (not counted as scanned).
 * again: a recheck of the type's own observed calls, so a decision already on the lesson is not a reason.
 */
async function narrowings(ctx: LoopTypeContext, ids: string[], again: boolean): Promise<Map<string, LoopCandidate | string | null>> {
  const out = new Map<string, LoopCandidate | string | null>();
  const plans: Plan[] = [];
  for (const id of ids) {
    const d = await ctx.store.knowledge.lessonDetail(id);
    const l = d?.lesson;
    const global = l ? l.projectKey === null || l.scope === 'global' : false;
    if (!d || !l || (l.status !== 'approved' && l.status !== 'proposed') || (!global && l.paths.length)) { out.set(id, null); continue; }
    if (lessonNeverTarget(l)) { out.set(id, SKIP.neverTarget); continue; }
    if (!again && await decidedAlready(ctx, 'narrow_scope', id)) { out.set(id, SKIP.alreadyDecided); continue; }
    const fix = l.paths.length ? { paths: [], files: [] } : await fixPaths(ctx, d);
    if (global && judged(await ctx.signals(id)) < NARROW_MIN_VERDICTS) { out.set(id, SKIP.belowFloor); continue; }
    if (!global && !fix.paths.length) { out.set(id, SKIP.belowFloor); continue; }
    plans.push({ d, global, paths: fix.paths, files: fix.files });
  }
  if (!plans.length) return out;

  const history = await useHistory(ctx, new Set(plans.map((p) => p.d.lesson.id)));
  if (!history) {
    ctx.log('narrow_scope: the Activity log is too long to count verdicts', { max: HISTORY_MAX });
    for (const p of plans) out.set(p.d.lesson.id, NARROW_SKIP.historyTooLong);
    return out;
  }
  for (const p of plans) {
    const l = p.d.lesson;
    const h = history.get(l.id)!;
    const projects = [...new Set([...h.verdicts.keys(), ...h.served])];
    const total = [...h.verdicts.values()].reduce((a, b) => a + b, 0);
    // A global lesson is narrowed to the one project it was used in; a project's lesson must be used in it alone.
    const home = p.global ? projects[0] : l.projectKey!;
    if (projects.length > 1 || (p.global ? !home || total < NARROW_MIN_VERDICTS : projects.some((k) => k !== home))) { out.set(l.id, SKIP.belowFloor); continue; }
    if (!ctx.inScope(home)) { out.set(l.id, SKIP.outOfScope); continue; }
    const touched = ownerTouchedRecently(await ctx.signals(l.id), ctx.now);
    out.set(l.id, narrowCandidate(p.d, { toProject: p.global ? home : null, paths: p.paths, files: p.files, verdicts: total, proposeOnly: touched ? SKIP.ownerTouched : undefined }));
  }
  return out;
}

type NarrowInput = { toProject: string | null; paths: string[]; files: string[]; verdicts: number; proposeOnly?: string };

/** The call: `toProject` set moves a global lesson to that project; `paths` set gives a pathless lesson those paths. */
export function narrowCandidate(d: LessonDetail, o: NarrowInput): LoopCandidate {
  const l = d.lesson;
  const after: Lesson = { ...l, ...(o.toProject && { projectKey: o.toProject, scope: 'project' as const }), ...(o.paths.length && { paths: o.paths }) };
  const project = after.projectKey!;
  const changes = [
    ...(o.toProject ? [`served only in ${o.toProject} instead of every project`] : []),
    ...(o.paths.length ? [`served only for edits of ${o.paths.slice(0, 3).join(', ')}${o.paths.length > 3 ? ` and ${o.paths.length - 3} more` : ''}`] : []),
  ];
  const evidence: EvidenceRef[] = [
    { kind: 'lesson', id: l.id, role: `verdicts only from ${project}`, weight: 1, observedAt: l.createdAt },
    ...o.files.map((f) => ({ kind: 'session' as const, id: d.feedback!.sessionId, role: `fixed ${f}`, weight: 1 / o.files.length, observedAt: d.feedback!.ts })),
  ];
  return {
    projectKey: project,
    targets: [{ kind: 'lesson', id: l.id, role: 'primary' }],
    before: [lessonSnapshot(l)],
    after: [lessonSnapshot(after)],
    evidence,
    features: {
      verdicts: Math.min(o.verdicts, 20) / 20,
      fixFiles: Math.min(o.files.length, 3) / 3,
      fixCommits: Math.min(d.fixCommits.length, 2) / 2,
      toProject: o.toProject ? 1 : 0,
      addPaths: o.paths.length ? 1 : 0,
    },
    subject: `narrow "${l.title.slice(0, 80)}"`,
    rationale: `All ${o.verdicts} verdict${o.verdicts === 1 ? '' : 's'} on this lesson came from ${project}, and it was served nowhere else${o.files.length ? `; the session that fixed its miss edited ${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? ` and ${o.files.length - 3} more` : ''}` : ''}. It is now ${changes.join(' and ')}: fewer agents are told it, none newly.`,
    ...(o.proposeOnly && { proposeOnly: o.proposeOnly }),
  };
}
