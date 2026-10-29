import { expect, test } from 'vitest';
import { describeStores } from '../testing/index.ts';
import { guardStore, LegacyRunClaimError, withStoreWriteAuthorizer } from '../storeWrites.ts';

/** The same real atomic contract on both databases, not an in-process ownership-map simulation. */
describeStores('lazy run ownership and conditional session writes', h => {
  const request = <T>(run: string, actor: string, fn: () => Promise<T>) => {
    const store = guardStore(h.store);
    return withStoreWriteAuthorizer(async () => {
      const owner = await store.runs.claim(run, 'operator', actor);
      if (owner.principal !== 'operator' || owner.actor !== actor) throw new Error('another caller owns the run');
    }, fn);
  };

  test('competing fresh labels bind one session and only the winner gets a RunOwner', async () => {
    const store = guardStore(h.store);
    const results = await Promise.all(['fresh-a', 'fresh-b'].map(run => request(run, run, async () => ({ run, ok: await store.sessions.claimRun('one-real-session', { id: run, sandbox: true }) }))));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    for (const result of results) expect(await store.runs.owner(result.run)).toEqual(result.ok ? expect.objectContaining({ run: result.run }) : null);
    expect(await store.sessions.runFor('one-real-session')).toEqual({ id: results.find(result => result.ok)!.run, sandbox: true });
  });

  test('competing capabilities on one fresh run never leave the loser session bound', async () => {
    const store = guardStore(h.store);
    const results = await Promise.allSettled(['caller-a', 'caller-b'].map(actor => request('one-run', actor, () => store.sessions.claimRun(actor, { id: 'one-run', sandbox: true }))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const owner = (await store.runs.owner('one-run'))!;
    expect(await store.sessions.runFor(owner.actor!)).toEqual({ id: 'one-run', sandbox: true });
    expect(await store.sessions.runFor(owner.actor === 'caller-a' ? 'caller-b' : 'caller-a')).toBeNull();
  });

  test('authorization failure after transactional ownership insert rolls back owner and binding', async () => {
    const store = guardStore(h.store);
    await expect(withStoreWriteAuthorizer(async () => {
      await store.runs.claim('rolled-back', 'operator', 'caller');
      throw new Error('refused before binding');
    }, () => store.sessions.claimRun('rolled-back-session', { id: 'rolled-back', sandbox: true }))).rejects.toThrow('refused before binding');
    expect(await store.runs.owner('rolled-back')).toBeNull();
    expect(await store.sessions.runFor('rolled-back-session')).toBeNull();
  });

  test('new writes cannot adopt legacy tagged records without an ownership capability', async () => {
    const store = guardStore(h.store);
    await store.knowledge.createManualFeedback({ project: { key: 'demo', name: 'demo', repoPath: '/demo' }, cwd: '/demo', text: 'legacy fixture', whatWasDone: 'fixture', run: { id: 'legacy-data', sandbox: true } });
    const before = await store.runs.items('legacy-data');
    await expect(request('legacy-data', 'caller', () => store.activity.record({ kind: 'context_served', actor: 'fixture', projectKey: 'demo', subject: 'must not appear', why: 'fixture', run: 'legacy-data' }))).rejects.toBeInstanceOf(LegacyRunClaimError);
    expect(await store.runs.owner('legacy-data')).toBeNull();
    expect(await store.runs.items('legacy-data')).toEqual(before);
  });

  test('legacy Activity-only and session-binding-only runs are protected too', async () => {
    const store = guardStore(h.store);
    await store.activity.record({ kind: 'context_served', actor: 'fixture', projectKey: null, subject: 'legacy', why: 'fixture', run: 'legacy-activity' });
    await store.sessions.claimRun('legacy-session', { id: 'legacy-binding', sandbox: true });
    for (const run of ['legacy-activity', 'legacy-binding']) {
      await expect(request(run, 'caller', () => store.activity.record({ kind: 'context_served', actor: 'fixture', projectKey: null, subject: 'must not appear', why: 'fixture', run }))).rejects.toBeInstanceOf(LegacyRunClaimError);
      expect(await store.runs.owner(run)).toBeNull();
    }
  });
});
