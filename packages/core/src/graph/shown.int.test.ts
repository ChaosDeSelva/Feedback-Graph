import { beforeAll, beforeEach, expect, test } from 'vitest';
import type { ActivityStore, GraphStore, InsightsStore, KnowledgeStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { Classification, ParsedSession, PostMortem, Project } from '../types.ts';

/**
 * `projectKeys`: what the app shows outside Settings is limited to the selected projects (and their clone folders).
 * Every list that spans projects takes the key list, so a limit is applied after the filter, not before it.
 */
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
const vec = (axis: number, noise = 0) => {
  const v = Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : noise));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

function session(id: string, day: number): ParsedSession {
  const ts = (i: number) => `2026-10-${String(day).padStart(2, '0')}T10:0${i}:00Z`;
  const turns = [0, 1, 2].map((i) => ({ uuid: `${id}-t${i}`, sessionId: id, ts: ts(i), index: i, text: `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [] }));
  return { sessionId: id, sourceFile: 'f', cwd: '/vibe/x', gitBranch: 'main', startedAt: ts(0), endedAt: ts(2), turns, toolCalls: [] };
}

const pm = (missed: string, cause: PostMortem['cause'], scope: 'project' | 'global'): PostMortem => ({
  taskTitle: `task for ${missed}`, missed, cause, causeExplanation: 'why', outcome: 'approved',
  lesson: { title: `lesson: ${missed}`, rule: 'rule', appliesWhen: 'when', scope, paths: [] },
  contextItems: [],
});

describeStores('project scoping (projectKeys)', (h) => {
  let repo: GraphStore;
  let k: KnowledgeStore;
  let ins: InsightsStore;
  let act: ActivityStore;
  const shop: Project = { key: 'shop', name: 'shop', repoPath: '/vibe/shop' };
  const old: Project = { key: 'old', name: 'old', repoPath: '/vibe/old' };

  async function miss(project: Project, sessionId: string, day: number, cause: PostMortem['cause'], scope: 'project' | 'global', axis: number) {
    await repo.upsertSession(project, session(sessionId, day), []);
    await repo.saveClassification(`${sessionId}-t1`, pushback, true);
    await repo.decide(`${sessionId}-t1`, 'confirmed', null);
    await k.savePostmortem(`${sessionId}-t1`, pm(`missed in ${project.key}`, cause, scope), { miss: vec(axis, 0.01), lesson: vec(axis) });
    await k.updateLesson(`lesson:${sessionId}-t1`, { status: 'approved' }, {});
  }

  beforeAll(() => {
    repo = h.store.graph;
    k = h.store.knowledge;
    ins = h.store.insights;
    act = h.store.activity;
  });
  beforeEach(async () => {
    await miss(shop, 's1', 1, 'verification_gap', 'project', 1);
    // A global lesson learned in a project that is not selected: it is that project's data.
    await miss(old, 's2', 2, 'requirement_unstated', 'global', 1);
    await repo.upsertSession(old, session('s3', 3), []);
    await repo.saveClassification('s3-t1', pushback, true);
    // No project at all (an imported memory file with no origin): shown everywhere.
    await k.upsertLesson({ id: 'memory:any', projectKey: null, title: 'any', rule: 'r', appliesWhen: 'w', scope: 'global', paths: [], status: 'approved', source: 'memory', embedding: vec(1, 0.02) });
  });

  test('listCandidates: only the given projects, and the limit counts what is shown', async () => {
    expect((await repo.listCandidates({})).map((c) => c.projectKey).sort()).toEqual(['old', 'old', 'shop']);
    expect((await repo.listCandidates({ projectKeys: ['shop'] })).map((c) => c.id)).toEqual(['s1-t1']);
    expect((await repo.listCandidates({ projectKeys: ['shop'], limit: 1 })).map((c) => c.id)).toEqual(['s1-t1']);
    expect(await repo.listCandidates({ projectKeys: [] })).toEqual([]);
    expect(await repo.listCandidates({ projectKeys: ['shop'], projectKey: 'old' })).toEqual([]);
  });

  test('listCandidates pages with offset: the pages, in order, are the whole list once', async () => {
    const all = (await repo.listCandidates({})).map((c) => c.id);
    const pages = [0, 1, 2, 3].map((offset) => repo.listCandidates({ limit: 1, offset }).then((r) => r.map((c) => c.id)));
    expect((await Promise.all(pages)).flat()).toEqual(all);
    expect(await repo.listCandidates({ limit: 2, offset: 3 })).toEqual([]);
  });

  test('lessons carry the project they were learned in; a global one keeps it as its origin', async () => {
    expect((await k.lessonDetail('lesson:s2-t1'))!.lesson).toMatchObject({ projectKey: null, origin: 'old' });
    expect((await k.lessonDetail('lesson:s1-t1'))!.lesson).toMatchObject({ projectKey: 'shop', origin: 'shop' });
    expect((await k.lessonDetail('memory:any'))!.lesson).toMatchObject({ projectKey: null, origin: null });
  });

  test('listLessons: lessons of other projects, global ones learned there included, are left out', async () => {
    expect((await k.listLessons({})).map((l) => l.id).sort()).toEqual(['lesson:s1-t1', 'lesson:s2-t1', 'memory:any']);
    expect((await k.listLessons({ projectKeys: ['shop'] })).map((l) => l.id).sort()).toEqual(['lesson:s1-t1', 'memory:any']);
    expect((await k.listLessons({ projectKeys: [] })).map((l) => l.id)).toEqual(['memory:any']);
    expect((await k.listLessons({ projectKey: 'shop', projectKeys: ['shop'], status: 'approved' })).map((l) => l.id).sort()).toEqual(['lesson:s1-t1', 'memory:any']);
  });

  test('searchLessons: a global lesson learned in a project that is not shown is not served', async () => {
    const all = (await k.searchLessons({ embedding: vec(1), projectKey: 'shop', k: 5 })).map((x) => x.lesson.id).sort();
    expect(all).toEqual(['lesson:s1-t1', 'lesson:s2-t1', 'memory:any']);
    const shown = (await k.searchLessons({ embedding: vec(1), projectKey: 'shop', k: 2, projectKeys: ['shop'] })).map((x) => x.lesson.id).sort();
    expect(shown).toEqual(['lesson:s1-t1', 'memory:any']);
    expect((await k.searchLessons({ embedding: vec(1), projectKey: null, k: 5, projectKeys: [] })).map((x) => x.lesson.id)).toEqual(['memory:any']);
  });

  test('activity: entries of other projects are left out; entries with no project stay', async () => {
    await act.record({ kind: 'doc_added', actor: 'you', projectKey: 'shop', subject: 'shop doc', why: 'w' });
    await act.record({ kind: 'doc_added', actor: 'you', projectKey: 'old', subject: 'old doc', why: 'w' });
    await act.record({ kind: 'projects_selected', actor: 'you', projectKey: null, subject: 'selection', why: 'w' });
    const subjects = async (q: Parameters<ActivityStore['list']>[0]) => (await act.list(q)).map((x) => x.subject);
    expect(await subjects({ kind: 'doc_added' })).toEqual(['old doc', 'shop doc']);
    expect(await subjects({ projectKeys: ['shop'], limit: 2 })).toEqual(['selection', 'shop doc']);
    expect(await subjects({ projectKeys: [], kind: 'doc_added' })).toEqual([]);
    expect(await subjects({ projectKeys: [], kind: 'projects_selected' })).toEqual(['selection']);
  });

  test('patterns: only the given projects', async () => {
    expect((await ins.patterns({})).causes.map((c) => c.cause).sort()).toEqual(['requirement_unstated', 'verification_gap']);
    const r = await ins.patterns({ projectKeys: ['shop'] });
    expect(r.causes).toEqual([{ cause: 'verification_gap', count: 1 }]);
    expect((await ins.patterns({ projectKeys: [] })).causes).toEqual([]);
  });
});
