import type { GraphRepo } from './repo.ts';
import { claimRunOwnerWith } from './runs.ts';
import { authorizeStoreWrite, storeWriteAuthorizationCheckpoint, withRunClaimExecutor } from '../storeWrites.ts';
import { storeRequestSignal, storeTimeLeft } from '../storeDeadline.ts';

/** Claim and conditional mutation commit together; a no-op rolls both back, without a release race. */
export async function conditionalWrite<T>(g: GraphRepo, fn: (query: GraphRepo['run']) => Promise<T>, changed: (result: T) => boolean): Promise<T> {
  const reset = storeWriteAuthorizationCheckpoint();
  const session = g.driver.session();
  try {
    const tx = session.beginTransaction({ timeout: storeTimeLeft() });
    const signal = storeRequestSignal();
    const cancel = () => { void tx.rollback().catch(() => {}); void session.close().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    const query: GraphRepo['run'] = async (text, params = {}) => { storeTimeLeft(); return (await tx.run(text, params)).records; };
    try {
      storeTimeLeft();
      await withRunClaimExecutor(g, (id, principal, actor) => claimRunOwnerWith(query, id, principal, actor), authorizeStoreWrite);
      const result = await fn(query);
      if (!changed(result)) { await tx.rollback(); reset(); return result; }
      storeTimeLeft();
      await tx.commit();
      return result;
    } catch (error) { await tx.rollback().catch(() => {}); reset(); throw error; }
    finally { signal?.removeEventListener('abort', cancel); }
  } finally { await session.close(); }
}
