import { beforeAll, expect, test } from 'vitest';
import type { LinksStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import { linkIdOf, type LinkEvidence } from './links.ts';

const ev = (detail: string, from = 'game'): LinkEvidence => ({ signal: 'manifest', detail, path: 'package.json', from });

describeStores('LinksStore', (h) => {
  let l: LinksStore;
  beforeAll(() => {
    l = h.store.links;
  });

  test('one link per pair, whichever way round it is named', async () => {
    expect(linkIdOf('b', 'a')).toBe(linkIdOf('a', 'b'));
    await l.replaceDetected(['game', 'api'], [{ a: 'game', b: 'api', relation: 'depends_on', score: 0.9, evidence: [ev('game depends on @me/api')] }]);
    const [link] = await l.listLinks({});
    expect(link).toMatchObject({ id: linkIdOf('api', 'game'), a: 'api', b: 'game', relation: 'depends_on', status: 'suggested', source: 'detected', score: 0.9, note: '' });
    expect(link.evidence).toEqual([ev('game depends on @me/api')]);
  });

  test('replaceDetected refreshes suggestions, drops ones whose evidence is gone, and never touches your decisions', async () => {
    await l.replaceDetected(['a', 'b', 'c', 'd'], [
      { a: 'a', b: 'b', relation: 'related', score: 0.5, evidence: [ev('one')] },
      { a: 'a', b: 'c', relation: 'related', score: 0.5, evidence: [ev('two')] },
      { a: 'c', b: 'd', relation: 'related', score: 0.5, evidence: [ev('three')] },
    ]);
    await l.setLink('a', 'c', { status: 'confirmed', note: 'client and server' });
    await l.setLink('c', 'd', { status: 'dismissed' });
    // Next round: a-b now has stronger evidence, a-c and c-d have none any more.
    const fresh = await l.replaceDetected(['a', 'b', 'c', 'd'], [{ a: 'b', b: 'a', relation: 'depends_on', score: 0.9, evidence: [ev('stronger')] }]);
    expect(fresh).toBe(0);
    const byId = Object.fromEntries((await l.listLinks({})).map((x) => [x.id, x]));
    expect(byId[linkIdOf('a', 'b')]).toMatchObject({ status: 'suggested', relation: 'depends_on', score: 0.9, evidence: [ev('stronger')] });
    expect(byId[linkIdOf('a', 'c')]).toMatchObject({ status: 'confirmed', note: 'client and server', relation: 'related' });
    expect(byId[linkIdOf('c', 'd')]).toMatchObject({ status: 'dismissed' });
    // Evidence found again for a decided link refreshes its evidence only.
    await l.replaceDetected(['a', 'c'], [{ a: 'a', b: 'c', relation: 'depends_on', score: 0.9, evidence: [ev('new proof')] }]);
    expect((await l.listLinks({})).find((x) => x.id === linkIdOf('a', 'c'))).toMatchObject({ status: 'confirmed', relation: 'related', note: 'client and server', evidence: [ev('new proof')] });
  });

  test('replaceDetected only drops suggestions between the projects it looked at, and counts new ones', async () => {
    expect(await l.replaceDetected(['x', 'y'], [{ a: 'x', b: 'y', relation: 'related', score: 0.6, evidence: [ev('e')] }])).toBe(1);
    expect(await l.replaceDetected(['x', 'y'], [{ a: 'x', b: 'y', relation: 'related', score: 0.6, evidence: [ev('e')] }])).toBe(0);
    await l.replaceDetected(['p', 'q'], []);
    expect((await l.listLinks({})).map((x) => x.id)).toEqual([linkIdOf('x', 'y')]);
  });

  test('setLink creates a link by hand, and listLinks filters by project and by the projects you can see', async () => {
    const made = await l.setLink('web', 'api', { status: 'confirmed', relation: 'same_product', note: 'the site calls the api' });
    expect(made).toMatchObject({ a: 'api', b: 'web', status: 'confirmed', source: 'you', relation: 'same_product', evidence: [] });
    await l.setLink('api', 'tools', { status: 'confirmed' });
    expect((await l.listLinks({ projectKey: 'web' })).map((x) => x.b)).toEqual(['web']);
    expect((await l.listLinks({ projectKey: 'api' })).length).toBe(2);
    // Both ends must be visible.
    expect((await l.listLinks({ projectKeys: ['api', 'web'] })).map((x) => x.id)).toEqual([linkIdOf('api', 'web')]);
    expect(await l.listLinks({ projectKeys: [] })).toEqual([]);
  });

  test('setLink records who decided it; a detected suggestion has nobody until a decision', async () => {
    await l.replaceDetected(['m', 'n'], [{ a: 'm', b: 'n', relation: 'related', score: 0.6, evidence: [ev('e')] }]);
    expect((await l.listLinks({ projectKey: 'm' }))[0].decidedBy).toBeNull();
    expect(await l.setLink('m', 'n', { status: 'confirmed', decidedBy: 'operator:codex' })).toMatchObject({ status: 'confirmed', decidedBy: 'operator:codex' });
    // An edit without a name keeps the last one; the next decision replaces it.
    expect((await l.setLink('m', 'n', { note: 'shared types' })).decidedBy).toBe('operator:codex');
    expect((await l.setLink('m', 'n', { status: 'dismissed', decidedBy: 'you' })).decidedBy).toBe('you');
    expect((await l.setLink('m', 'o', { status: 'confirmed', decidedBy: 'you' })).decidedBy).toBe('you');
  });

  test('setLink records who decided it; a detected suggestion has nobody until a decision', async () => {
    await l.replaceDetected(['m', 'n'], [{ a: 'm', b: 'n', relation: 'related', score: 0.6, evidence: [ev('e')] }]);
    expect((await l.listLinks({ projectKey: 'm' }))[0].decidedBy).toBeNull();
    expect(await l.setLink('m', 'n', { status: 'confirmed', decidedBy: 'operator:codex' })).toMatchObject({ status: 'confirmed', decidedBy: 'operator:codex' });
    // An edit that names nobody keeps the last name; the next decision replaces it.
    expect((await l.setLink('m', 'n', { note: 'shared types' })).decidedBy).toBe('operator:codex');
    expect((await l.setLink('m', 'n', { status: 'dismissed', decidedBy: 'you' })).decidedBy).toBe('you');
    expect((await l.setLink('m', 'o', { status: 'confirmed', decidedBy: 'you' })).decidedBy).toBe('you');
  });

  test('a link to itself is refused; notes are redacted; deleteLink removes it', async () => {
    await expect(l.setLink('a', 'a', { status: 'confirmed' })).rejects.toThrow();
    const key = `ghp_${'E'.repeat(36)}`;
    const made = await l.setLink('a', 'b', { status: 'confirmed', note: `token ${key}` });
    expect(made.note).not.toContain(key);
    expect(await l.deleteLink(made.id)).toBe(true);
    expect(await l.deleteLink(made.id)).toBe(false);
    expect(await l.listLinks({})).toEqual([]);
  });

  test("deleting a project removes its links", async () => {
    await l.setLink('gone', 'stay', { status: 'confirmed' });
    await l.setLink('stay', 'other', { status: 'confirmed' });
    await h.store.portability.deleteProject('gone');
    expect((await l.listLinks({})).map((x) => x.id)).toEqual([linkIdOf('other', 'stay')]);
  });
});
