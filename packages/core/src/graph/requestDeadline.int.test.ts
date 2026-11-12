import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { StoreDeadlineError, withStoreDeadline } from '../storeDeadline.ts';
import { describeStores } from '../testing/index.ts';

/** Start fn under a request deadline and cancel the request at once, as a client hanging up mid-call does. */
function cancelled<T>(fn: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const pending = withStoreDeadline({ signal: controller.signal, expiresAt: Date.now() + 30_000 }, fn);
  controller.abort();
  return pending;
}

describeStores('Request deadlines', (h) => {
  let s: Store;
  beforeAll(() => {
    s = h.store;
  });

  test('a conditional write whose request is cancelled while it runs is rolled back, and the store stays usable', async () => {
    const job = await s.facts.requestScan({ key: 'demo', name: 'demo', repoPath: '/vibe/demo' }, 'codex-cli');
    await expect(cancelled(() => s.facts.claimQueuedScan(job.id))).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(await s.facts.scanJob(job.id)).toMatchObject({ status: 'queued' });
    expect(await s.facts.claimQueuedScan(job.id)).toBe(true);
  });

  test('a read whose request is cancelled while it runs says the deadline passed, and the store stays usable', async () => {
    const job = await s.facts.requestScan({ key: 'demo', name: 'demo', repoPath: '/vibe/demo' }, 'codex-cli');
    await expect(cancelled(() => s.facts.scanJob(job.id))).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(await s.ping()).toBe(true);
    expect((await s.facts.scanJob(job.id))?.id).toBe(job.id);
  });

  test('a session claim or an exclusive section whose request is cancelled says the deadline passed and leaves nothing behind', async () => {
    await expect(cancelled(() => s.sessions.claimRun('s1', { id: 'run-1', sandbox: false }))).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(await s.sessions.runFor('s1')).toBeNull();
    let ran = false;
    await expect(cancelled(() => s.selection.exclusive(async () => { ran = true; }))).rejects.toBeInstanceOf(StoreDeadlineError);
    expect(ran).toBe(false);
    expect(await s.selection.exclusive(async () => 'free')).toBe('free');
  });
});
