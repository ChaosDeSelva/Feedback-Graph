import { beforeAll, expect, test } from 'vitest';
import { describeStores, type StoreProbe } from './index.ts';

// The probes themselves must agree across backends before any contract suite can trust them.
describeStores('StoreProbe', (h) => {
  let probe: StoreProbe;
  beforeAll(() => {
    probe = h.probe;
  });

  test('seeded embedded records read back by id, kind and vector; wipe removes them', async () => {
    await probe.seedEmbedded({ kind: 'Lesson', id: 'l', title: 'T', rule: 'R', appliesWhen: 'A', embedding: [1, 0] });
    await probe.seedEmbedded({ kind: 'Miss', id: 'm', missed: 'M', causeExplanation: 'C', embedding: [0.5, 0.25] });
    await probe.seedEmbedded({ kind: 'Fact', id: 'f', path: 'a.ts', statement: 'S', current: false, embedding: [3] });
    await probe.seedEmbedded({ kind: 'Chunk', id: 'c', text: 'chunk text', embedding: [0, 1, 0] });
    expect(await probe.embeddings()).toEqual({ c: [0, 1, 0], f: [3], l: [1, 0], m: [0.5, 0.25] });
    expect(await probe.ids('Lesson')).toEqual(['l']);
    expect(await probe.count('Miss')).toBe(1);
    expect(await probe.factVersions('S')).toEqual([{ current: false, closed: false }]);
    const chunks = JSON.stringify(await probe.rows('Chunk'));
    expect(chunks).toContain('chunk text');
    expect(chunks).not.toContain('embedding');
    await probe.wipe();
    expect(await probe.embeddings()).toEqual({});
    expect(await probe.count('Lesson')).toBe(0);
  });

  test('orphans are filed under their key without a project of their own', async () => {
    await probe.seedOrphan({ kind: 'Lesson', id: 'l1', projectKey: 'b' });
    await probe.seedOrphan({ kind: 'Doc', id: 'd1', projectKey: 'b' });
    expect(await probe.filedUnder('b')).toEqual(['Doc', 'Lesson']);
    expect(await probe.filedUnder('nope')).toEqual([]);
    expect(await probe.project('b')).toBeNull();
    expect(await probe.ids('Project')).toEqual([]);
  });

  test('reads of records that do not exist are empty, not errors', async () => {
    expect(await probe.turn('t')).toBeNull();
    expect(await probe.sessionSource('s')).toBeNull();
    expect(await probe.feedbackStatus('f')).toBeNull();
    expect(await probe.preDoneChecks()).toEqual([]);
    expect(await probe.factVersions('x')).toEqual([]);
    await probe.setProject('ghost', { remote: 'r' });
    expect(await probe.project('ghost')).toBeNull();
  });
});
