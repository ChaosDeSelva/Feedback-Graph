import type { ScanJob } from '@fb/core';

export type ScanRunnerDeps = {
  /** The oldest due queued job other than these ids (FactsStore.nextScanJob). */
  next(exclude: string[]): Promise<ScanJob | null>;
  /** Whether the job's model explores the repo itself (codex-cli, claude-cli): those run one at a time. */
  agentic(job: ScanJob): boolean;
  /** No file worth scanning: the job is run at once, outside the slots (it finishes without a model call). */
  empty(job: ScanJob): Promise<boolean>;
  /**
   * Run one job to its end (done, failed, or queued again with a retryAt). True when it finished; false when it went
   * back to wait, so the runner does not pick the queue up again on its own (the worker loop kicks it next cycle).
   */
  run(job: ScanJob): Promise<boolean>;
  /** SCAN_CONCURRENCY. */
  concurrency: number;
  log?: (msg: string, extra?: object) => void;
};

/** Agentic scans at once: the codex runner takes one job at a time, and a CLI agent per repo is heavy. */
const AGENTIC_SLOTS = 1;
/**
 * Jobs one fill passes over (no free slot, or the agentic one taken) while it looks behind them for an empty project
 * or a per-file job that can start, so a long queue costs few queries.
 */
const MAX_PASSED_OVER = 20;

/**
 * Scans beside the worker cycle: up to `concurrency` at once, agentic ones one at a time, so a queue of 70 projects
 * no longer waits for one scan per cycle behind classification. kick() fills free slots and returns at once; a slot
 * that frees up fills itself. Jobs are claimed one at a time (fill is never concurrent), so no job runs twice.
 */
export class ScanRunner {
  private readonly d: ScanRunnerDeps;
  private readonly active = new Map<string, { agentic: boolean; done: Promise<void> }>();
  private filling: Promise<void> | null = null;
  private refill = false;
  private stopped = false;
  /** Jobs already found to have files, so a job waiting for a slot is not listed again on every fill. */
  private readonly hasFiles = new Set<string>();

  constructor(d: ScanRunnerDeps) {
    this.d = d;
  }

  /** Ids of the scans running now, in the order they started. */
  running(): string[] {
    return [...this.active.keys()];
  }

  /** Fill free slots from the queue. Never throws; nothing waits for it. */
  kick(): void {
    if (this.stopped) return;
    if (this.filling) {
      this.refill = true;
      return;
    }
    this.filling = this.fill()
      .catch((err) => this.d.log?.('scan runner: could not read the queue', { error: String(err) }))
      .finally(() => {
        this.filling = null;
        if (this.refill && !this.stopped) {
          this.refill = false;
          this.kick();
        }
      });
  }

  /** Resolves when nothing is being claimed or run (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.filling || this.active.size) {
      await this.filling;
      await Promise.all([...this.active.values()].map((a) => a.done));
    }
  }

  /** Nothing new starts; resolves once the scans running now have finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }

  private async fill(): Promise<void> {
    const passedOver: string[] = [];
    while (!this.stopped) {
      const job = await this.d.next([...this.active.keys(), ...passedOver]);
      if (!job || this.stopped) return;
      if (!this.hasFiles.has(job.id)) {
        if (await this.d.empty(job).catch(() => false)) {
          // Finishes without a model call: no slot, and the queue moves on at once.
          await this.d.run(job).catch((err) => this.d.log?.('scan runner: a scan threw', { project: job.projectKey, error: String(err) }));
          continue;
        }
        this.hasFiles.add(job.id);
      }
      const agentic = this.d.agentic(job);
      const full = this.active.size >= Math.max(1, this.d.concurrency);
      if (full || (agentic && [...this.active.values()].filter((a) => a.agentic).length >= AGENTIC_SLOTS)) {
        passedOver.push(job.id);
        if (passedOver.length >= MAX_PASSED_OVER) return;
        continue;
      }
      this.hasFiles.delete(job.id);
      this.start(job, agentic);
    }
  }

  private start(job: ScanJob, agentic: boolean) {
    const done = (async () => {
      let progressed = false;
      try {
        progressed = await this.d.run(job);
      } catch (err) {
        this.d.log?.('scan runner: a scan threw', { project: job.projectKey, error: String(err) });
      } finally {
        this.active.delete(job.id);
      }
      if (progressed) this.kick();
    })();
    this.active.set(job.id, { agentic, done });
  }
}
