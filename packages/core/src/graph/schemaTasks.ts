import { randomUUID } from 'node:crypto';
import { retryDeadlock, type GraphRepo } from './repo.ts';

/** How long a holder may go without renewing its lease before another process takes the task over. */
export const SCHEMA_LEASE_MS = 60_000;
const RENEW_MS = SCHEMA_LEASE_MS / 4;

/** Takes the node's write lock before any read of it, so two claims never both see it free. */
const LOCK = 'SET t._lock = coalesce(t._lock, 0) + 1 REMOVE t._lock';

/**
 * A lease on a (:SchemaTask {id}) node. The api and the worker open one store and start together; a task under a
 * lease is run by one of them at a time, and a one-off task marked done is not run again.
 */
export class SchemaLease {
  readonly me = randomUUID();
  readonly g: GraphRepo;
  readonly id: string;
  readonly now: () => number;

  constructor(g: GraphRepo, id: string, now: () => number = Date.now) {
    this.g = g;
    this.id = id;
    this.now = now;
  }

  /** The lease, when no other process holds a live one and the task is not done; with the cursor it left. */
  async claim(): Promise<{ cursor: string | null } | null> {
    const [r] = await retryDeadlock(() => this.g.run(
      `MERGE (t:SchemaTask {id: $id}) ${LOCK}
       WITH t WHERE NOT coalesce(t.done, false) AND (t.owner IS NULL OR t.owner = $me OR t.beat < $stale)
       SET t.owner = $me, t.beat = $now RETURN t.cursor AS cursor`,
      { id: this.id, me: this.me, now: this.now(), stale: this.now() - SCHEMA_LEASE_MS },
    ));
    return r ? { cursor: r.get('cursor') ?? null } : null;
  }

  /** Renews the lease; false when another process took it over. */
  async renew(): Promise<boolean> {
    const [r] = await this.g.run('MATCH (t:SchemaTask {id: $id}) WHERE t.owner = $me SET t.beat = $now RETURN count(t) AS n', { id: this.id, me: this.me, now: this.now() });
    return Number(r?.get('n') ?? 0) > 0;
  }

  /** Gives the lease up, marking the task done when `done`. */
  async release(done = false): Promise<void> {
    await this.g.run('MATCH (t:SchemaTask {id: $id}) WHERE t.owner = $me SET t.owner = null, t.done = $done OR coalesce(t.done, false)', { id: this.id, me: this.me, done });
  }

  async done(): Promise<boolean> {
    const [r] = await this.g.run('OPTIONAL MATCH (t:SchemaTask {id: $id}) RETURN coalesce(t.done, false) AS done', { id: this.id });
    return r?.get('done') === true;
  }
}

/**
 * fn, run while this process holds the `id` lease: it waits (polling every `pollMs`) while another process holds it,
 * and renews it while fn runs, so a slow fn keeps it and a holder that died loses it within SCHEMA_LEASE_MS.
 */
export async function underLease<T>(g: GraphRepo, id: string, fn: () => Promise<T>, pollMs = 500): Promise<T> {
  const lease = new SchemaLease(g, id);
  while (!(await lease.claim())) await new Promise((r) => setTimeout(r, pollMs));
  const renew = setInterval(() => { void lease.renew().catch(() => {}); }, RENEW_MS);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await lease.release();
  }
}
