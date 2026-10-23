import { beforeAll, expect, test } from 'vitest';
import type { FactsStore } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import type { CodeFact } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const fact = (statement: string, path = 'src/a.ts'): CodeFact & { embedding: number[] } => ({
  kind: 'convention', statement, path, lines: '1-5', confidence: 0.9, why: `agents need: ${statement}`, embedding: vec(1),
});

describeStores('FactsStore', (h) => {
  let f: FactsStore;
  let probe: StoreProbe;
  beforeAll(() => {
    f = h.store.facts;
    probe = h.probe;
  });

  test('saveFileFacts stores facts and file hashes; rescanning a file closes its old facts', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h1', summary: 'A' }, [fact('old rule')], 'ollama:gemma4');
    expect(await f.fileHashes('demo')).toEqual(new Map([['src/a.ts', 'h1']]));
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h2', summary: 'A2' }, [fact('new rule')], 'ollama:gemma4');
    const current = await f.listFacts({ projectKey: 'demo' });
    expect(current.map((x) => x.statement)).toEqual(['new rule']);
    expect(await probe.factVersions('old rule')).toEqual([{ current: false, closed: true }]);
  });

  test('facts keep their provenance: why, scan job, file hash, and the file summary', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h1', summary: 'Data access layer' }, [fact('use scoped')], 'ollama:gemma4', 'scan:9');
    const [x] = await f.listFacts({ projectKey: 'demo' });
    expect(x).toMatchObject({ why: 'agents need: use scoped', source: 'ollama:gemma4', scanJobId: 'scan:9', fileHash: 'h1', fileSummary: 'Data access layer' });
    await f.replaceProjectFacts('demo', [fact('agentic', 'src/b.ts')], 'claude-cli', [{ path: 'src/b.ts', hash: 'hb' }], 'scan:10');
    const agentic = (await f.listFacts({ projectKey: 'demo' })).find((y) => y.statement === 'agentic')!;
    expect(agentic).toMatchObject({ why: 'agents need: agentic', scanJobId: 'scan:10', fileHash: 'hb' });
  });

  test('markFilesRemoved closes facts of deleted files', async () => {
    await f.saveFileFacts('demo', { path: 'src/gone.ts', hash: 'h', summary: '' }, [fact('gone', 'src/gone.ts')], 'p');
    await f.markFilesRemoved('demo', ['src/gone.ts']);
    expect(await f.listFacts({ projectKey: 'demo' })).toEqual([]);
    expect(await f.fileHashes('demo')).toEqual(new Map());
  });

  test('replaceProjectFacts swaps all current facts from a source (agentic scans)', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [fact('per-file')], 'ollama:gemma4');
    await f.replaceProjectFacts('demo', [fact('agentic 1', 'src/b.ts'), fact('agentic 2', '.')], 'claude-cli', [{ path: 'src/b.ts', hash: 'hb' }]);
    await f.replaceProjectFacts('demo', [fact('agentic 3', 'src/b.ts')], 'claude-cli', [{ path: 'src/b.ts', hash: 'hb2' }]);
    // A whole-repo scan replaces what any model said before, so agents never get near-duplicates from two models.
    expect((await f.listFacts({ projectKey: 'demo' })).map((x) => x.statement).sort()).toEqual(['agentic 3']);
    expect(await f.currentSources('demo')).toEqual(['claude-cli']);
  });

  test('a replace that fails part way leaves the old facts and file hashes as they were', async () => {
    await f.replaceProjectFacts('demo', [fact('old', 'src/b.ts')], 'claude-cli', [{ path: 'src/b.ts', hash: 'h1' }]);
    const bad = { ...fact('new', 'src/b.ts'), kind: { not: 'a primitive' } } as unknown as ReturnType<typeof fact>;
    await expect(f.replaceProjectFacts('demo', [bad], 'claude-cli', [{ path: 'src/b.ts', hash: 'h2' }])).rejects.toThrow();
    expect((await f.listFacts({ projectKey: 'demo' })).map((x) => x.statement)).toEqual(['old']);
    expect((await f.fileHashes('demo')).get('src/b.ts')).toBe('h1');
  });

  test('searchFacts returns current facts for the project, nearest first', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [{ ...fact('near'), embedding: vec(2) }, { ...fact('far'), embedding: vec(9) }], 'p');
    await f.saveFileFacts('other', { path: 'src/a.ts', hash: 'h', summary: '' }, [{ ...fact('other project'), embedding: vec(2) }], 'p');
    const hits = await f.searchFacts({ embedding: vec(2), projectKey: 'demo', k: 1 });
    expect(hits.map((h) => h.fact.statement)).toEqual(['near']);
  });

  test('a scan failure is stored redacted', async () => {
    const job = await f.requestScan({ key: 'red', name: 'red', repoPath: '/vibe/red' }, 'claude-cli');
    const key = `ghp_${'B'.repeat(36)}`;
    await f.updateScanJob(job.id, { status: 'failed', error: `Error: claude error: the token is ${key}` });
    const p = (await f.listProjects()).find((x) => x.key === 'red');
    expect(p?.lastScan?.error).toContain('[REDACTED]');
    expect(p?.lastScan?.error).not.toContain(key);
  });

  test('scan jobs queue, run and finish; projects summarise', async () => {
    const job = await f.requestScan({ key: 'demo', name: 'demo', repoPath: '/vibe/demo' }, 'ollama:gemma4');
    expect((await f.nextScanJob())?.id).toBe(job.id);
    await f.updateScanJob(job.id, { status: 'running' });
    expect(await f.nextScanJob()).toBeNull();
    await f.updateScanJob(job.id, { status: 'done', filesScanned: 3, factsAdded: 7 });
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [fact('x')], 'p');
    const [p] = await f.listProjects();
    expect(p).toMatchObject({ key: 'demo', facts: 1, lastScan: { status: 'done', filesScanned: 3, factsAdded: 7, provider: 'ollama:gemma4' } });
    expect(p.lastScan?.startedAt).not.toBeNull();
    expect(p.lastScan?.finishedAt).not.toBeNull();
  });

  test('stored facts and file summaries are redacted, whatever the model returned', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: 'key sk-ant-api03-cccccccccccccccccccccccccccccccccccccccc' }, [{ ...fact('uses sk-ant-api03-cccccccccccccccccccccccccccccccccccccccc'), why: 'why sk-ant-api03-cccccccccccccccccccccccccccccccccccccccc' }], 'p');
    await f.replaceProjectFacts('demo', [{ ...fact('agentic sk-ant-api03-cccccccccccccccccccccccccccccccccccccccc', 'src/b.ts'), why: 'sk-ant-api03-cccccccccccccccccccccccccccccccccccccccc' }], 'claude-cli', [{ path: 'src/b.ts', hash: 'hb' }]);
    expect(JSON.stringify(await f.listFacts({ projectKey: 'demo' }))).not.toContain('sk-ant-api03');
  });

  test('project facts are found even when many closer facts belong to other projects', async () => {
    await f.saveFileFacts('noise', { path: 'n.ts', hash: 'h', summary: '' }, Array.from({ length: 250 }, (_, i) => fact(`noise ${i}`, 'n.ts')), 'p');
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [{ ...fact('mine'), embedding: vec(2) }], 'p');
    expect((await f.searchFacts({ embedding: vec(1), projectKey: 'demo', k: 10 })).map((h) => h.fact.statement)).toEqual(['mine']);
  });

  test('asking for a scan while one is queued or running returns that one instead of queueing another', async () => {
    const p = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
    const a = await f.requestScan(p, 'ollama:gemma4');
    const b = await f.requestScan(p, 'ollama:gemma4');
    expect(b.id).toBe(a.id);
    await f.updateScanJob(a.id, { status: 'done' });
    expect((await f.requestScan(p, 'ollama:gemma4')).id).not.toBe(a.id);
  });

  test('listProjects shows each project remote and its alias folders', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [fact('x')], 'p');
    await probe.setProject('demo', { remote: 'github.com/org/demo', aliases: ['demo-2'] });
    await f.saveFileFacts('plain', { path: 'a.ts', hash: 'h', summary: '' }, [fact('y', 'a.ts')], 'p');
    const ps = await f.listProjects();
    expect(ps.find((p) => p.key === 'demo')).toMatchObject({ remote: 'github.com/org/demo', aliases: ['demo-2'] });
    expect(ps.find((p) => p.key === 'plain')).toMatchObject({ remote: null, aliases: [] });
  });

  test('scores are cosine similarity scaled to 0..1: same direction 1, orthogonal 0.5', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [{ ...fact('same'), embedding: vec(2) }, { ...fact('orthogonal'), embedding: vec(3) }], 'p');
    const hits = await f.searchFacts({ embedding: vec(2), projectKey: 'demo', k: 2 });
    expect(hits.map((x) => [x.fact.statement, x.score])).toEqual([['same', 1], ['orthogonal', 0.5]]);
  });
});
