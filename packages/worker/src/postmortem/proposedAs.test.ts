import { lessonQuality, type Activity, type ActivityInput, type Lesson, type LessonDraft } from '@fb/core';
import { expect, test } from 'vitest';
import { backfillProposedAs, PROPOSED_AS_CURSOR, writerDraftFromActivity } from './proposedAs.ts';

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'shop', title: 'Server-side search', rule: 'Filter rows in the SQL of api/search.ts', appliesWhen: 'changing customer search', scope: 'project',
  paths: ['api/search.ts'], status: 'approved', source: 'postmortem', cause: 'context_missing', missId: null, createdAt: '2026-10-20T00:00:00Z',
  decidedAt: '2026-10-24T00:00:00Z', decidedBy: 'you', checks: [], checksVersion: 5, ...over,
});

let seq = 0;
/** A lesson_decided row as app.ts records it: the status after the patch and each changed field's from/to. */
const decided = (id: string, status: string, changed: Record<string, { from: unknown; to: unknown }>, extra: object = {}): Activity => ({
  id: `a${++seq}`, ts: `2026-10-2${Math.min(seq, 9)}T00:00:00Z`, kind: 'lesson_decided', actor: 'you', projectKey: 'shop',
  subject: `${status} lesson`, why: 'w', details: { status, changed, supersedes: null, ...extra }, targets: [id],
});

test("the writer's draft is the first from of each field edited while proposed; edits after the decision are not the writer's", () => {
  const l = lesson('lesson:a', { title: 'Search on the server', rule: 'Filter rows in the SQL of api/search.ts, never in memory' });
  // Oldest first: an edit while proposed, an edit and the approval in one, then an edit of the approved lesson.
  const rows = [
    decided('lesson:a', 'proposed', { rule: { from: 'Filter on the server', to: 'Filter rows in the SQL of api/search.ts' }, paths: { from: ['api/**'], to: ['api/search.ts'] } }),
    decided('lesson:a', 'approved', { rule: { from: 'Filter rows in the SQL of api/search.ts', to: 'x' }, title: { from: 'Server search', to: 'Server-side search' } }),
    decided('lesson:a', 'approved', { title: { from: 'Server-side search', to: 'Search on the server' } }),
  ];
  const writer: LessonDraft = { title: 'Server search', rule: 'Filter on the server', appliesWhen: 'changing customer search', scope: 'project', paths: ['api/**'] };
  // As the store lists them: newest first.
  expect(writerDraftFromActivity(l, [...rows].reverse())).toEqual(writer);
});

test('nothing to take: a decision with no edit (one at a time or in bulk), an edit that changed nothing kept, other kinds of row', () => {
  const l = lesson('lesson:b');
  expect(writerDraftFromActivity(l, [decided('lesson:b', 'approved', {}, { bulk: true })])).toBeNull();
  expect(writerDraftFromActivity(l, [decided('lesson:b', 'approved', { projectKey: { from: null, to: 'shop' } })])).toBeNull();
  expect(writerDraftFromActivity(l, [decided('lesson:b', 'approved', { rule: { from: l.rule, to: l.rule } })])).toBeNull();
  expect(writerDraftFromActivity(l, [{ ...decided('lesson:b', 'approved', { rule: { from: 'Old', to: l.rule } }), kind: 'lessons_checked' }])).toBeNull();
  // A from of the wrong shape is not a draft.
  expect(writerDraftFromActivity(l, [decided('lesson:b', 'proposed', { paths: { from: 'api', to: ['api/search.ts'] }, scope: { from: 'everywhere', to: 'project' } })])).toBeNull();
});

