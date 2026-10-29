import { expect, test } from 'vitest';
import { describeStores } from '../testing/index.ts';

describeStores('targeted GitHub repair candidates', h => {
  test('pages only masked GitHub documents, leaving clean PRs and uploads out', async () => {
    const write = (ref: string, source: 'github' | 'upload', text: string) => h.store.docs.upsertDoc({ projectKey: 'repair', source, ref, title: ref, url: null }, [{ text, embedding: [1, 0] }]);
    const a = await write('github:acme/repo#1', 'github', 'Basic [REDACTED]');
    const b = await write('github:acme/repo#2', 'github', 'A literal [REDACTED] candidate needs source verification');
    await write('github:acme/repo#3', 'github', 'clean text');
    await write('local.md', 'upload', 'upload [REDACTED]');
    const first = await h.store.docs.githubRepairDocs!('repair', '', 1);
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe(a);
    expect(first[0].chunks).toEqual(['Basic [REDACTED]']);
    expect(await h.store.docs.githubDocChunks!(a)).toEqual(['Basic [REDACTED]']);
    expect(await h.store.docs.githubDocChunks!('missing')).toBeNull();
    expect((await h.store.docs.githubRepairDocs!('repair', first[0].id, 1)).map(row => row.id)).toEqual([b]);
  });
});
