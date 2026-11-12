import { ConfigError, redactSecrets, type Config, type Store } from '@fb/core';
import { unfinishedRestore } from './state.ts';

type Log = (msg: string, extra?: object) => void;

export const embedMismatch = (stored: string, configured: string) =>
  `OLLAMA_EMBED_MODEL is ${configured} but the stored vectors were embedded with ${stored}. Set it back to ${stored}, or re-embed: docker compose run --rm worker node src/reembed.ts`;

/**
 * The store, connected, its schema in place and its vectors made with the configured embedding model; scans and
 * documents left mid-read by a worker that died go back in the queue. A store that cannot be reached, or vectors of
 * another model, stop the start (the container restarts it; ConfigError says what to change).
 */
export async function openWorkerStore(config: Pick<Config, 'ollama' | 'stateDb'>, open: () => Promise<Store>, log: Log): Promise<Store> {
  // A restore cut short while it replaced the store and state/ leaves its marker in state/: never run on that pair.
  const restore = await unfinishedRestore(config.stateDb);
  if (restore) throw new Error(restore);
  const store = await open();
  await store.ensureSchema({ log });
  log('store', { store: store.kind });
  const emb = await store.embeddings.check(config.ollama.embedModel);
  if (!emb.ok) throw new ConfigError([embedMismatch(emb.stored, config.ollama.embedModel)]);
  await store.facts.requeueStaleScans();
  await store.docs.requeueStaleDocs();
  return store;
}

/** What a fatal start-up error logs: a ConfigError's own message (it names settings, never secrets), else redacted. */
export const fatalError = (err: unknown) => (err instanceof ConfigError ? err.message : redactSecrets(String(err)));

export type StartupPassDeps = {
  log: Log;
  /** Changed redaction rules over everything stored under older ones (redactStored.ts). */
  redactStored: () => Promise<unknown>;
  /** Ask answers; never while the redaction pass rewrites turns. */
  startChats: () => Promise<void>;
  /** Changed Inbox skip rules over what is pending (integrations/pendingSkips.ts): items skipped, null when not run. */
  skipPending: () => Promise<number | null>;
  /** The process-miss rule over past misses (postmortem/subjects.ts): null when not run. */
  sortOldMisses: () => Promise<object | null>;
  /** Only the owner's decisions mark a lesson as yours (postmortem/deciders.ts). */
  migrateDeciders: () => Promise<unknown>;
  /** The writer's draft for lessons edited before it was kept (postmortem/proposedAs.ts). */
  backfillProposedAs: () => Promise<unknown>;
  /** One-off repairs of data earlier versions stored wrong (repairs.ts). */
  repairs: () => Promise<void>;
  evidence: { load: () => Promise<void>; atStart: () => Promise<void> };
  /** Settle learning-loop decisions a crash left applying (decisions/apply.ts reconcileInFlight). */
  reconcileDecisions: () => Promise<{ applied: number; proposed: number; overridden: number }>;
};

/**
 * The once-per-rule passes over stored data, before the loop serves any of it again. Each failure is logged (redacted)
 * and the pass is tried again at the next start; the rest still run. Chats start only after the redaction pass. The
 * passes that read session evidence wait for the first ingest (evidence.ts) unless the evidence is already current.
 */
export async function runStartupPasses(d: StartupPassDeps): Promise<void> {
  const failed = (what: string) => (err: unknown) => d.log(what, { error: redactSecrets(String(err)) });
  // First: the loop must not decide on, or serve, a target whose decision is half recorded.
  await d.reconcileDecisions()
    .then((n) => { if (n.applied + n.proposed + n.overridden) d.log('learning loop decisions left applying settled', n); })
    .catch(failed('settling learning loop decisions left applying failed'));
  await d.redactStored().catch(failed('redaction over stored data failed'));
  await d.startChats();
  await d.skipPending()
    .then((n) => { if (n !== null) d.log('skip rules applied to pending Inbox items', { skipped: n }); })
    .catch(failed('skip rules over pending Inbox items failed'));
  await d.sortOldMisses()
    .then((n) => { if (n !== null) d.log('process-miss rule applied to past misses', n); })
    .catch(failed('process-miss rule over past misses failed'));
  await d.migrateDeciders().catch(failed('lesson decider rule failed'));
  await d.backfillProposedAs().catch(failed("writer's draft backfill failed"));
  await d.repairs().catch(failed('one-off repairs failed'));
  await d.evidence.load();
  await d.evidence.atStart();
}
