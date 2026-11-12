import { describe, expect, test } from 'vitest';
import { lessonSnapshot, type Activity, type ActivitySinceQuery, type Decision, type LessonDetail, type LessonSignals, type SessionFile } from '@fb/core';
import { activity, fakeContext, observedAs } from '../testing/context.ts';
import { detail, lesson } from '../testing/lessons.ts';
import { score } from '../policy.ts';
import type { LoopTypeContext } from '../plugin.ts';
import { fixPaths, HISTORY_MAX, lessonsOf, narrowCandidate, narrowScope, NARROW_MIN_VERDICTS, touchedLessons, useHistory } from './narrow_scope.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const signals = (id: string, judged: number, o: Partial<LessonSignals> = {}): LessonSignals => ({
  lessonId: id, counts: { addressed: judged, notAddressed: 0, notApplicable: 0, cannotTell: 0 } as LessonSignals['counts'], lastServed: null, lastOwnerTouch: null, updatedAt: 't', ...o,
});
const check = (projectKey: string, ...ids: string[]) => activity('predone_check', { projectKey, details: { verdicts: ids.map((lessonId) => ({ lessonId, status: 'addressed' })) } });
const served = (projectKey: string, ...ids: string[]) => activity('context_served', { projectKey, details: { lessons: ids.map((id) => ({ id })) } });
const global = lesson('lesson:g', { projectKey: null, scope: 'global', status: 'approved', paths: ['src/a.ts'] });
const file = (path: string, o: Partial<SessionFile> = {}): SessionFile => ({ path, read: true, edited: true, firstEditAt: '2026-11-01T01:00:00.000Z', lastEditAt: '2026-11-01T01:00:00.000Z', ...o });

type World = {
  details?: LessonDetail[]; log?: Activity[]; entries?: Activity[]; signals?: Record<string, LessonSignals>; files?: SessionFile[];
  decisions?: Record<string, Pick<Decision, 'type' | 'status'>[]>; inScope?: (k: string | null) => boolean;
};
const pages: ActivitySinceQuery[] = [];
function world(w: World = {}): LoopTypeContext {
  const log = w.log ?? Array.from({ length: NARROW_MIN_VERDICTS }, () => check('demo', 'lesson:g'));
  const ds = w.details ?? [detail(global)];
  return fakeContext({
    now: NOW,
    entries: w.entries ?? [log.at(-1) ?? check('demo', 'lesson:g')],
    signals: w.signals ?? { 'lesson:g': signals('lesson:g', NARROW_MIN_VERDICTS) },
    inScope: w.inScope,
    store: {
      knowledge: { lessonDetail: async (id: string) => ds.find((d) => d.lesson.id === id) ?? null },
      decisions: { forTarget: async (id: string) => (w.decisions?.[id] ?? []) as Decision[] },
      codegraph: { sessionFiles: async () => w.files ?? [] },
      activity: {
        since: async (q: ActivitySinceQuery) => {
          pages.push(q);
          const at = q.after ? Number(q.after) : 0;
          return { entries: log.slice(at, at + q.limit), next: at + q.limit < log.length ? String(at + q.limit) : null };
        },
      },
    },
  });
}

