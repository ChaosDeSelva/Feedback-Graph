import { beforeAll, beforeEach, expect, test } from 'vitest';
import type { GraphStore, KnowledgeStore, PortabilityStore, Store } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import type { Classification, FactKind, ParsedSession, PostMortem, Project } from '../types.ts';
import { EXPORT_FORMAT } from './portability.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };

function session(id: string): ParsedSession {
  const turns = [0, 1, 2].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: `2026-10-01T10:0${i}:00Z`, index: i, text: `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd: '/x', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: [] };
}

const pm: PostMortem = {
  taskTitle: 'Orders list', missed: 'no tenant scoping', cause: 'context_available_ignored', causeExplanation: 'CLAUDE.md said so', outcome: 'approved',
  lesson: { title: 'Scope by org', rule: 'Filter every list by orgId', appliesWhen: 'list endpoints', scope: 'project', paths: [] },
  contextItems: [{ kind: 'claude_md', ref: 'CLAUDE.md', excerpt: 'every query filters by orgId', why: 'rule existed', wasAvailable: true }],
};

describeStores('PortabilityStore', (h) => {
  let store: Store;
  let repo: GraphStore;
  let k: KnowledgeStore;
  let p: PortabilityStore;
  let probe: StoreProbe;

  async function seed(project: Project, sid: string) {
    await repo.upsertSession(project, session(sid), [{ sha: sid.padEnd(40, '0'), ts: '2026-10-01T10:02:30Z', subject: 'fix' }]);
    await repo.saveClassification(`${sid}-t2`, pushback, true);
    await repo.decide(`${sid}-t2`, 'confirmed', null);
    await k.savePostmortem(`${sid}-t2`, pm, { miss: vec(1), lesson: vec(1) });
    await store.facts.saveFileFacts(project.key, { path: 'src/a.ts', hash: 'h', summary: 'A' }, [{ path: 'src/a.ts', lines: '1', kind: 'convention', statement: 'use scoped()', why: 'w', confidence: 1, embedding: vec(2) }], 'ollama:gemma4');
    await store.docs.upsertDoc({ projectKey: project.key, source: 'upload', ref: 'upload:spec.md', title: 'Spec', url: null }, [{ text: 'orders spec', embedding: vec(3) }]);
    await store.activity.record({ kind: 'doc_added', actor: 'you', projectKey: project.key, subject: 's', why: 'w', details: {}, targets: [] });
  }

  beforeAll(() => {
    store = h.store;
    repo = h.store.graph;
    k = h.store.knowledge;
    p = h.store.portability;
    probe = h.probe;
  });
  beforeEach(async () => {
    await seed({ key: 'demo', name: 'demo', repoPath: '/vibe/demo' }, 's1');
    await seed({ key: 'other', name: 'other', repoPath: '/vibe/other' }, 's2');
  });

  test('export is a versioned bundle of one project\'s derived knowledge, without raw transcripts or vectors', async () => {
    const x = await p.exportData({ projectKey: 'demo' });
    expect(x).toMatchObject({ format: EXPORT_FORMAT, schemaVersion: 1, projectKey: 'demo' });
    expect(x.lessons.map((l) => l.title)).toEqual(['Scope by org']);
    expect(x.misses).toEqual([expect.objectContaining({ missed: 'no tenant scoping', cause: 'context_available_ignored', feedbackText: 'turn 2' })]);
    expect(x.misses[0].contextItems).toEqual([expect.objectContaining({ kind: 'claude_md', ref: 'CLAUDE.md' })]);
    expect(x.facts.map((f) => f.statement)).toEqual(['use scoped()']);
    expect(x.docs.map((d) => d.title)).toEqual(['Spec']);
    const json = JSON.stringify(x);
    expect(json).not.toContain('"embedding"');
    expect(json).not.toContain('turn 1'); // other turns of the session are not part of the bundle
  });

  test('both backup adapters roundtrip review flags without changing an approved status', async () => {
    const [original] = await k.listLessons({ projectKey: 'demo' });
    await k.updateLesson(original.id, { status: 'approved' }, {});
    const checks = [{ name: 'no-miss' as const, why: 'the disputed claim was false' }];
    await k.setLessonChecks(original.id, checks);
    const backup = JSON.parse(JSON.stringify(await p.exportData({ projectKey: 'demo' })));
    const saved = backup.lessons.find((l: { id: string }) => l.id === original.id);
    expect(saved).toMatchObject({ status: 'approved', checks });
    await k.upsertLesson({ ...saved, id: 'restored:flagged', embedding: vec(1) });
    expect((await k.lessonDetail('restored:flagged'))?.lesson).toMatchObject({ status: 'approved', checks });
    expect((await p.exportData({ projectKey: 'demo' })).lessons.find((l) => l.id === 'restored:flagged')?.checks).toEqual(checks);
    expect((await k.listLessons({ status: 'approved', projectKey: 'demo' })).map((l) => l.id)).toContain('restored:flagged');
    expect((await k.searchLessons({ embedding: vec(1), projectKey: 'demo', k: 10 })).map((h) => h.lesson.id)).not.toContain('restored:flagged');
  });

  test('the bundle carries each project\'s git remote, so clones in differently named folders can be matched', async () => {
    await repo.setProjectRemote('demo', 'github.com/org/demo');
    const one = await p.exportData({ projectKey: 'demo' });
    expect(one.schemaVersion).toBe(1); // an added field is not a breaking change
    expect(one.projects).toEqual([{ key: 'demo', remote: 'github.com/org/demo' }]);
    expect((await p.exportData()).projects).toEqual([{ key: 'demo', remote: 'github.com/org/demo' }, { key: 'other', remote: null }]);
    expect((await p.exportData({ projectKey: 'nope' })).projects).toEqual([]);
  });

  test('projectKeys exports only those projects: an unselected one stays out, global lessons learned in it too', async () => {
    const [g] = await k.listLessons({ projectKey: 'other' });
    await k.updateLesson(g.id, { scope: 'global' }, {});
    const x = await p.exportData({ projectKeys: ['demo'] });
    expect(x.projectKey).toBeNull();
    expect(x.projects.map((r) => r.key)).toEqual(['demo']);
    expect(x.lessons.map((l) => l.projectKey)).toEqual(['demo']);
    expect(x.misses.map((m) => m.projectKey)).toEqual(['demo']);
    expect(x.facts.map((f) => f.projectKey)).toEqual(['demo']);
    expect(x.docs.map((d) => d.projectKey)).toEqual(['demo']);
    expect(x.codeFiles.every((f) => f.projectKey === 'demo')).toBe(true);
    // Listing the project it was learned in brings the global lesson along.
    expect((await p.exportData({ projectKeys: ['demo', 'other'] })).lessons).toHaveLength(2);
    const none = await p.exportData({ projectKeys: [] });
    expect([none.projects, none.lessons, none.misses, none.facts, none.docs, none.codeFiles]).toEqual([[], [], [], [], [], []]);
  });

  test('approvedOnly exports just what you approved, the shape a team sync would send', async () => {
    expect((await p.exportData({ projectKey: 'demo', approvedOnly: true })).lessons).toEqual([]);
    const [l] = await k.listLessons({ projectKey: 'demo' });
    await k.updateLesson(l.id, { status: 'approved' }, {});
    expect((await p.exportData({ projectKey: 'demo', approvedOnly: true })).lessons).toHaveLength(1);
  });

  test('deleting a project removes everything learned from it and leaves other projects alone', async () => {
    const before = await p.exportData({ projectKey: 'other' });
    const removed = await p.deleteProject('demo');
    expect(removed).toBeGreaterThan(10);
    expect(await probe.filedUnder('demo')).toEqual([]);
    expect((await probe.ids('Turn')).filter((id) => id.startsWith('s1-'))).toEqual([]);
    expect(await probe.ids('Commit')).not.toContain('s1'.padEnd(40, '0'));
    expect(await probe.ids('Commit')).toContain('s2'.padEnd(40, '0'));
    expect(await p.exportData({ projectKey: 'other' })).toEqual({ ...before, exportedAt: expect.any(String) });
  });

  test('the export is deterministic: rows that tie on every sort column still come out in the same order', async () => {
    // Same path and statement, different kinds: they tie on (project, path, statement), so only an id breaks the tie.
    const fact = (kind: FactKind) => ({ path: 'src/b.ts', lines: '1', kind, statement: 'same words', why: 'w', confidence: 1, embedding: vec(4) });
    await store.facts.saveFileFacts('demo', { path: 'src/b.ts', hash: 'h', summary: 'B' }, (['convention', 'gotcha', 'invariant', 'api'] as const).map(fact), 'ollama:gemma4');
    const first = await p.exportData({ projectKey: 'demo' });
    for (let i = 0; i < 5; i++) expect(await p.exportData({ projectKey: 'demo' })).toEqual({ ...first, exportedAt: expect.any(String) });
    expect(first.facts.filter((f) => f.path === 'src/b.ts')).toHaveLength(4);
  });
});
