import type pg from 'pg';
import { authorizeStoreWrite, StoreDeadlineError, storeRequestSignal, storeWriteAuthorizationCheckpoint, storeTimeLeft, withRunClaimExecutor } from '@fb/core';
import type { Db } from './db.ts';
import { claimRunOwnerWith } from './runs.ts';

type Query = (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
/** The temporary owner and mutation share one transaction; false/no-row results leave no reservation. */
export async function conditionalWrite<T>(db: Db, fn: (query: Query) => Promise<T>, changed: (result: T) => boolean): Promise<T> {
  const reset = storeWriteAuthorizationCheckpoint();
  const timeout = storeTimeLeft();
  const expiresAt = Date.now() + timeout;
  const controller = new AbortController();
  const incoming = storeRequestSignal();
  const signal = incoming ? AbortSignal.any([controller.signal, incoming]) : controller.signal;
  const deadline = new StoreDeadlineError();
  let client: pg.PoolClient | undefined;
  let released = false;
  let closed = false;
  const release = (destroy = false) => { if (client && !released) { released = true; client.release(destroy); } };
  let rejectCancelled!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const cancel = () => { release(true); rejectCancelled(deadline); };
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(deadline), timeout);
  const remaining = () => {
    const ms = Math.min(storeTimeLeft(), expiresAt - Date.now());
    if (closed || signal.aborted || ms <= 0) throw deadline;
    return Math.max(1, Math.floor(ms));
  };
  try {
    remaining();
    const acquiring = db.pool.connect().then(connection => {
      if (signal.aborted) { connection.release(true); throw deadline; }
      client = connection;
      return connection;
    });
    const connection = await Promise.race([acquiring, cancelled]);
    remaining(); // A raw/custom pool may have waited past the request deadline.
    await Promise.race([connection.query('BEGIN'), cancelled]);
    const query: Query = async (text, values) => {
      // Utility SET LOCAL is snapshot-free, and PostgreSQL itself bounds statement/lock execution.
      await Promise.race([connection.query(`SET LOCAL statement_timeout = ${remaining()}`), cancelled]);
      remaining();
      return await Promise.race([connection.query(text, values), cancelled]);
    };
    const operation = async () => {
      await withRunClaimExecutor(db, (id, principal, actor) => claimRunOwnerWith(query, id, principal, actor), authorizeStoreWrite);
      const result = await fn(query);
      if (!changed(result)) { await connection.query('ROLLBACK'); reset(); return result; }
      remaining();
      await query('COMMIT');
      return result;
    };
    return await Promise.race([operation(), cancelled]);
  } catch (error) {
    if (client && !released) await Promise.race([client.query('ROLLBACK').catch(() => {}), cancelled.catch(() => {})]);
    reset();
    throw error;
  } finally {
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    release();
  }
}
