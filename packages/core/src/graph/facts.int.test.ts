import { beforeAll, expect, test } from 'vitest';
import type { FactsStore } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import type { CodeFact } from '../types.ts';
import { MAX_SCAN_ATTEMPTS, SCAN_UNAVAILABLE_WAIT_MS } from './facts.ts';

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

  test('facts keep their origin and evidence level; older facts without them read as model (or manifest) facts with no evidence', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [
      { ...fact('cited and checked'), origin: 'model', evidence: 'line' },
      { ...fact('`dev` script runs: vite', 'package.json'), why: 'Read directly from package.json; no model involved.' },
      fact('older fact'),
    ], 'p');
    await f.replaceProjectFacts('other', [{ ...fact('a Make target', 'Makefile'), origin: 'manifest', evidence: 'file' }], 'claude-cli', []);
    const all = [...(await f.listFacts({ projectKey: 'demo' })), ...(await f.listFacts({ projectKey: 'other' }))];
    const by = Object.fromEntries(all.map((x) => [x.statement, x]));
    expect(by['cited and checked']).toMatchObject({ origin: 'model', evidence: 'line' });
    expect(by['`dev` script runs: vite']).toMatchObject({ origin: 'manifest', evidence: null });
    expect(by['older fact']).toMatchObject({ origin: 'model', evidence: null });
    expect(by['a Make target']).toMatchObject({ origin: 'manifest', evidence: 'file' });
    const [hit] = await f.searchFacts({ embedding: vec(1), projectKey: 'other', k: 1 });
    expect(hit.fact).toMatchObject({ origin: 'manifest', evidence: 'file' });
  });

  test('listProjects counts current facts by origin, so model facts can headline the count', async () => {
    await f.replaceProjectFacts('demo', [
      { ...fact('m1'), origin: 'model' }, fact('older model fact'),
      { ...fact('s1', 'package.json'), origin: 'manifest' }, { ...fact('s2', 'package.json'), why: 'Read directly from package.json; no model involved.' },
    ], 'claude-cli', []);
    const p = (await f.listProjects()).find((x) => x.key === 'demo')!;
    expect(p.facts).toBe(4);
    expect(p.factsByOrigin).toEqual({ model: 2, manifest: 2, document: 0, you: 0 });
  });

  test('addOwnerFact saves your fact (origin you, your relevance); no scan closes or replaces it', async () => {
    const mine = await f.addOwnerFact('demo', { kind: 'gotcha', statement: 'Orders read from the source table', path: 'src/a.ts', lines: null, confidence: 1, why: 'From the lesson "Read orders"', relevance: 0.8, embedding: vec(2) }, 'operator:codex');
    expect(mine).toMatchObject({ statement: 'Orders read from the source table', origin: 'you', relevance: 0.8, relevanceBy: 'operator:codex', source: 'operator:codex', docId: null });
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h1', summary: '' }, [fact('per-file')], 'ollama:gemma4');
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h2', summary: '' }, [fact('per-file again')], 'ollama:gemma4');
    await f.markFilesRemoved('demo', ['src/a.ts']);
    await f.replaceProjectFacts('demo', [fact('agentic', 'src/b.ts')], 'claude-cli', [{ path: 'src/b.ts', hash: 'hb' }]);
    expect((await f.listFacts({ projectKey: 'demo' })).map((x) => x.statement).sort()).toEqual(['Orders read from the source table', 'agentic']);
    expect((await f.listFacts({ projectKey: 'demo', path: 'src/a.ts' })).map((x) => x.id)).toEqual([mine.id]);
    // Your facts are not a model's: a scan with another model does not take them as a reason to rescan every file.
    expect(await f.currentSources('demo')).toEqual(['claude-cli']);
    const [hit] = await f.searchFacts({ embedding: vec(2), projectKey: 'demo', k: 1 });
    expect(hit.fact.id).toBe(mine.id);
    // The background scorer never sees it: it has your relevance already, and a model update leaves it alone.
    expect((await f.unscoredFacts({ projectKeys: ['demo'], limit: 10 })).map((x) => x.id)).not.toContain(mine.id);
    expect(await f.setFactRelevance([{ id: mine.id, relevance: 0.1, by: 'model' }])).toBe(0);
    expect((await f.listProjects()).find((p) => p.key === 'demo')?.factsByOrigin).toEqual({ model: 1, manifest: 0, document: 0, you: 1 });
  });

  test('facts keep the relevance the extractor gave; facts without one are unscored', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [{ ...fact('core rule'), relevance: 0.9 }, fact('no score')], 'p');
    await f.replaceProjectFacts('other', [{ ...fact('setup step', '.'), relevance: 0.1 }], 'claude-cli', []);
    const byStatement = Object.fromEntries([...(await f.listFacts({ projectKey: 'demo' })), ...(await f.listFacts({ projectKey: 'other' }))].map((x) => [x.statement, x]));
    expect(byStatement['core rule']).toMatchObject({ relevance: 0.9, relevanceBy: 'model' });
    expect(byStatement['no score']).toMatchObject({ relevance: null, relevanceBy: null });
    expect(byStatement['setup step']).toMatchObject({ relevance: 0.1, relevanceBy: 'model' });
    const [hit] = await f.searchFacts({ embedding: vec(1), projectKey: 'other', k: 1 });
    expect(hit.fact.relevance).toBe(0.1);
  });

  test('unscoredFacts lists current facts of the given projects with no relevance; setFactRelevance scores them', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [fact('a'), { ...fact('b'), relevance: 0.5 }], 'p');
    await f.saveFileFacts('skip', { path: 'src/a.ts', hash: 'h', summary: '' }, [fact('not selected')], 'p');
    const todo = await f.unscoredFacts({ projectKeys: ['demo'], limit: 10 });
    expect(todo.map((x) => x.statement)).toEqual(['a']);
    expect(todo[0]).toMatchObject({ projectKey: 'demo', kind: 'convention', path: 'src/a.ts' });
    await f.setFactRelevance([{ id: todo[0].id, relevance: 0.2, by: 'model' }]);
    expect(await f.unscoredFacts({ projectKeys: ['demo'], limit: 10 })).toEqual([]);
    expect((await f.listFacts({ projectKey: 'demo' })).find((x) => x.statement === 'a')).toMatchObject({ relevance: 0.2, relevanceBy: 'model' });
  });

  test("the owner's relevance wins: a model score never overwrites it", async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [{ ...fact('a'), relevance: 0.9 }], 'p');
    const [x] = await f.listFacts({ projectKey: 'demo' });
    expect(await f.setFactRelevance([{ id: x.id, relevance: 0.1, by: 'you' }])).toBe(1);
    expect(await f.setFactRelevance([{ id: x.id, relevance: 0.8, by: 'model' }])).toBe(0);
    expect((await f.listFacts({ projectKey: 'demo' }))[0]).toMatchObject({ relevance: 0.1, relevanceBy: 'you' });
    // Out of range is clamped, an unknown id changes nothing.
    await f.setFactRelevance([{ id: x.id, relevance: 7, by: 'you' }, { id: 'nope', relevance: 0.5, by: 'you' }]);
    expect((await f.listFacts({ projectKey: 'demo' }))[0].relevance).toBe(1);
    // Scoped to a project: a fact of another project is left alone.
    expect(await f.setFactRelevance([{ id: x.id, relevance: 0.3, by: 'you', projectKey: 'other' }])).toBe(0);
    expect(await f.setFactRelevance([{ id: x.id, relevance: 0.3, by: 'you', projectKey: 'demo' }])).toBe(1);
  });

  test('an agent with the operator token is recorded by name, and a model score does not overwrite it either', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [{ ...fact('a'), relevance: 0.9 }], 'p');
    const [x] = await f.listFacts({ projectKey: 'demo' });
    expect(await f.setFactRelevance([{ id: x.id, relevance: 0.2, by: 'operator:codex' }])).toBe(1);
    expect(await f.setFactRelevance([{ id: x.id, relevance: 0.8, by: 'model' }])).toBe(0);
    expect((await f.listFacts({ projectKey: 'demo' }))[0]).toMatchObject({ relevance: 0.2, relevanceBy: 'operator:codex' });
    // You can still change what an agent set.
    expect(await f.setFactRelevance([{ id: x.id, relevance: 0.6, by: 'you' }])).toBe(1);
  });

  test('pinning a project shows in listProjects; a folder with no data yet is recorded when pinned; unpin clears it', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [fact('x')], 'p');
    expect((await f.listProjects()).find((p) => p.key === 'demo')?.pinned).toBe(false);
    await f.setPinned({ key: 'demo', name: 'demo', repoPath: '/vibe/demo' }, true);
    await f.setPinned({ key: 'fresh', name: 'fresh', repoPath: '/vibe/fresh' }, true);
    const list = await f.listProjects();
    expect(list.find((p) => p.key === 'demo')).toMatchObject({ pinned: true, facts: 1 });
    expect(list.find((p) => p.key === 'fresh')).toMatchObject({ pinned: true, repoPath: '/vibe/fresh', facts: 0 });
    await f.setPinned({ key: 'demo', name: 'demo', repoPath: '/elsewhere' }, false);
    // Unpinning never rewrites what the project already knows about itself.
    expect((await f.listProjects()).find((p) => p.key === 'demo')).toMatchObject({ pinned: false });
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

  test('replaceScopeFacts swaps only the facts in its scope (one shard of an agentic scan); facts elsewhere stay current', async () => {
    const at = (path: string) => fact(`old ${path}`, path);
    await f.replaceProjectFacts('demo', ['packages/core/a.ts', 'packages/core', 'packages/core/plugins/x/b.ts', 'packages/api/c.ts', '.', 'README.md', 'packages/core2/d.ts'].map(at),
      'claude-cli', [{ path: 'packages/core/a.ts', hash: 'h1' }, { path: 'packages/api/c.ts', hash: 'h1' }]);
    // The packages/core shard: its own files and its directory, not the nested package nor a look-alike prefix.
    await f.replaceScopeFacts('demo', { prefixes: ['packages/core'], except: ['packages/core/plugins/x'] }, [fact('core new', 'packages/core/a.ts')],
      'claude-cli', [{ path: 'packages/core/a.ts', hash: 'h2' }, { path: 'packages/core/new.ts', hash: 'hn' }], 'scan:2');
    const statements = async () => (await f.listFacts({ projectKey: 'demo' })).map((x) => x.statement).sort();
    expect(await statements()).toEqual(['core new', 'old .', 'old README.md', 'old packages/api/c.ts', 'old packages/core/plugins/x/b.ts', 'old packages/core2/d.ts']);
    expect(await f.fileHashes('demo')).toEqual(new Map([['packages/core/a.ts', 'h2'], ['packages/core/new.ts', 'hn'], ['packages/api/c.ts', 'h1']]));
    expect((await f.listFacts({ projectKey: 'demo', path: 'packages/core/a.ts' }))[0]).toMatchObject({ scanJobId: 'scan:2', fileHash: 'h2', source: 'claude-cli' });
    // The rest of the repo: everything not under another shard's root, project-wide facts included.
    await f.replaceScopeFacts('demo', { prefixes: [''], except: ['packages/api', 'packages/core', 'packages/core/plugins/x'] }, [fact('root new', '.')], 'claude-cli', []);
    expect(await statements()).toEqual(['core new', 'old packages/api/c.ts', 'old packages/core/plugins/x/b.ts', 'root new']);
    // Another project is never touched.
    await f.saveFileFacts('other', { path: 'packages/core/a.ts', hash: 'h', summary: '' }, [fact('other project', 'packages/core/a.ts')], 'p');
    await f.replaceScopeFacts('demo', { prefixes: ['packages/core'], except: [] }, [], 'claude-cli', []);
    expect((await f.listFacts({ projectKey: 'other' })).map((x) => x.statement)).toEqual(['other project']);
  });

  test('a scope replace that fails part way leaves the old facts and file hashes as they were', async () => {
    await f.replaceScopeFacts('demo', { prefixes: ['src'], except: [] }, [fact('old', 'src/b.ts')], 'claude-cli', [{ path: 'src/b.ts', hash: 'h1' }]);
    const bad = { ...fact('new', 'src/b.ts'), kind: { not: 'a primitive' } } as unknown as ReturnType<typeof fact>;
    await expect(f.replaceScopeFacts('demo', { prefixes: ['src'], except: [] }, [bad], 'claude-cli', [{ path: 'src/b.ts', hash: 'h2' }])).rejects.toThrow();
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
    // The worker's scan runner passes over jobs it is not ready for (an agentic one while another agentic one runs).
    await f.updateScanJob(job.id, { status: 'queued' });
    const second = await f.requestScan({ key: 'demo2', name: 'demo2', repoPath: '/vibe/demo2' }, null);
    expect((await f.nextScanJob(new Date(), [job.id]))?.id).toBe(second.id);
    expect(await f.nextScanJob(new Date(), [job.id, second.id])).toBeNull();
    await f.updateScanJob(second.id, { status: 'done' });
    await f.updateScanJob(job.id, { status: 'running' });
    await f.updateScanJob(job.id, { status: 'done', filesScanned: 3, factsAdded: 7, shards: { total: 20, rescanned: 12, failed: 1 } });
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [fact('x')], 'p');
    const [p] = await f.listProjects();
    expect(p).toMatchObject({ key: 'demo', facts: 1, lastScan: { status: 'done', filesScanned: 3, factsAdded: 7, provider: 'ollama:gemma4', shards: { total: 20, rescanned: 12, failed: 1 } } });
    // A per-file scan has no shards.
    expect((await f.scanJob(second.id))?.shards).toBeNull();
    expect(p.lastScan?.startedAt).not.toBeNull();
    expect(p.lastScan?.finishedAt).not.toBeNull();
  });

  test('the scan queue is fair across projects: a job that gave up its slot after a shard waits behind those queued since', async () => {
    const t0 = new Date(Date.now() + 3_600_000);
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const big = await f.requestScan({ key: 'big', name: 'big', repoPath: '/vibe/big' }, 'codex-cli');
    const small = await f.requestScan({ key: 'small', name: 'small', repoPath: '/vibe/small' }, 'codex-cli');
    expect((await f.nextScanJob(at(60)))?.id).toBe(big.id);
    await f.updateScanJob(big.id, { status: 'running' });
    await f.updateScanJob(big.id, { factsAdded: 4, shards: { total: 40, done: 1, rescanned: 1, failed: 0, processed: ['packages/a'] } });
    // One shard done and another project waiting: back in the queue, its progress kept, waiting from now.
    await f.requeueScanJob(big.id, at(30));
    expect(await f.scanJob(big.id)).toMatchObject({ status: 'queued', attempts: 0, factsAdded: 4, servedAt: at(30).toISOString(), shards: { done: 1, processed: ['packages/a'] } });
    expect((await f.nextScanJob(at(60)))?.id).toBe(small.id);
    // The queue in the order it is served, each with how long it has waited.
    expect((await f.scanQueue()).map((j) => [j.projectKey, j.status, j.waitingSince])).toEqual([
      ['small', 'queued', small.requestedAt],
      ['big', 'queued', at(30).toISOString()],
    ]);
    await f.updateScanJob(small.id, { status: 'running' });
    expect((await f.nextScanJob(at(60)))?.id).toBe(big.id);
    expect((await f.scanQueue()).map((j) => [j.projectKey, j.status])).toEqual([['small', 'running'], ['big', 'queued']]);
    await f.updateScanJob(small.id, { status: 'done' });
    expect((await f.scanQueue()).map((j) => j.projectKey)).toEqual(['big']);
  });

  test('a job not served yet whose files an agent asked for counts as waiting since the oldest request', async () => {
    const t0 = new Date(Date.now() + 3_600_000);
    const later = (min: number) => new Date(t0.getTime() + min * 60_000);
    // An agent asked for one of qa's files (get_task_context) before either scan was queued.
    const before = new Date().toISOString();
    await f.requestFilesScan('qa', ['src/asked.ts']);
    await new Promise((r) => setTimeout(r, 5));
    const b = await f.requestScan({ key: 'qb', name: 'qb', repoPath: '/vibe/qb' }, null);
    const a = await f.requestScan({ key: 'qa', name: 'qa', repoPath: '/vibe/qa' }, null);
    expect((await f.nextScanJob(later(10)))?.id).toBe(a.id);
    const [first] = await f.scanQueue();
    expect(first.id).toBe(a.id);
    expect(first.waitingSince >= before && first.waitingSince < b.requestedAt).toBe(true);
  });

  test('a job that gave way waits from then, whatever file of its project an agent asked for earlier: the others go first', async () => {
    const t0 = new Date(Date.now() + 3_600_000);
    const later = (min: number) => new Date(t0.getTime() + min * 60_000);
    // A 40-shard codex scan whose project has an old unread file request (in a later shard), then an agentic scan.
    await f.requestFilesScan('big40', ['packages/late/src/asked.ts']);
    const big = await f.requestScan({ key: 'big40', name: 'big40', repoPath: '/vibe/big40' }, 'codex-cli');
    const other = await f.requestScan({ key: 'other', name: 'other', repoPath: '/vibe/other' }, 'claude-cli');
    expect((await f.nextScanJob(later(10)))?.id).toBe(big.id);
    await f.updateScanJob(big.id, { status: 'running' });
    await f.updateScanJob(big.id, { shards: { total: 40, done: 1, rescanned: 1, failed: 0, processed: ['packages/a'] } });
    // Its first shard done and another scan waiting: it gives way, and does not get the slot straight back.
    await f.requeueScanJob(big.id, later(1));
    expect((await f.nextScanJob(later(10)))?.id).toBe(other.id);
    expect((await f.scanQueue()).map((j) => [j.projectKey, j.waitingSince])).toEqual([
      ['other', other.requestedAt],
      ['big40', later(1).toISOString()],
    ]);
    // The other scan done: the big one goes on.
    await f.updateScanJob(other.id, { status: 'running' });
    await f.updateScanJob(other.id, { status: 'done' });
    expect((await f.nextScanJob(later(10)))?.id).toBe(big.id);
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

  test('a failed scan backs off and gives up after MAX_SCAN_ATTEMPTS; an unreachable model waits without counting', async () => {
    const p = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
    const job = await f.requestScan(p, 'ollama:gemma4');
    expect(job).toMatchObject({ attempts: 0, retryAt: null });
    const t0 = new Date('2026-10-23T10:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);

    // The model could not be asked: queued, no attempt used, due again after a short wait.
    const down = await f.recordScanFailure(job.id, 'model unavailable: ECONNREFUSED', { counted: false }, t0);
    expect(down).toEqual({ attempts: 0, retryAt: new Date(t0.getTime() + SCAN_UNAVAILABLE_WAIT_MS).toISOString() });
    expect(await f.nextScanJob(at(1))).toBeNull();
    expect((await f.nextScanJob(at(3)))?.id).toBe(job.id);

    // Real failures count: 5 then 10 minutes, then failed for good.
    expect(await f.recordScanFailure(job.id, `Error: boom ghp_${'C'.repeat(36)}`, { counted: true }, t0)).toEqual({ attempts: 1, retryAt: at(5).toISOString() });
    expect(await f.nextScanJob(at(4))).toBeNull();
    expect(await f.nextScanJob(at(5))).toMatchObject({ id: job.id, status: 'queued', attempts: 1, retryAt: at(5).toISOString(), error: expect.stringContaining('[REDACTED]') });
    expect(await f.recordScanFailure(job.id, 'Error: boom', { counted: true }, t0)).toEqual({ attempts: 2, retryAt: at(10).toISOString() });
    // Asking for the scan again runs it at the next poll (same job, attempts kept).
    expect(await f.requestScan(p, 'ollama:gemma4')).toMatchObject({ id: job.id, attempts: 2, retryAt: null });
    expect(await f.recordScanFailure(job.id, 'Error: boom', { counted: true }, t0)).toEqual({ attempts: MAX_SCAN_ATTEMPTS, retryAt: null });
    expect(await f.scanJob(job.id)).toMatchObject({ status: 'failed', attempts: 3, error: 'Error: boom' });
    expect((await f.scanJob(job.id))?.finishedAt).not.toBeNull();
    expect(await f.nextScanJob(at(60))).toBeNull();
    // A failed job is closed: a new request queues a fresh one.
    expect((await f.requestScan(p, 'ollama:gemma4')).id).not.toBe(job.id);
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

  test('a scanned file keeps the scanner version that read it; files scanned before versions read as null', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '', version: 'scan-v5' }, [fact('x')], 'p');
    await f.saveFileFacts('demo', { path: 'src/old.ts', hash: 'h', summary: '' }, [fact('y', 'src/old.ts')], 'p');
    await f.replaceScopeFacts('demo', { prefixes: ['lib'], except: [] }, [], 'claude-cli', [{ path: 'lib/b.ts', hash: 'hb', version: 'scan-v5' }, { path: 'lib/c.ts', hash: 'hc' }]);
    expect(await f.fileScanVersions('demo')).toEqual(new Map([['src/a.ts', 'scan-v5'], ['src/old.ts', null], ['lib/b.ts', 'scan-v5'], ['lib/c.ts', null]]));
    // A rescan by a newer scanner moves it.
    await f.replaceScopeFacts('demo', { prefixes: ['lib'], except: [] }, [], 'claude-cli', [{ path: 'lib/c.ts', hash: 'hc', version: 'scan-v6' }]);
    expect((await f.fileScanVersions('demo')).get('lib/c.ts')).toBe('scan-v6');
  });

  test('olderScannerFiles counts, per project, the scanned files another scanner read (null included), not removed ones', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '', version: 'scan-v6' }, [fact('x')], 'p');
    await f.saveFileFacts('demo', { path: 'src/old.ts', hash: 'h', summary: '' }, [fact('y', 'src/old.ts')], 'p');
    await f.saveFileFacts('demo', { path: 'src/v5.ts', hash: 'h', summary: '', version: 'scan-v5' }, [fact('z', 'src/v5.ts')], 'p');
    await f.saveFileFacts('demo', { path: 'src/gone.ts', hash: 'h', summary: '', version: 'scan-v5' }, [fact('g', 'src/gone.ts')], 'p');
    await f.markFilesRemoved('demo', ['src/gone.ts']);
    await f.saveFileFacts('web', { path: 'a.ts', hash: 'h', summary: '', version: 'scan-v6' }, [fact('w', 'a.ts')], 'p');
    expect(await f.olderScannerFiles('scan-v6')).toEqual(new Map([['demo', 2]]));
    expect(await f.olderScannerFiles('scan-v5')).toEqual(new Map([['demo', 2], ['web', 1]]));
  });

  test('a fact carries when its file last changed: a rescan of the same content keeps the time, new content moves it', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h1', summary: '' }, [fact('first')], 'p');
    const [first] = await f.listFacts({ projectKey: 'demo' });
    expect(first.fileChangedAt).toEqual(expect.any(String));
    await new Promise((r) => setTimeout(r, 5));
    await f.replaceScopeFacts('demo', { prefixes: [''], except: [] }, [fact('same content')], 'p', [{ path: 'src/a.ts', hash: 'h1' }]);
    const [same] = await f.listFacts({ projectKey: 'demo' });
    expect(same).toMatchObject({ statement: 'same content', fileHash: 'h1', fileChangedAt: first.fileChangedAt });
    expect(same.createdAt > first.createdAt).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h2', summary: '' }, [fact('changed')], 'p');
    const [changed] = await f.listFacts({ projectKey: 'demo' });
    expect(changed.fileChangedAt! > first.fileChangedAt!).toBe(true);
    expect(changed.fileHash).toBe('h2');
  });

  test('listFacts pages with offset and limit and filters by origin (older facts by what they look like)', async () => {
    await f.replaceProjectFacts('demo', [
      { ...fact('m1', 'a.ts'), origin: 'model' }, { ...fact('m2', 'b.ts'), origin: 'model' }, fact('older model', 'c.ts'),
      { ...fact('s1', 'package.json'), origin: 'manifest' }, { ...fact('s2', 'package.json'), why: 'Read directly from package.json; no model involved.' },
    ], 'claude-cli', []);
    const all = await f.listFacts({ projectKey: 'demo' });
    expect(all).toHaveLength(5);
    const page1 = await f.listFacts({ projectKey: 'demo', limit: 2 });
    const page2 = await f.listFacts({ projectKey: 'demo', limit: 2, offset: 2 });
    const page3 = await f.listFacts({ projectKey: 'demo', limit: 2, offset: 4 });
    expect([...page1, ...page2, ...page3].map((x) => x.id)).toEqual(all.map((x) => x.id));
    expect((await f.listFacts({ projectKey: 'demo', origin: 'model' })).map((x) => x.statement).sort()).toEqual(['m1', 'm2', 'older model']);
    expect((await f.listFacts({ projectKey: 'demo', origin: 'manifest' })).map((x) => x.statement).sort()).toEqual(['s1', 's2']);
    expect(await f.listFacts({ projectKey: 'demo', origin: 'document' })).toEqual([]);
  });

  test('facts checked by an older rule are listed for a recheck; the recheck closes failures and fixes the rest in place', async () => {
    await f.replaceProjectFacts('demo', [
      { ...fact('cites AGENTS.md', 'AGENTS.md'), origin: 'model' },
      { ...fact('lines were wrong', 'src/a.ts'), origin: 'model' },
      { ...fact('already current', 'src/b.ts'), origin: 'model', checkVersion: 'check-v2' },
      fact('older, never checked', 'src/c.ts'),
    ], 'claude-cli', []);
    await f.addOwnerFact('demo', { ...fact('yours'), embedding: vec(1) }, 'you');
    const stale = await f.factsToRecheck({ projectKey: 'demo', version: 'check-v2', limit: 10 });
    expect(stale.map((x) => x.statement)).toEqual(['cites AGENTS.md', 'lines were wrong', 'older, never checked']);
    expect(await f.factsToRecheck({ projectKey: 'demo', version: 'check-v2', limit: 1 })).toHaveLength(1);
    const by = Object.fromEntries(stale.map((x) => [x.statement, x]));
    const closed = await f.applyFactChecks('check-v2', [
      { id: by['cites AGENTS.md'].id, keep: false, lines: null, evidence: null },
      { id: by['lines were wrong'].id, keep: true, lines: null, evidence: 'file' },
      { id: by['older, never checked'].id, keep: true, lines: '1-5', evidence: 'line' },
    ]);
    expect(closed).toBe(1);
    expect(await f.factsToRecheck({ projectKey: 'demo', version: 'check-v2', limit: 10 })).toEqual([]);
    const now = Object.fromEntries((await f.listFacts({ projectKey: 'demo' })).map((x) => [x.statement, x]));
    expect(Object.keys(now).sort()).toEqual(['already current', 'lines were wrong', 'older, never checked', 'yours']);
    expect(now['lines were wrong']).toMatchObject({ lines: null, evidence: 'file', createdAt: by['lines were wrong'].createdAt });
    expect(now['older, never checked']).toMatchObject({ lines: '1-5', evidence: 'line' });
    expect(await probe.factVersions('cites AGENTS.md')).toEqual([{ current: false, closed: true }]);
    // A newer rule lists them all again.
    expect(await f.factsToRecheck({ projectKey: 'demo', version: 'check-v3', limit: 10 })).toHaveLength(3);
    // A rule may also reword a kept fact in place (a dependency list summarized), with its new embedding.
    const old = now['older, never checked'];
    await f.applyFactChecks('check-v3', [{ id: old.id, keep: true, lines: '1-5', evidence: 'line', statement: 'reworded', embedding: vec(5) }, { id: now['lines were wrong'].id, keep: true, lines: null, evidence: 'file' }]);
    const after = Object.fromEntries((await f.listFacts({ projectKey: 'demo' })).map((x) => [x.statement, x]));
    expect(after['reworded']).toMatchObject({ id: old.id, createdAt: old.createdAt, lines: '1-5', checkVersion: 'check-v3' });
    expect(after['lines were wrong']).toBeDefined();
    expect(after['older, never checked']).toBeUndefined();
    const [hit] = await f.searchFacts({ embedding: vec(5), projectKey: 'demo', k: 1 });
    expect(hit.fact.id).toBe(old.id);
  });

  test('files asked for a scan queue in request order, once each, until a scan clears them', async () => {
    expect(await f.requestFilesScan('demo', ['src/b.ts', 'src/a.ts'])).toBe(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(await f.requestFilesScan('demo', ['src/a.ts', 'src/c.ts'])).toBe(1);
    // Only repo-relative paths (scanRequestPaths).
    expect(await f.requestFilesScan('demo', ['../x.ts', '/etc/passwd', ''])).toBe(0);
    expect(await f.scanRequests('demo')).toEqual(['src/b.ts', 'src/a.ts', 'src/c.ts']);
    expect(await f.scanRequests('other')).toEqual([]);
    // A scanned file with facts can be asked for again later; asking does not touch its hash or facts.
    await f.saveFileFacts('demo', { path: 'src/d.ts', hash: 'hd', summary: '' }, [fact('d', 'src/d.ts')], 'p');
    expect(await f.requestFilesScan('demo', ['src/d.ts'])).toBe(1);
    expect((await f.fileHashes('demo')).get('src/d.ts')).toBe('hd');
    await f.clearScanRequests('demo', ['src/a.ts', 'src/d.ts', 'never/asked.ts']);
    expect(await f.scanRequests('demo')).toEqual(['src/b.ts', 'src/c.ts']);
    // A file only asked for has no hash: it is not mistaken for a scanned one.
    expect([...(await f.fileHashes('demo')).keys()]).toEqual(['src/d.ts']);
  });
});