describe('narrowScope: a global lesson used in one project', () => {
  test('every verdict and every serving from demo: narrowed to demo', async () => {
    const r = await narrowScope.candidates(world({ log: [...Array.from({ length: 5 }, () => check('demo', 'lesson:g')), served('demo', 'lesson:g')] }));
    expect(r.skipped).toEqual({});
    expect(r.scanned).toBe(1);
    const [c] = r.candidates;
    expect(c.projectKey).toBe('demo');
    expect(c.before).toEqual([lessonSnapshot(global)]);
    expect(c.after[0].fields).toMatchObject({ projectKey: 'demo', scope: 'project', paths: ['src/a.ts'], status: 'approved', decidedAt: null, decidedBy: null });
    expect(c.features).toEqual({ verdicts: 0.25, fixFiles: 0, fixCommits: 0, toProject: 1, addPaths: 0 });
    expect(c.evidence.map((e) => `${e.kind}:${e.id}:${e.role}`)).toEqual(['lesson:lesson:g:verdicts only from demo']);
    expect(c.rationale).toContain('All 5 verdicts on this lesson came from demo');
    expect(c.rationale).toContain('served only in demo instead of every project');
    expect(c.proposeOnly).toBeUndefined();
  });
  test('the history is read in pages through the whole log', async () => {
    pages.length = 0;
    const log = Array.from({ length: 1200 }, (_, i) => (i % 100 ? served('demo', 'lesson:other') : check('demo', 'lesson:g')));
    expect((await narrowScope.candidates(world({ log, entries: [check('demo', 'lesson:g')] }))).candidates).toHaveLength(1);
    expect(pages.map((p) => p.after)).toEqual([null, '500', '1000']);
    expect(pages[0]).toMatchObject({ kinds: ['predone_check', 'context_served'], limit: 500 });
  });
  test('a verdict from a second project, or served in one: below the floor', async () => {
    const five = Array.from({ length: 5 }, () => check('demo', 'lesson:g'));
    expect((await narrowScope.candidates(world({ log: [...five, check('other', 'lesson:g')] }))).skipped).toEqual({ below_floor: 1 });
    expect((await narrowScope.candidates(world({ log: [...five, served('other', 'lesson:g')] }))).skipped).toEqual({ below_floor: 1 });
    const linked = activity('context_served', { projectKey: 'other', details: { lessons: [], linked: [{ project: 'demo', lessons: ['lesson:g'] }] } });
    expect((await narrowScope.candidates(world({ log: [...five, linked] }))).skipped).toEqual({ below_floor: 1 });
  });
  test('fewer than NARROW_MIN_VERDICTS judged (by its signals, or in the log): below the floor', async () => {
    expect((await narrowScope.candidates(world({ signals: { 'lesson:g': signals('lesson:g', NARROW_MIN_VERDICTS - 1) } }))).skipped).toEqual({ below_floor: 1 });
    expect((await narrowScope.candidates(world({ signals: {} }))).skipped).toEqual({ below_floor: 1 });
    expect((await narrowScope.candidates(world({ log: [check('demo', 'lesson:g')] }))).skipped).toEqual({ below_floor: 1 });
    expect((await narrowScope.candidates(world({ log: [served('demo', 'lesson:g')], entries: [served('demo', 'lesson:g')] }))).skipped).toEqual({ below_floor: 1 });
  });
  test('a run\'s or a sandbox\'s entries, and entries with no project, do not count', async () => {
    const five = Array.from({ length: 5 }, () => check('demo', 'lesson:g'));
    const noise = [check('other', 'lesson:g'), check('other', 'lesson:g'), check('other', 'lesson:g')];
    noise[0].run = 'r1';
    noise[1].sandbox = true;
    noise[2].projectKey = null;
    expect((await narrowScope.candidates(world({ log: [...five, ...noise] }))).candidates).toHaveLength(1);
  });
  test('the project out of scope', async () => {
    expect((await narrowScope.candidates(world({ inScope: (k) => k !== 'demo' }))).skipped).toEqual({ out_of_scope: 1 });
  });
  test('a global lesson with no paths also gets the files that fixed its miss', async () => {
    const g = lesson('lesson:g', { projectKey: null, scope: 'global', status: 'approved', paths: [] });
    const r = await narrowScope.candidates(world({ details: [detail(g, { fixCommits: [{ sha: 'abc', ts: 't', subject: 'fix' }] })], files: [file('src/fix.ts')] }));
    expect(r.candidates[0].after[0].fields).toMatchObject({ projectKey: 'demo', scope: 'project', paths: ['src/fix.ts'] });
    expect(r.candidates[0].features).toMatchObject({ toProject: 1, addPaths: 1, fixFiles: 1 / 3, fixCommits: 0.5 });
  });
});

