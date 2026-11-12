import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import { PROJECT_PATH } from './facts.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const demo = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };

describeStores('Store boundaries', (h) => {
  let s: Store;
  beforeAll(() => {
    s = h.store;
  });

  test('a search for an empty embedding finds nothing, whatever is stored', async () => {
    await s.facts.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [{ kind: 'convention', statement: 'uses zod', path: 'src/a.ts', lines: '1', confidence: 0.9, why: 'w', embedding: vec(1) }], 'p');
    await s.docs.upsertDoc({ projectKey: 'demo', source: 'upload', ref: 'guide.md', title: 'Guide', url: null }, [{ text: 'how we deploy', embedding: vec(1) }]);
    expect(await s.facts.searchFacts({ embedding: [], projectKey: 'demo', k: 5 })).toEqual([]);
    expect(await s.docs.searchDocs({ embedding: [], projectKey: 'demo', k: 5 })).toEqual([]);
    expect(await s.knowledge.searchLessons({ embedding: [], projectKey: 'demo', k: 5 })).toEqual([]);
    expect(await s.knowledge.relatedMisses({ embedding: [], projectKey: 'demo', k: 5 })).toEqual([]);
  });

  test('updating a lesson that does not exist changes nothing', async () => {
    expect(await s.knowledge.updateLesson('lesson:nope', { title: 'x', status: 'approved' }, { reembed: vec(2) })).toEqual({ unscoped: false });
    expect(await h.probe.count('Lesson')).toBe(0);
  });

  test('a thread with no comments stores nothing', async () => {
    expect(await s.graph.upsertExternalThread(demo, { id: 'github:acme/shop#1', source: 'github', items: [] })).toBe(0);
    expect(await h.probe.count('Session')).toBe(0);
    expect(await h.probe.count('Project')).toBe(0);
  });

  test('a project-wide fact in a scan shard is filed under the project, not under an empty path', async () => {
    await s.facts.replaceScopeFacts('demo', { prefixes: [''], except: [] }, [{ kind: 'convention', statement: 'pnpm workspace', path: '', lines: '', confidence: 0.9, why: 'w', embedding: vec(3) }], 'claude-cli', []);
    expect((await s.facts.listFacts({ projectKey: 'demo' })).map((f) => [f.statement, f.path])).toEqual([['pnpm workspace', PROJECT_PATH]]);
  });

  test('marking files removed that the project never had changes nothing', async () => {
    await s.facts.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [], 'p');
    await s.facts.markFilesRemoved('demo', ['src/never.ts']);
    await s.facts.markFilesRemoved('other', ['src/a.ts']);
    expect(await s.facts.fileHashes('demo')).toEqual(new Map([['src/a.ts', 'h']]));
  });
});
