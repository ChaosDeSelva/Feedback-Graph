import { expect, test } from 'vitest';
import type { Store } from './store.ts';
import { guardStore, guardStoreMethods, LegacyRunClaimError, runClaimExecutor, STORE_WRITE_POLICY, withRunClaimExecutor, withStoreWriteAuthorizer } from './storeWrites.ts';

/** A store whose methods only record that they ran; the guard is what is under test. */
function fakeStore() {
  const calls: string[] = [];
  const fn = (name: string) => async () => { calls.push(name); return name; };
  const store = {
    ensureSchema: fn('ensureSchema'), ping: fn('ping'), close: fn('close'),
    chats: { addUserTurn: fn('chats.addUserTurn'), conversation: fn('chats.conversation'), retryTurn: fn('chats.retryTurn') },
    activity: { record: fn('activity.record'), list: fn('activity.list') },
    // a backend without code-graph support
    codegraph: undefined,
  } as unknown as Store;
  return { store, calls };
}

test('guardStore authorizes a write on the store and on each part, and never a read', async () => {
  const { store, calls } = fakeStore();
  const guarded = guardStore(store);
  let claims = 0;
  await withStoreWriteAuthorizer(async () => { claims++; }, async () => {
    await guarded.ping();
    await guarded.chats.conversation('c' as never);
    await guarded.activity.list({} as never);
    expect(claims).toBe(0);
    await guarded.chats.addUserTurn('c' as never, '' as never, {} as never);
    expect(claims).toBe(1);
    await guarded.ensureSchema();
  });
  expect(claims).toBe(1);
  expect(calls).toEqual(['ping', 'chats.conversation', 'activity.list', 'chats.addUserTurn', 'ensureSchema']);
  expect(guarded.codegraph).toBeUndefined();
});

test('an internal method runs inside the request without claiming it', async () => {
  const { store, calls } = fakeStore();
  const guarded = guardStore(store);
  let claims = 0;
  await withStoreWriteAuthorizer(async () => { claims++; }, () => guarded.chats.retryTurn('c' as never, 't' as never));
  expect(claims).toBe(0);
  expect(calls).toEqual(['chats.retryTurn']);
});

test('a refused claim stops a write on a part before it runs', async () => {
  const { store, calls } = fakeStore();
  const guarded = guardStore(store);
  await expect(withStoreWriteAuthorizer(async () => { throw new Error('not yours'); }, () => guarded.activity.record({} as never))).rejects.toThrow('not yours');
  expect(calls).toEqual([]);
});

test('guarding the same object (or its guard) with the same policy gives the same proxy', () => {
  const target = { record: async () => {} };
  const a = guardStoreMethods(target, STORE_WRITE_POLICY.activity);
  expect(guardStoreMethods(target, STORE_WRITE_POLICY.activity)).toBe(a);
  expect(guardStoreMethods(a, STORE_WRITE_POLICY.activity)).toBe(a);
  expect(guardStoreMethods(target, STORE_WRITE_POLICY.runs)).not.toBe(a);
});

test('a run claim executor is visible only for its own store, only inside the call', async () => {
  const store = {};
  const claim = async () => ({ kind: 'owner' }) as never;
  expect(runClaimExecutor(store)).toBeUndefined();
  await withRunClaimExecutor(store, claim, async () => {
    await Promise.resolve();
    expect(runClaimExecutor(store)).toBe(claim);
    expect(runClaimExecutor({})).toBeUndefined();
  });
  expect(runClaimExecutor(store)).toBeUndefined();
});

test('LegacyRunClaimError names the run and the way out', () => {
  const e = new LegacyRunClaimError('r1');
  expect(e.name).toBe('LegacyRunClaimError');
  expect(e.message).toMatch(/run r1 has legacy records/);
  expect(e.message).toMatch(/owner-authorized cleanup/);
});