describe('narrowScope: a project lesson with no paths', () => {
  const bare = lesson('lesson:p', { paths: [], status: 'approved' });
  const run = (w: World) => narrowScope.candidates(world({ details: [detail(bare)], log: [check('demo', 'lesson:p')], entries: [served('demo', 'lesson:p')], signals: {}, ...w }));
  test('the session edited files after the feedback: they become its paths', async () => {
    const files = [file('src/fix.ts'), file('src/before.ts', { firstEditAt: '2026-10-31T00:00:00.000Z', lastEditAt: '2026-10-31T00:00:00.000Z' }), file('CLAUDE.md'), file('src/read.ts', { edited: false })];
    const [c] = (await run({ files })).candidates;
    expect(c.after[0].fields).toMatchObject({ projectKey: 'demo', scope: 'project', paths: ['src/fix.ts'] });
    expect(c.features).toEqual({ verdicts: 0.05, fixFiles: 1 / 3, fixCommits: 0, toProject: 0, addPaths: 1 });
    expect(c.evidence.map((e) => `${e.kind}:${e.id}:${e.role}`)).toEqual(['lesson:lesson:p:verdicts only from demo', 'session:s-p:fixed src/fix.ts']);
    expect(c.rationale).toContain('the session that fixed its miss edited src/fix.ts');
    expect(c.rationale).toContain('served only for edits of src/fix.ts');
  });
  test('many fix files: their common folder, and the rationale sums them up', async () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((n) => file(`src/m/${n}.ts`));
    const [c] = (await run({ files })).candidates;
    expect(c.after[0].fields.paths).toEqual(['src/m/**']);
    expect(c.rationale).toContain('src/m/a.ts, src/m/b.ts, src/m/c.ts and 2 more');
  });
  test('no verdicts at all is no other project: still narrowed', async () => {
    expect((await run({ files: [file('src/fix.ts')], log: [] })).candidates).toHaveLength(1);
  });
  test('no fix edits, only junk, or no feedback session: below the floor', async () => {
    expect((await run({ files: [] })).skipped).toEqual({ below_floor: 1 });
    expect((await run({ files: [file('CLAUDE.md')] })).skipped).toEqual({ below_floor: 1 });
    expect((await run({ details: [detail(bare, { feedback: null })] })).skipped).toEqual({ below_floor: 1 });
  });
  test('used in another project too: below the floor', async () => {
    expect((await run({ files: [file('src/fix.ts')], log: [check('other', 'lesson:p')] })).skipped).toEqual({ below_floor: 1 });
  });
  test('you touched it in 14 days: proposed only', async () => {
    const s = signals('lesson:p', 0, { lastOwnerTouch: '2026-11-10T00:00:00.000Z' });
    expect((await run({ files: [file('src/fix.ts')], signals: { 'lesson:p': s } })).candidates[0].proposeOnly).toBe('owner_touched');
  });
});

describe('narrowScope: not looked at, never, already decided', () => {
  test('a project lesson that has paths, a rejected or superseded lesson, one that is gone: not looked at', async () => {
    for (const l of [lesson('lesson:g'), lesson('lesson:g', { projectKey: null, scope: 'global', status: 'rejected' })]) {
      expect(await narrowScope.candidates(world({ details: [detail(l)] }))).toEqual({ candidates: [], scanned: 0, skipped: {} });
    }
    expect(await narrowScope.candidates(world({ details: [] }))).toEqual({ candidates: [], scanned: 0, skipped: {} });
  });
  test('a proposed global lesson is looked at too', async () => {
    expect((await narrowScope.candidates(world({ details: [detail({ ...global, status: 'proposed' })] }))).candidates).toHaveLength(1);
  });
  test('never: written by you, a run\'s, may hold a secret', async () => {
    for (const o of [{ source: 'manual' as const }, { run: 'r' }, { checks: [{ name: 'may-hold-secret' as const, why: 'x' }] }]) {
      expect((await narrowScope.candidates(world({ details: [detail({ ...global, ...o })] }))).skipped).toEqual({ never_target: 1 });
    }
  });
  test('a call of this type still standing: already decided', async () => {
    expect((await narrowScope.candidates(world({ decisions: { 'lesson:g': [{ type: 'narrow_scope', status: 'applied' }] } }))).skipped).toEqual({ already_decided: 1 });
  });
  test('a log too long to count: every plan skipped, logged, nothing proposed', async () => {
    const big = Array.from({ length: HISTORY_MAX + 1 }, () => check('demo', 'lesson:g'));
    const logs: unknown[] = [];
    const ctx = { ...world({ log: big }), log: (m: string) => logs.push(m) };
    expect(await narrowScope.candidates(ctx)).toEqual({ candidates: [], scanned: 1, skipped: { history_too_long: 1 } });
    expect(logs).toEqual(['narrow_scope: the Activity log is too long to count verdicts']);
  });
  test('recheck: an observed narrowing, its decision standing and nothing new naming it, is measured again; one gone no longer holds', async () => {
    const [c] = (await narrowScope.candidates(world())).candidates;
    const observed = [observedAs('narrow_scope', c), observedAs('narrow_scope', { ...c, targets: [{ kind: 'lesson', id: 'lesson:gone', role: 'primary' }] })];
    const r = await narrowScope.recheck!(world({ entries: [], decisions: { 'lesson:g': [{ type: 'narrow_scope', status: 'observed' }] } }), observed);
    expect(r[0]).toMatchObject({ targets: c.targets, before: c.before, after: c.after });
    expect(r[1]).toBe('no_longer_holds');
    const second = Array.from({ length: 5 }, () => check('other', 'lesson:g'));
    expect(await narrowScope.recheck!(world({ entries: [], log: [...second, check('demo', 'lesson:g')] }), observed.slice(0, 1))).toEqual(['no_longer_holds']);
  });
  test('nothing new: nothing read', async () => {
    pages.length = 0;
    expect(await narrowScope.candidates(world({ entries: [] }))).toEqual({ candidates: [], scanned: 0, skipped: {} });
    expect(pages).toEqual([]);
  });
});

