/** How long a stopping worker waits for the work in hand before it exits anyway. */
export const SHUTDOWN_GRACE_MS = 20_000;

export type ShutdownDeps = {
  log: (msg: string, extra?: object) => void;
  /** Detached CLI agents would otherwise outlive the worker (core killRunningCommands). */
  killRunningCommands: () => void;
  exit: (code: number) => void;
  graceMs?: number;
};

/**
 * The worker's stop. On the first SIGTERM or SIGINT nothing new starts (each registered stop runs, never awaited), the
 * loop's sleep ends at once, and the process exits after the grace period whatever is still running. The loop itself
 * waits for the stages and closes the store when it sees `stopping`.
 */
export class Shutdown {
  stopping = false;
  private d: ShutdownDeps;
  private stops: (() => unknown)[] = [];
  private wake: (() => void) | null = null;

  constructor(d: ShutdownDeps) {
    this.d = d;
  }

  /** Run `fn` when shutdown begins; one registered after that is not run (the loop's own stops cover it). */
  onStop(fn: () => unknown): void {
    this.stops.push(fn);
  }

  begin(signal: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.d.log('shutting down', { signal });
    this.d.killRunningCommands();
    for (const stop of this.stops) void stop();
    this.wake?.();
    setTimeout(() => this.d.exit(0), this.d.graceMs ?? SHUTDOWN_GRACE_MS).unref();
  }

  install(proc: Pick<NodeJS.Process, 'once'>): void {
    proc.once('SIGTERM', () => this.begin('SIGTERM'));
    proc.once('SIGINT', () => this.begin('SIGINT'));
    proc.once('exit', () => this.d.killRunningCommands());
  }

  /** Wait `ms`, or until shutdown begins. */
  async sleep(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      this.wake = () => { clearTimeout(t); res(); };
    });
    this.wake = null;
  }
}
