import { beforeAll, expect, test } from 'vitest';
import type { FactsStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { CodeFact } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const fact = (statement: string, path = 'src/a.ts'): CodeFact & { embedding: number[] } => ({
  kind: 'convention', statement, path, lines: '1-5', confidence: 0.9, why: `agents need: ${statement}`, embedding: vec(1),
});
const project = (key: string) => ({ key, name: key, repoPath: `/vibe/${key}` });

describeStores('FactsStore scan queue', (h) => {
  let f: FactsStore;
  beforeAll(() => {
    f = h.store.facts;
  });

  test('a scan left running by a worker that died is queued again at startup; finished and failed scans stay as they are', async () => {
    const running = await f.requestScan(project('a'), 'codex-cli');
    const done = await f.requestScan(project('b'), 'codex-cli');
    const failed = await f.requestScan(project('c'), 'codex-cli');
    expect(await f.claimQueuedScan(running.id)).toBe(true);
    await f.updateScanJob(done.id, { status: 'done' });
    await f.updateScanJob(failed.id, { status: 'failed', error: 'boom' });
    expect(await f.nextScanJob()).toBeNull();

    await f.requeueStaleScans();
    expect(await f.scanJob(running.id)).toMatchObject({ status: 'queued' });
    expect(await f.scanJob(done.id)).toMatchObject({ status: 'done' });
    expect(await f.scanJob(failed.id)).toMatchObject({ status: 'failed', error: 'boom' });
    expect((await f.nextScanJob())?.id).toBe(running.id);
    expect(await f.claimQueuedScan(running.id)).toBe(true);
  });

  test('batch writes given nothing to do change nothing and say so', async () => {
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h', summary: '' }, [fact('kept')], 'p');
    expect(await f.requestFilesScan('demo', ['src/a.ts'])).toBe(1);
    await f.markFilesRemoved('demo', []);
    await f.clearScanRequests('demo', []);
    expect(await f.applyFactChecks('v2', [])).toBe(0);
    expect(await f.setFactRelevance([])).toBe(0);
    expect((await f.listFacts({ projectKey: 'demo' })).map((x) => x.statement)).toEqual(['kept']);
    expect(await f.fileHashes('demo')).toEqual(new Map([['src/a.ts', 'h']]));
    expect(await f.scanRequests('demo')).toEqual(['src/a.ts']);
  });
});
