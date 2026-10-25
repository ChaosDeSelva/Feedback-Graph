import type { Activity, ChatConversation, ChatThread, ChatTurnStatus, PipelineStatus, ScanJob } from '@fb/core';

/**
 * GET /api/events: what changes, pushed as server-sent events so a watcher (fg status --watch, an agent) need not poll.
 * One poller serves every open stream: it runs while at least one is open, reads each source every tick and sends
 * what changed. Sources come from createApp already narrowed to the shown projects.
 *
 * Events (the data is JSON):
 *   stage     { stage: { name, startedAt, current } | null, progress: { done, total } | null, workerHealthy }
 *             the worker's step changed (or the worker went quiet / came back); sent on connect too
 *   pipeline  /api/pipeline's counts without stage and progress; sent on connect and when a count changes
 *   scan      { id, projectKey, status, requestedAt, startedAt, finishedAt, filesScanned, factsAdded, error }
 *             a project's latest scan job was queued, started, finished or failed
 *   chat      { conversationId, projectKey, turnId, status, error }: an Ask answer went pending, answering, done or failed
 *   activity  { id, ts, kind, subject, projectKey, actor }: a new Activity entry
 */

export type StageEvent = Pick<PipelineStatus, 'stage' | 'progress'> & { workerHealthy: boolean };
export type PipelineCounts = Omit<PipelineStatus, 'stage' | 'progress'>;
export type ScanEvent = Pick<ScanJob, 'id' | 'projectKey' | 'status' | 'requestedAt' | 'startedAt' | 'finishedAt' | 'filesScanned' | 'factsAdded' | 'error'>;
export type ChatEvent = { conversationId: string; projectKey: string; turnId: string; status: ChatTurnStatus; error: string | null };
export type ActivityEvent = Pick<Activity, 'id' | 'ts' | 'kind' | 'subject' | 'projectKey' | 'actor'>;

export type FgEvent =
  | { event: 'stage'; data: StageEvent }
  | { event: 'pipeline'; data: PipelineCounts }
  | { event: 'scan'; data: ScanEvent }
  | { event: 'chat'; data: ChatEvent }
  | { event: 'activity'; data: ActivityEvent };

export type EventSources = {
  stage?(): Promise<StageEvent>;
  pipeline?(): Promise<PipelineCounts>;
  /** The latest scan job of each shown project. */
  scans?(): Promise<ScanJob[]>;
  /** The shown projects' conversations, and one with its turns. */
  chats?: { list(): Promise<ChatConversation[]>; thread(id: string): Promise<ChatThread | null> };
  /** The latest Activity entries of the shown projects (and those of none), newest first. */
  activity?(): Promise<Activity[]>;
};

export type EventHub = {
  /** Starts the poller with the first subscriber; the returned function unsubscribes (and stops it with the last). */
  subscribe(fn: (e: FgEvent) => void): () => void;
  /** The last stage and counts, for a stream that just opened. */
  current(): FgEvent[];
};

const scanEvent = (j: ScanJob): ScanEvent => ({
  id: j.id, projectKey: j.projectKey, status: j.status, requestedAt: j.requestedAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  filesScanned: j.filesScanned, factsAdded: j.factsAdded, error: j.error,
});

