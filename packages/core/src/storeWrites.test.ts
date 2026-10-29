import { expect, test } from 'vitest';
import { authorizeStoreWrite, storeWriteAuthorizationCheckpoint, guardStoreMethods, STORE_WRITE_POLICY, withStoreWriteAuthorizer } from './storeWrites.ts';

test('reads never authorize; concurrent writes share one claim and execute only after it', async () => {
  const order: string[] = [];
  let claims = 0;
  const store = guardStoreMethods({ list: async () => [], record: async (id: string) => { order.push(id); } }, STORE_WRITE_POLICY.activity);
  await withStoreWriteAuthorizer(async () => { claims++; order.push('claim'); }, async () => {
    await store.list(); expect(claims).toBe(0);
    await Promise.all([store.record('a'), store.record('b')]);
  });
  expect(claims).toBe(1); expect(order).toEqual(['claim', 'a', 'b']);
});

test('failed authorization never invokes the mutation', async () => {
  let writes = 0;
  const store = guardStoreMethods({ record: async () => { writes++; } }, STORE_WRITE_POLICY.activity);
  await expect(withStoreWriteAuthorizer(async () => { throw new Error('other caller'); }, () => store.record())).rejects.toThrow('other caller');
  expect(writes).toBe(0);
});

test('a nested different request authorizer is not bypassed by outer writer reentrancy', async () => {
  let innerClaims = 0;
  const inner = guardStoreMethods({ record: async () => {} }, STORE_WRITE_POLICY.activity);
  const outer = guardStoreMethods({ record: async () => withStoreWriteAuthorizer(async () => { innerClaims++; }, () => inner.record()) }, STORE_WRITE_POLICY.activity);
  await withStoreWriteAuthorizer(async () => {}, () => outer.record());
  expect(innerClaims).toBe(1);
});

test('same-request nested semantic mutations do not deadlock or claim twice', async () => {
  let claims = 0;
  const inner = guardStoreMethods({ record: async () => {} }, STORE_WRITE_POLICY.activity);
  const outer = guardStoreMethods({ record: async () => inner.record() }, STORE_WRITE_POLICY.activity);
  await withStoreWriteAuthorizer(async () => { claims++; }, () => outer.record());
  expect(claims).toBe(1);
});

test('conditional adapters choose when to authorize, so false claims remain read-only', async () => {
  let claims = 0;
  const store = guardStoreMethods({ claimRun: async (ok: boolean) => { if (ok) await authorizeStoreWrite(); return ok; } }, STORE_WRITE_POLICY.sessions);
  await withStoreWriteAuthorizer(async () => { claims++; }, async () => {
    expect(await store.claimRun(false)).toBe(false); expect(claims).toBe(0);
    expect(await store.claimRun(true)).toBe(true);
  });
  expect(claims).toBe(1);
});


test('conditional rollback invalidates only authorization created by that transaction', async () => {
  for (const previouslyDurable of [false, true]) {
    let claims = 0;
    const store = guardStoreMethods({ record: async () => {} }, STORE_WRITE_POLICY.activity);
    await withStoreWriteAuthorizer(async () => { claims++; }, async () => {
      if (previouslyDurable) await store.record();
      const reset = storeWriteAuthorizationCheckpoint();
      await authorizeStoreWrite(); reset();
      await store.record();
    });
    expect(claims).toBe(previouslyDurable ? 1 : 2);
  }
});
