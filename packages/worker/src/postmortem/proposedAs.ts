import { draftOf, sameDraft, type Activity, type ActivityStore, type DocsStore, type KnowledgeStore, type Lesson, type LessonDraft } from '@fb/core';

/**
 * The writer's draft of lessons edited before 0.6.2 kept it (Lesson.proposedAs). Without it an approved lesson the owner
 * rewrote counts as approved as written, and the post-mortem is shown it as one. The Activity log has had every edit's
 * before and after since 0.6.1 (lesson_decided, details.changed.<field>.from), so at worker start, once per version, a
 * post-mortem lesson with no draft kept gets the one its edits started from. Logged in Activity with counts.
 */
export const PROPOSED_AS_BACKFILL_VERSION = 1;
export const PROPOSED_AS_CURSOR = 'lesson-proposed-as';
const MAX_LESSONS = 10_000;
/** Decisions and edits of one lesson: more than any lesson gets. */
const MAX_ROWS = 200;
const MAX_TARGETS = 200;

const SCOPES = new Set(['global', 'project', 'task']);
/** A `from` of the right shape for the field, or undefined. */
function fieldFrom(k: keyof LessonDraft, v: unknown): LessonDraft[keyof LessonDraft] | undefined {
  if (k === 'paths') return Array.isArray(v) && v.every((p) => typeof p === 'string') ? (v as string[]) : undefined;
  if (k === 'scope') return typeof v === 'string' && SCOPES.has(v) ? (v as LessonDraft['scope']) : undefined;
  return typeof v === 'string' ? v : undefined;
}

const FIELDS = ['title', 'rule', 'appliesWhen', 'scope', 'paths'] as const;

/**
 * What the writer proposed, from this lesson's lesson_decided rows (any order; the store lists newest first): for
 * each field, the `from` of the first edit that changed it, up to and including the row that decided it (status no
 * longer proposed: an edit made with the decision is the owner's change to the writer's lesson, one after it is not).
 * Fields never edited are as they are now. Null: no edit changed anything the writer controls.
 */
export function writerDraftFromActivity(current: Lesson, rows: Activity[]): LessonDraft | null {
  const found: Partial<Record<keyof LessonDraft, unknown>> = {};
  for (const r of [...rows].filter((r) => r.kind === 'lesson_decided').reverse()) {
    const changed = (r.details?.changed ?? {}) as Record<string, { from?: unknown } | undefined>;
    for (const k of FIELDS) {
      if (k in found || !changed[k] || !('from' in changed[k]!)) continue;
      const v = fieldFrom(k, changed[k]!.from);
      if (v !== undefined) found[k] = v;
    }
    if (r.details?.status !== 'proposed') break;
  }
  if (!Object.keys(found).length) return null;
  const draft = { ...draftOf(current), ...found } as LessonDraft;
  return sameDraft(draft, current) ? null : draft;
}

export type ProposedAsDeps = {
  knowledge: Pick<KnowledgeStore, 'listLessons'> & Partial<Pick<KnowledgeStore, 'backfillProposedAs'>>;
  activity: Pick<ActivityStore, 'list' | 'record'>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  log?: (msg: string, extra?: object) => void;
};

export type ProposedAsResult = { examined: number; filled: number; approved: number; rejected: number; proposed: number };

/** At worker start. Null: done for this version already, or the store cannot keep a draft. A failure leaves the version. */
export async function backfillProposedAs(d: ProposedAsDeps): Promise<ProposedAsResult | null> {
  const stamp = `v${PROPOSED_AS_BACKFILL_VERSION}`;
  if (!d.knowledge.backfillProposedAs) return null;
  if ((await d.cursors.getCursor(PROPOSED_AS_CURSOR)) === stamp) return null;
  const todo = (await d.knowledge.listLessons({ limit: MAX_LESSONS })).filter((l) => l.source === 'postmortem' && !l.proposedAs && ['approved', 'rejected', 'proposed'].includes(l.status));
  const r: ProposedAsResult = { examined: todo.length, filled: 0, approved: 0, rejected: 0, proposed: 0 };
  const ids: string[] = [];
  for (const l of todo) {
    const draft = writerDraftFromActivity(l, await d.activity.list({ kind: 'lesson_decided', target: l.id, limit: MAX_ROWS }));
    if (!draft || !(await d.knowledge.backfillProposedAs(l.id, draft))) continue;
    r.filled++;
    r[l.status as 'approved' | 'rejected' | 'proposed']++;
    ids.push(l.id);
  }
  if (r.filled) {
    const parts = [
      r.approved && `${r.approved} approved now count${r.approved === 1 ? 's' : ''} as after an edit`,
      r.rejected && `${r.rejected} rejected`,
      r.proposed && `${r.proposed} still proposed`,
    ].filter(Boolean);
    await d.activity.record({
      kind: 'lessons_checked', actor: 'lesson-backfill', projectKey: null,
      subject: `${r.filled} lesson${r.filled === 1 ? '' : 's'} got the writer's draft back from Activity: ${parts.join(', ')}`,
      why: "they were edited before the writer's draft was kept (0.6.2), so a rewritten lesson counted as approved as written; each edit's before is in Activity",
      details: { version: PROPOSED_AS_BACKFILL_VERSION, ...r },
      targets: ids.slice(0, MAX_TARGETS),
    });
    d.log?.("writer's drafts backfilled from Activity", { ...r });
  }
  await d.cursors.setCursor(PROPOSED_AS_CURSOR, stamp);
  return r;
}
