import { redactSecrets, type WorkerStatus } from '@fb/core';
import type { CycleResult } from './cycle.ts';
import type { SessionEvidenceGate } from './evidence.ts';
import { cycleProgressed, type StageTracker } from './progress.ts';

type Log = (msg: string, extra?: object) => void;
type PostmortemRound = { done: number; failed: number; unavailable?: string };

/** The steps of the worker loop (main.ts wires them to the store, the stages and the providers). */
export type WorkerLoopDeps = {
  status: WorkerStatus;
  stage: Pick<StageTracker, 'enter'>;
  log: Log;
  stopping: () => boolean;
  /** Wait between wakes; ends early when shutdown begins. */
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  // Once per wake, before the rounds (kickMapStage between rounds too).
  refreshScope: () => Promise<void>;
  refreshProjectLayout: () => Promise<void>;
  /** Also after each round that goes again, so a requested rebuild is not held behind a backlog. */
  kickMapStage: () => void;
  refreshCandidates: () => Promise<void>;
  forgetDeletedReads: () => Promise<void>;
  syncGithubDocs: () => Promise<void>;
  syncFeedback: () => Promise<void>;
  /** Link detection, beside the loop (never awaited). */
  detectLinks: () => void;
  /** Contradiction detection (knowledge intake), beside the loop (never awaited); unset while intake is off. */
  detectConflicts?: () => void;
  retention: () => Promise<void>;
  evidence: Pick<SessionEvidenceGate, 'ready' | 'recheck' | 'settled' | 'afterIngest'>;
  // Each round.
  /** Cloud sync, beside the loop: a slow or retrying cloud never holds up ingest. */
  cloudTick: () => void;
  kickScans: () => void;
  scansRunning: () => number;
  readDocOne: () => Promise<boolean>;
  /** Null: no post-mortem model could be built. */
  postmortems: (() => Promise<PostmortemRound>) | null;
  /** One round of the lesson-trigger backfill (postmortem/triggers.ts): lessons done. Null: no post-mortem model. */
  lessonTriggers: (() => Promise<number>) | null;
  cycle: () => Promise<CycleResult>;
  kickSummaries: () => void;
  /** The relevance backfill: one batch, facts scored. */
  scoreSome: () => Promise<number>;
  // After the rounds.
  importMemories: () => Promise<number>;
  /** The learning loop, beside the loop (never awaited): a round when the worker is idle (loop/stage.ts). */
  learningLoop: () => void;
};

/**
 * One round: work you asked for (scans, uploads, post-mortems) first, then ingest and classification, then the
 * relevance backfill only when nothing else moved. True when it made progress you are waiting for (go again now).
 */
export async function runRound(d: WorkerLoopDeps): Promise<boolean> {
  await d.refreshScope();
  d.cloudTick();
  await d.forgetDeletedReads();
  d.kickScans();
  const scanned = d.scansRunning();
  const docRead = await d.readDocOne();
  // Post-mortems read the session evidence too: they wait for this start's first ingest and the passes after it.
  const settling = !d.evidence.settled();
  const pm = d.postmortems && !settling ? await d.postmortems() : { done: 0, failed: 0, unavailable: undefined };
  // Lessons stored without triggers get them, a few a round, once the post-mortems (the same model) have nothing to do.
  const triggered = d.lessonTriggers && !settling && !pm.done && !pm.failed && !pm.unavailable
    ? await d.lessonTriggers().catch((err) => { d.log('lesson trigger backfill failed', { error: redactSecrets(String(err)) }); return 0; })
    : 0;
  const { classifierUnavailable, ...r } = await d.cycle();
  // The transcripts were read through: what judges stored data against them can run now (once per start).
  await d.evidence.afterIngest();
  d.kickSummaries();
  d.log('cycle', { ...r, postmortems: pm.done, postmortemFailures: pm.failed, scanned, classifierUnavailable, postmortemUnavailable: pm.unavailable });
  d.status.lastCycleAt = new Date().toISOString();
  d.status.lastCycle = { ...r, postmortems: pm.done, postmortemFailures: pm.failed, scanned };
  d.status.lastError = classifierUnavailable ? `classifier unavailable: ${classifierUnavailable}`
    : pm.unavailable ? `post-mortem model unavailable: ${pm.unavailable}` : null;
  // Last in line: only when this round had nothing else to do.
  const scored = r.turnsClassified > 0 || pm.done > 0 || triggered > 0 || docRead ? 0 : await d.scoreSome();
  if (scored) d.log('relevance backfill', { scored });
  // Failures back off on their own schedule; only real progress keeps the loop from sleeping. Scans are not counted:
  // they run beside the loop and refill their own slots as they finish. Nor is the relevance backfill. The round that
  // let post-mortems through goes straight on to them.
  const again = cycleProgressed({ turnsClassified: r.turnsClassified, postmortems: pm.done + triggered, docRead, scored }) || (settling && !!d.postmortems);
  // A map rebuild you asked for while a backlog (documents, post-mortems) keeps the rounds going is started between
  // them, not after the backlog drains: a no-op while a map pass runs.
  if (again) d.kickMapStage();
  return again;
}

/**
 * One wake: refresh what the rounds read, sync integrations, then rounds while they progress, then memory notes, then
 * the learning loop.
 */
export async function runWake(d: WorkerLoopDeps): Promise<void> {
  await d.refreshScope();
  await d.refreshProjectLayout();
  d.kickMapStage();
  await d.refreshCandidates();
  await d.forgetDeletedReads();
  // Each fails on its own: GitHub or Linear being down never holds up reading transcripts.
  d.stage.enter('sync');
  await d.syncGithubDocs().catch((err) => d.log('github sync failed', { error: redactSecrets(String(err)) }));
  await d.syncFeedback().catch((err) => d.log('comment sync failed', { error: redactSecrets(String(err)) }));
  d.detectLinks();
  d.detectConflicts?.();
  await d.retention();
  if (d.evidence.ready()) await d.evidence.recheck();
  // Keep going without sleeping while there is still work: backfill, post-mortems, scans. The learning loop is
  // offered a round between them (it starts one only when it is due and idle), so a long backlog, such as an
  // upgrade's lessons waiting for triggers, never holds its catch-up back.
  while ((await runRound(d)) && !d.stopping()) d.learningLoop();
  // Classify transcript feedback before importing notes written in response to that feedback.
  const imported = await d.importMemories();
  if (imported) d.log('memory lessons imported', { imported });
  d.learningLoop();
}

/**
 * The worker loop until shutdown. A wake that fails (the store or a model down, a transient database error) is
 * logged and kept as lastError for /api/status; the loop sleeps and tries again.
 */
export async function runWorkerLoop(d: WorkerLoopDeps): Promise<void> {
  while (!d.stopping()) {
    try {
      await runWake(d);
    } catch (err) {
      d.status.lastError = redactSecrets(String(err)).slice(0, 500);
      d.log('cycle failed', { error: d.status.lastError });
    }
    if (d.stopping()) break;
    d.stage.enter('waiting');
    await d.sleep(d.pollMs);
  }
}
