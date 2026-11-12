import { beforeAll, expect, test } from 'vitest';
import type { CodeGraphStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';

const map = { files: [{ path: 'src/a.ts', lang: 'typescript', hash: 'sha-a', loc: 3, isTest: false }], symbols: [], imports: [], tests: [], churn: {}, fingerprint: 'head:1' };
const t0 = new Date('2026-10-01T10:00:00.000Z');

describeStores('CodeGraphStore failures', (h) => {
  let c: CodeGraphStore;
  beforeAll(() => {
    c = h.store.codegraph;
  });

  test('a failed rebuild is kept on the map it failed to replace, redacted and cut short, until a build succeeds', async () => {
    await c.replaceCodeMap('demo', map);
    const built = (await c.codeMapMeta('demo'))!;
    const secret = `ghp_${'D'.repeat(36)}`;
    await c.recordCodeMapFailure('demo', `git fetch https://x:${secret}@github.com/me/demo failed ${'.'.repeat(600)}`, t0);
    const failed = (await c.codeMapMeta('demo'))!;
    expect(failed).toMatchObject({ builtAt: built.builtAt, fingerprint: 'head:1', stats: built.stats, lastFailureAt: t0.toISOString() });
    expect(failed.lastFailure).not.toContain(secret);
    expect(failed.lastFailure).toContain('[REDACTED]');
    expect(failed.lastFailure!.length).toBeLessThanOrEqual(500);
    // The previous map stays in use.
    expect((await c.codeMap('demo'))?.files.map((f) => f.path)).toEqual(['src/a.ts']);
    await c.replaceCodeMap('demo', { ...map, fingerprint: 'head:2' });
    expect(await c.codeMapMeta('demo')).toMatchObject({ fingerprint: 'head:2', lastFailureAt: null, lastFailure: null });
  });

  test('a first build that fails leaves no map behind: nothing claims a map was built', async () => {
    await c.recordCodeMapFailure('fresh', 'parse failed', t0);
    expect(await c.codeMapMeta('fresh')).toBeNull();
    expect(await c.codeMap('fresh')).toBeNull();
    expect(await c.codeMapRebuildsRequested()).toEqual([]);
    expect(await c.dropCodeMap('fresh')).toBe(false);
  });

  test('purgeOrphanCodeFiles with no budget deletes nothing', async () => {
    await c.replaceCodeMap('demo', map);
    await c.replaceCodeMap('demo', { ...map, files: [] });
    expect(await c.purgeOrphanCodeFiles(0)).toBe(0);
    expect(await c.purgeOrphanCodeFiles(Number.NaN)).toBe(0);
  });
});