function world(lessons: Lesson[], rows: Activity[], cursor: string | null = null) {
  const kept = new Map<string, LessonDraft>();
  const recorded: ActivityInput[] = [];
  const cursors = new Map<string, string>(cursor ? [[PROPOSED_AS_CURSOR, cursor]] : []);
  const listed: object[] = [];
  return {
    kept, recorded, cursors, listed,
    deps: {
      knowledge: {
        listLessons: async () => lessons,
        backfillProposedAs: async (id: string, d: LessonDraft) => {
          const l = lessons.find((x) => x.id === id);
          if (!l || l.proposedAs || kept.has(id)) return false;
          kept.set(id, d);
          l.proposedAs = d;
          return true;
        },
      },
      activity: {
        list: async (q: { kind?: string; target?: string; limit?: number }) => {
          listed.push(q);
          return rows.filter((r) => r.kind === q.kind && r.targets.includes(q.target!)).reverse().slice(0, q.limit);
        },
        record: async (a: ActivityInput) => void recorded.push(a),
      },
      cursors: { getCursor: async (k: string) => cursors.get(k) ?? null, setCursor: async (k: string, v: string) => void cursors.set(k, v) },
    },
  };
}

test('at start, once: lessons edited before the draft was kept get it from Activity, both counts move, and it is logged with counts', async () => {
  const lessons = [
    lesson('lesson:edited'),
    lesson('lesson:plain'),
    lesson('lesson:rejected', { status: 'rejected' }),
    lesson('lesson:kept', { proposedAs: { title: 'T', rule: 'r', appliesWhen: 'w', scope: 'project', paths: [] } }),
    lesson('memory:m', { source: 'memory' }),
  ];
  const rows = [
    decided('lesson:edited', 'approved', { rule: { from: 'Filter on the server', to: 'Filter rows in the SQL of api/search.ts' } }),
    decided('lesson:plain', 'approved', {}),
    decided('lesson:rejected', 'proposed', { appliesWhen: { from: 'task', to: 'changing customer search' } }),
    decided('lesson:rejected', 'rejected', {}),
    decided('lesson:kept', 'approved', { rule: { from: 'Other', to: 'r' } }),
    decided('memory:m', 'approved', { rule: { from: 'Other', to: 'r' } }),
  ];
  const w = world(lessons, rows);
  const before = lessonQuality(lessons, 90, new Date('2026-10-26T00:00:00Z'));
  expect(before).toMatchObject({ asWritten: 2, edited: 1, rejected: 1 });
  const r = await backfillProposedAs(w.deps);
  expect(r).toEqual({ examined: 3, filled: 2, approved: 1, rejected: 1, proposed: 0 });
  expect([...w.kept.keys()]).toEqual(['lesson:edited', 'lesson:rejected']);
  expect(w.kept.get('lesson:edited')?.rule).toBe('Filter on the server');
  expect(lessonQuality(lessons, 90, new Date('2026-10-26T00:00:00Z'))).toMatchObject({ asWritten: 1, edited: 2, rejected: 1 });
  expect(w.recorded).toEqual([expect.objectContaining({
    kind: 'lessons_checked', actor: 'lesson-backfill',
    subject: "2 lessons got the writer's draft back from Activity: 1 approved now counts as after an edit, 1 rejected",
    details: { version: 1, examined: 3, filled: 2, approved: 1, rejected: 1, proposed: 0 },
    targets: ['lesson:edited', 'lesson:rejected'],
  })]);
  expect(w.cursors.get(PROPOSED_AS_CURSOR)).toBe('v1');
  // The second start does nothing.
  expect(await backfillProposedAs(w.deps)).toBeNull();
});

test('nothing to backfill still stamps the version, with no Activity entry; a store that cannot keep a draft is skipped', async () => {
  const w = world([lesson('lesson:plain')], [decided('lesson:plain', 'approved', {})]);
  expect(await backfillProposedAs(w.deps)).toEqual({ examined: 1, filled: 0, approved: 0, rejected: 0, proposed: 0 });
  expect(w.recorded).toEqual([]);
  expect(w.cursors.get(PROPOSED_AS_CURSOR)).toBe('v1');
  const none = world([lesson('lesson:plain')], []);
  expect(await backfillProposedAs({ ...none.deps, knowledge: { listLessons: none.deps.knowledge.listLessons } })).toBeNull();
  expect(none.cursors.size).toBe(0);
});