describe('the parts', () => {
  test('lessonsOf: verdict and served ids in either shape; other kinds and odd details give none', () => {
    expect(lessonsOf(check('demo', 'lesson:a'))).toEqual({ judged: ['lesson:a'], served: [] });
    expect(lessonsOf(activity('context_served', { details: { lessons: ['lesson:a', { id: 'lesson:b' }, 3, null] } }))).toEqual({ judged: [], served: ['lesson:a', 'lesson:b'] });
    expect(lessonsOf(activity('context_served', { details: { lessons: 'x', linked: [null, { lessons: ['lesson:c'] }] } }))).toEqual({ judged: [], served: ['lesson:c'] });
    expect(lessonsOf(activity('predone_check', { details: { verdicts: [{ lessonId: 7 }] } }))).toEqual({ judged: [], served: [] });
    expect(lessonsOf(activity('lesson_decided', { targets: ['lesson:a'] }))).toEqual({ judged: [], served: [] });
  });
  test('touchedLessons: targets, verdicts and serving, once each, sorted', () => {
    const ctx = fakeContext({ entries: [activity('lesson_decided', { targets: ['lesson:z'] }), check('demo', 'lesson:a'), served('demo', 'lesson:a', 'lesson:b')] });
    expect(touchedLessons(ctx)).toEqual(['lesson:a', 'lesson:b', 'lesson:z']);
  });
  test('useHistory: counts per project', async () => {
    const h = await useHistory(world({ log: [check('demo', 'lesson:g'), check('demo', 'lesson:g'), check('x', 'lesson:g'), served('y', 'lesson:g')] }), new Set(['lesson:g']));
    expect([...h!.get('lesson:g')!.verdicts]).toEqual([['demo', 2], ['x', 1]]);
    expect([...h!.get('lesson:g')!.served]).toEqual(['y']);
  });
  test('fixPaths: none without a feedback session', async () => {
    expect(await fixPaths(world(), detail(global, { feedback: null }))).toEqual({ paths: [], files: [] });
  });
  test('narrowCandidate: a lesson narrowed both ways scores higher than one way', () => {
    const d = detail(lesson('lesson:g', { projectKey: null, scope: 'global', paths: [] }));
    const one = narrowCandidate(d, { toProject: 'demo', paths: [], files: [], verdicts: 5 });
    const both = narrowCandidate(d, { toProject: 'demo', paths: ['src/a.ts'], files: ['src/a.ts'], verdicts: 20 });
    expect(score(narrowScope, both.features)).toBeGreaterThan(score(narrowScope, one.features));
    expect(one.rationale).toContain('All 5 verdicts');
    expect(narrowCandidate(d, { toProject: 'demo', paths: [], files: [], verdicts: 1 }).rationale).toContain('All 1 verdict on');
    expect(narrowCandidate(d, { toProject: null, paths: ['a/1.ts', 'a/2.ts', 'a/3.ts', 'a/4.ts'], files: [], verdicts: 1 }).rationale).toContain('edits of a/1.ts, a/2.ts, a/3.ts and 1 more');
  });
});
