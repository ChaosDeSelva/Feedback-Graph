import { redactSecrets } from '@fb/core';
import type { LoopRoundResult } from './engine.ts';

/** A round at most this often, unless the last page was full (then the next at once, while the worker stays idle). */
export const LOOP_ROUND_MS = 5 * 60_000;

/**
 * The learning loop beside the worker loop (never awaited by it), at idle priority: a round runs only when no
 * post-mortem waits and no scan is running, never two at once. A failed round is logged (redacted) and tried again
 * when next due; the aborted round is on the live page.
 */
export class LoopStage {
  private d: { run: () => Promise<LoopRoundResult>; idle: () => Promise<boolean>; log: (msg: string, extra?: object) => void; everyMs?: number; stopping?: () => boolean };
  private at = Number.NEGATIVE_INFINITY;
  private running = false;

  constructor(d: LoopStage['d']) {
    this.d = d;
  }

  /** The round in flight when one started (or the idle check that may start it); else undefined. */
  tick(now = Date.now()): Promise<void> | undefined {
    if (this.running || now - this.at < (this.d.everyMs ?? LOOP_ROUND_MS)) return;
    this.running = true;
    return (async () => {
      // A full page means more entries wait (an upgrade's catch-up): the next round runs at once, while still idle,
      // rather than one per worker wake.
      for (;;) {
        if (this.d.stopping?.() || !(await this.d.idle())) return;
        this.at = now;
        const { round, more } = await this.d.run();
        if (round) this.d.log('learning loop round', { signals: round.signalsIngested, scored: round.targetsScored, ...round.decisions, llmCalls: round.llmCalls });
        if (!more) return;
        this.at = Number.NEGATIVE_INFINITY;
      }
    })()
      .catch((err) => this.d.log('learning loop round failed', { error: redactSecrets(String(err)) }))
      .finally(() => { this.running = false; });
  }
}

/** Idle: no post-mortem waits (when post-mortems can run at all) and no scan runs. */
export const loopIdle = (d: { postmortemBacklog: (() => Promise<number>) | null; scansRunning: () => number }) => async () =>
  d.scansRunning() === 0 && (d.postmortemBacklog ? (await d.postmortemBacklog()) === 0 : true);
