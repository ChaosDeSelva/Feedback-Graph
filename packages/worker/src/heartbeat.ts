import type { WorkerStatus } from '@fb/core';

export const HEARTBEAT_MS = 30_000;
/** A stage change beats within this, not at the next beat. */
export const STAGE_BEAT_MS = 3_000;

export type HeartbeatDeps = {
  status: WorkerStatus;
  /** A file too, so the container health check needs no database round trip. */
  file: string;
  writeFile: (path: string, data: string) => Promise<unknown>;
  repo: { heartbeat: (s: WorkerStatus) => Promise<unknown> };
  log: (msg: string, extra?: object) => void;
};

/** A timer, not the loop, beats: a 15-minute post-mortem must not make the worker look dead. */
export class Heartbeat {
  private d: HeartbeatDeps;
  private every: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(d: HeartbeatDeps) {
    this.d = d;
  }

  beat(): void {
    this.d.status.lastBeat = new Date().toISOString();
    this.d.writeFile(this.d.file, this.d.status.lastBeat).catch(() => {});
    this.d.repo.heartbeat(this.d.status).catch((err) => this.d.log('heartbeat failed', { error: String(err) }));
  }

  /** Beat now and every HEARTBEAT_MS until stop. */
  start(): void {
    this.beat();
    this.every = setInterval(() => this.beat(), HEARTBEAT_MS);
  }

  /** One beat within STAGE_BEAT_MS; calls meanwhile share it. None after stop: the round finishing then must not beat. */
  soon(): void {
    if (this.stopped) return;
    this.pending ??= setTimeout(() => { this.pending = null; this.beat(); }, STAGE_BEAT_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.every) clearInterval(this.every);
    if (this.pending) clearTimeout(this.pending);
    this.every = this.pending = null;
  }
}
