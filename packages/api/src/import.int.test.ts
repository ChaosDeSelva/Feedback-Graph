import type { Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { importBundle, parseBundle, type ImportDeps } from './import.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));

describeStores('import of an export bundle', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
    knowledge: store.knowledge,
    facts: store.facts,
    // "The current model": a different vector than the one the lessons were stored with.
    embed: async (t) => t.map(() => vec(7)),
    activity: store.activity,
    excluded: [],
    ...over,
  });

  async function exported() {
    const base = { title: 'Scope by org', rule: 'Filter every list by orgId', appliesWhen: 'list endpoints', paths: [], source: 'postmortem' as const };
    await store.knowledge.upsertLesson({ ...base, id: 'lesson:a', projectKey: 'demo', scope: 'project', status: 'approved', embedding: vec(1) });
    await store.knowledge.upsertLesson({ ...base, id: 'lesson:g', projectKey: null, scope: 'global', status: 'approved', title: 'Run the tests', embedding: vec(1) });
    await store.knowledge.upsertLesson({ ...base, id: 'lesson:r', projectKey: 'demo', scope: 'project', status: 'rejected', title: 'Nope', embedding: vec(1) });
    await store.facts.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: 'A' }, [{ path: 'src/a.ts', lines: '1', kind: 'convention', statement: 'use scoped()', why: 'w', confidence: 1, embedding: vec(2) }], 'ollama:gemma4');
    const bundle = parseBundle(JSON.parse(JSON.stringify(await store.portability.exportData())));
    if (!bundle.success) throw new Error(JSON.stringify(bundle.error.flatten()));
    await h.probe.wipe();
    return bundle.data;
  }

  test('lessons come back proposed and re-embedded, facts come back attributed to the import, and Activity says so', async () => {
    const b = await exported();
    const r = await importBundle(b, { keepApproved: false }, deps());
    expect(r.lessons).toMatchObject({ added: 2, proposed: 2, approved: 0, skipped: 1 });
    const lessons = await store.knowledge.listLessons({ projectKey: 'demo' });
    expect(lessons.map((l) => [l.id, l.status, l.projectKey]).sort()).toEqual([['lesson:a', 'proposed', 'demo'], ['lesson:g', 'proposed', null]]);
    // Nothing reaches agents until you approve it.
    expect(await store.knowledge.searchLessons({ embedding: vec(7), projectKey: 'demo', k: 5 })).toEqual([]);
    expect((await store.knowledge.searchLessons({ embedding: vec(7), projectKey: 'demo', k: 5, status: 'proposed' })).map((x) => x.lesson.id).sort()).toEqual(['lesson:a', 'lesson:g']);
    const facts = await store.facts.listFacts({ projectKey: 'demo' });
    expect(facts.map((f) => [f.path, f.statement, f.source])).toEqual([['src/a.ts', 'use scoped()', 'import:ollama:gemma4']]);
    expect((await store.facts.searchFacts({ embedding: vec(7), projectKey: 'demo', k: 3 })).map((x) => x.fact.statement)).toEqual(['use scoped()']);
    // No hash: the first scan here reads every file and replaces what was imported.
    expect(await store.facts.fileHashes('demo')).toEqual(new Map());
    const log = await store.activity.list({ kind: 'bundle_imported' });
    expect(log).toEqual([expect.objectContaining({ actor: 'you', targets: expect.arrayContaining(['lesson:a', 'lesson:g']) })]);
  });

  test('importing the same bundle twice changes nothing, and never overrides your decision on a lesson', async () => {
    const b = await exported();
    await importBundle(b, { keepApproved: false }, deps());
    await store.knowledge.updateLesson('lesson:a', { status: 'rejected' }, {});
    const again = await importBundle(b, { keepApproved: true }, deps());
    expect(again.lessons).toMatchObject({ added: 0, existing: 2 });
    expect(again.facts).toMatchObject({ added: 0, skippedProjects: ['demo'] });
    expect((await store.knowledge.lessonDetail('lesson:a'))?.lesson.status).toBe('rejected');
    expect(await store.facts.listFacts({ projectKey: 'demo' })).toHaveLength(1);
  });

  test('a search with no project (a folder that is not selected) finds only the global lessons', async () => {
    await importBundle(await exported(), { keepApproved: true }, deps());
    expect((await store.knowledge.searchLessons({ embedding: vec(7), projectKey: null, k: 5 })).map((x) => x.lesson.id)).toEqual(['lesson:g']);
    expect((await store.knowledge.searchLessons({ embedding: vec(7), projectKey: 'demo', k: 5 })).map((x) => x.lesson.id).sort()).toEqual(['lesson:a', 'lesson:g']);
  });

  test('keepApproved serves approved lessons straight away; EXCLUDE_PROJECTS is never imported', async () => {
    const b = await exported();
    const r = await importBundle(b, { keepApproved: true }, deps({ excluded: ['demo'] }));
    expect(r.lessons).toMatchObject({ added: 1, approved: 1, excluded: 1 });
    expect((await store.knowledge.searchLessons({ embedding: vec(7), projectKey: 'other', k: 5 })).map((x) => x.lesson.id)).toEqual(['lesson:g']);
    expect(await store.facts.listFacts({ projectKey: 'demo' })).toEqual([]);
  });
});