export function createEventHub(src: EventSources, opts: { tickMs?: number; pipelineEvery?: number } = {}): EventHub {
  const tickMs = opts.tickMs ?? 2000;
  const pipelineEvery = Math.max(1, opts.pipelineEvery ?? 3);
  const subs = new Set<(e: FgEvent) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every start and stop, so a poll of an earlier run neither sends nor schedules. */
  let run = 0;

  // What the last poll saw. Reset when the poller stops: a stream sees what changes after it opens, not a backlog.
  let stage: StageEvent | undefined;
  let stageKey: string | undefined;
  let pipeline: PipelineCounts | undefined;
  let pipelineKey: string | undefined;
  let ticks = 0;
  let scans: Map<string, string> | null = null;
  let chats: Map<string, { pending: boolean; updatedAt: string; turn: string | null }> | null = null;
  let seen: Set<string> | null = null;
  const reset = () => {
    stage = stageKey = pipeline = pipelineKey = undefined;
    ticks = 0;
    scans = chats = seen = null;
  };

  const emit = (e: FgEvent) => {
    for (const fn of subs) {
      try { fn(e); } catch { /* one stream's failure is its own */ }
    }
  };
  const read = async <T>(fn: (() => Promise<T>) | undefined): Promise<T | undefined> => (fn ? fn().catch(() => undefined) : undefined);

  async function poll(mine: number) {
    const live = () => mine === run;
    let stageChanged = false;
    const s = await read(src.stage);
    if (s && live()) {
      const key = JSON.stringify([s.stage, s.workerHealthy]);
      if (key !== stageKey) {
        stageChanged = true;
        stage = s;
        stageKey = key;
        emit({ event: 'stage', data: s });
      }
    }
    if (pipelineKey === undefined || stageChanged || ticks % pipelineEvery === 0) {
      const p = await read(src.pipeline);
      if (p && live()) {
        const { stage: _s, progress: _p, ...counts } = p as PipelineStatus;
        const key = JSON.stringify(counts);
        if (key !== pipelineKey) {
          pipeline = counts;
          pipelineKey = key;
          emit({ event: 'pipeline', data: counts });
        }
      }
    }
    ticks++;

    const jobs = await read(src.scans);
    if (jobs && live()) {
      const next = new Map(jobs.map((j) => [j.projectKey, `${j.id}:${j.status}`]));
      if (scans) for (const j of jobs) if (scans.get(j.projectKey) !== next.get(j.projectKey)) emit({ event: 'scan', data: scanEvent(j) });
      scans = next;
    }

    if (src.chats) {
      const convs = await read(src.chats.list.bind(src.chats));
      if (convs && live()) {
        const next = new Map<string, { pending: boolean; updatedAt: string; turn: string | null }>();
        for (const c of convs) {
          const before = chats?.get(c.id);
          let turn = before?.turn ?? null;
          // Only a conversation that waits for an answer, just stopped waiting, or changed is read again.
          if (c.pending || before?.pending || (chats && before?.updatedAt !== c.updatedAt)) {
            const t = await read(() => src.chats!.thread(c.id));
            const last = t?.turns.filter((x) => x.role === 'assistant').at(-1);
            if (last) {
              turn = `${last.id}:${last.status}`;
              if (chats && turn !== before?.turn) emit({ event: 'chat', data: { conversationId: c.id, projectKey: c.projectKey, turnId: last.id, status: last.status, error: last.error } });
            }
          }
          next.set(c.id, { pending: c.pending, updatedAt: c.updatedAt, turn });
        }
        if (live()) chats = next;
      }
    }

    const entries = await read(src.activity);
    if (entries && live()) {
      if (seen) {
        for (const a of entries.filter((x) => !seen!.has(x.id)).reverse()) {
          emit({ event: 'activity', data: { id: a.id, ts: a.ts, kind: a.kind, subject: a.subject, projectKey: a.projectKey, actor: a.actor } });
        }
      }
      // The list is the latest entries: one that has dropped off it cannot come back.
      seen = new Set(entries.map((x) => x.id));
    }
  }

  async function loop(mine: number) {
    await poll(mine).catch(() => {});
    if (mine === run) timer = setTimeout(() => void loop(mine), tickMs);
  }

  return {
    subscribe(fn) {
      subs.add(fn);
      if (subs.size === 1) {
        reset();
        void loop(++run);
      }
      return () => {
        if (!subs.delete(fn) || subs.size) return;
        run++;
        if (timer) clearTimeout(timer);
        timer = null;
        reset();
      };
    },
    current() {
      return [...(stage ? [{ event: 'stage' as const, data: stage }] : []), ...(pipeline ? [{ event: 'pipeline' as const, data: pipeline }] : [])];
    },
  };
}
