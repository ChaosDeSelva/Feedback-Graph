import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, integrationsApi, NETWORK_EVENT, WRITE_RETRY_DELAYS_MS, type NetworkState } from './api.ts';

let states: NetworkState[];
const onState = (e: Event) => states.push((e as CustomEvent<NetworkState>).detail);

beforeEach(() => {
  states = [];
  vi.useFakeTimers();
  window.addEventListener(NETWORK_EVENT, onState);
});
afterEach(() => {
  window.removeEventListener(NETWORK_EVENT, onState);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** fetch that fails like a restarting server (TypeError: Failed to fetch) `failures` times, then answers 204. */
function flaky(failures: number) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (calls.length <= failures) throw new TypeError('Failed to fetch');
    return new Response(null, { status: 204 });
  }));
  return calls;
}

test('a write that cannot reach the API (restarting) is retried, and says so while it waits', async () => {
  const calls = flaky(2);
  const done = api.decide('c1', 'confirmed');
  await vi.runAllTimersAsync();
  await expect(done).resolves.toBeUndefined();
  expect(calls).toEqual(Array(3).fill('/api/candidates/c1/decision'));
  expect(states.map((s) => s.state)).toEqual(['retrying', 'retrying', 'ok']);
  expect(states[0]).toMatchObject({ attempt: 1, of: WRITE_RETRY_DELAYS_MS.length });
});

test('after the last retry the write fails visibly: the change was not saved', async () => {
  const calls = flaky(99);
  const done = api.updateLesson('l1', { status: 'approved' });
  const settled = expect(done).rejects.toThrow(/could not reach the Feedback Graph API.*not saved/i);
  await vi.runAllTimersAsync();
  await settled;
  expect(calls).toHaveLength(WRITE_RETRY_DELAYS_MS.length + 1);
  expect(states.at(-1)).toMatchObject({ state: 'failed' });
});

test('an answer from the server (even an error) is never retried', async () => {
  const fetch = vi.fn(async () => Response.json({ error: 'only you can make this decision' }, { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  await expect(integrationsApi.test('github')).rejects.toThrow('only you can make this decision');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(states).toEqual([]);
});

test('an upload is not retried blindly (it could be stored twice); it fails with the same plain message', async () => {
  const calls = flaky(99);
  const done = api.uploadDoc('demo', { title: 't', name: 'n.md', text: 'x' });
  const settled = expect(done).rejects.toThrow(/could not reach the Feedback Graph API/i);
  await vi.runAllTimersAsync();
  await settled;
  expect(calls).toHaveLength(1);
});

test('a delete, a cleanup or a cloud sync is not retried either: the first try may have gone through', async () => {
  for (const write of [() => api.deleteProject('demo'), () => api.deleteDoc('d1'), () => api.deleteLink('link:a|b'), () => api.cleanupUnselected(), () => api.syncCloud()]) {
    const calls = flaky(99);
    const settled = expect(write()).rejects.toThrow(/could not reach the Feedback Graph API/i);
    await vi.runAllTimersAsync();
    await settled;
    expect(calls).toHaveLength(1);
  }
});
