import type { Activity, ChatConversation, ChatThread, ScanJob, ShownProjects, WorkerStatus } from '@fb/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { createEventHub, type FgEvent, type StageEvent } from './events.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const scan = (projectKey: string, id: string, status: ScanJob['status']): ScanJob => ({
  id, projectKey, repoPath: `/r/${projectKey}`, provider: null, status, requestedAt: 't0', startedAt: null, finishedAt: null, filesScanned: 0, factsAdded: 0, error: null, attempts: 0, retryAt: null,
});
const act = (id: string, projectKey: string | null, kind = 'doc_added'): Activity => ({
  id, ts: `t${id}`, kind, actor: 'you', projectKey, subject: `s${id}`, why: 'w', details: {}, targets: [],
} as Activity);

describe('createEventHub', () => {
  test('one poll for every client; the first poll sends the stage and the counts, later polls only what changed', async () => {
    let stage: StageEvent = { stage: { name: 'ingest', startedAt: 't', current: null }, progress: null, workerHealthy: true };
    let counts = { inbox: { pending: 1, confirmed: 0 } };
    const polls = { stage: 0 };
    const hub = createEventHub({
      stage: async () => { polls.stage++; return stage; },
      pipeline: async () => counts as never,
    }, { tickMs: 2000, pipelineEvery: 1 });
    const a: FgEvent[] = [];
    const b: FgEvent[] = [];
    const offA = hub.subscribe((e) => a.push(e));
    const offB = hub.subscribe((e) => b.push(e));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.map((e) => e.event)).toEqual(['stage', 'pipeline']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(a).toHaveLength(2);
    stage = { ...stage, stage: { name: 'classify', startedAt: 't2', current: null } };
    counts = { inbox: { pending: 2, confirmed: 0 } };
    await vi.advanceTimersByTimeAsync(2000);
    expect(a.slice(2)).toEqual([
      { event: 'stage', data: stage },
      { event: 'pipeline', data: counts },
    ]);
    expect(b).toEqual(a);
    expect(polls.stage).toBe(3);
    // A client that connects now gets the current stage and counts straight away.
    expect(hub.current()).toEqual([{ event: 'stage', data: stage }, { event: 'pipeline', data: counts }]);
    offA();
    offB();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls.stage).toBe(3);
  });

  test('the counts are read every few polls, and at once when the stage changes', async () => {
    let name: 'ingest' | 'classify' = 'ingest';
    let reads = 0;
    const hub = createEventHub({
      stage: async () => ({ stage: { name, startedAt: 't', current: null }, progress: null, workerHealthy: true }),
      pipeline: async () => { reads++; return {} as never; },
    }, { tickMs: 1000, pipelineEvery: 3 });
    hub.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(2);
    name = 'classify';
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(3);
  });

  test('scan jobs: a start and a finish are sent, the state at connect is not', async () => {
    let jobs = [scan('shop', 's1', 'done'), scan('api', 's2', 'queued')];
    const hub = createEventHub({ scans: async () => jobs }, { tickMs: 1000 });
    const got: FgEvent[] = [];
    hub.subscribe((e) => got.push(e));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([]);
    jobs = [scan('shop', 's1', 'done'), { ...scan('api', 's2', 'running'), startedAt: 't1' }];
    await vi.advanceTimersByTimeAsync(1000);
    jobs = [scan('shop', 's3', 'queued'), { ...scan('api', 's2', 'done'), factsAdded: 4 }];
    await vi.advanceTimersByTimeAsync(1000);
    expect(got.map((e) => [e.event, (e.data as ScanJob).id, (e.data as ScanJob).status])).toEqual([
      ['scan', 's2', 'running'], ['scan', 's3', 'queued'], ['scan', 's2', 'done'],
    ]);
    expect(got[2].data).toEqual({ id: 's2', projectKey: 'api', status: 'done', requestedAt: 't0', startedAt: null, finishedAt: null, filesScanned: 0, factsAdded: 4, error: null });
  });

  test('chat turns: each status change of a conversation\'s answer is sent', async () => {
    const conv = (pending: boolean, updatedAt: string): ChatConversation => ({ id: 'c1', projectKey: 'shop', title: 'T', provider: null, createdAt: 't', updatedAt, pending });
    let convs = [conv(false, 'u0')];
    let status: 'pending' | 'answering' | 'done' = 'done';
    const thread = async (): Promise<ChatThread> => ({ ...convs[0], turns: [{ id: 'q', role: 'user', status: 'done' }, { id: 'a1', role: 'assistant', status, error: null }] as never });
    const hub = createEventHub({ chats: { list: async () => convs, thread } }, { tickMs: 1000 });
    const got: FgEvent[] = [];
    hub.subscribe((e) => got.push(e));
    await vi.advanceTimersByTimeAsync(0);
    convs = [conv(true, 'u1')];
    status = 'pending';
    await vi.advanceTimersByTimeAsync(1000);
    status = 'answering';
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    convs = [conv(false, 'u1')];
    status = 'done';
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(got.map((e) => e.data)).toEqual([
      { conversationId: 'c1', projectKey: 'shop', turnId: 'a1', status: 'pending', error: null },
      { conversationId: 'c1', projectKey: 'shop', turnId: 'a1', status: 'answering', error: null },
      { conversationId: 'c1', projectKey: 'shop', turnId: 'a1', status: 'done', error: null },
    ]);
    expect(got.every((e) => e.event === 'chat')).toBe(true);
  });

  test('activity: new entries, oldest first, never the ones there at connect', async () => {
    let list = [act('2', 'shop'), act('1', null)];
    const hub = createEventHub({ activity: async () => list }, { tickMs: 1000 });
    const got: FgEvent[] = [];
    hub.subscribe((e) => got.push(e));
    await vi.advanceTimersByTimeAsync(0);
    list = [act('4', 'shop'), act('3', null), ...list];
    await vi.advanceTimersByTimeAsync(1000);
    expect(got).toEqual([
      { event: 'activity', data: { id: '3', ts: 't3', kind: 'doc_added', subject: 's3', projectKey: null, actor: 'you' } },
      { event: 'activity', data: { id: '4', ts: 't4', kind: 'doc_added', subject: 's4', projectKey: 'shop', actor: 'you' } },
    ]);
  });

  test('a source that fails is skipped for that poll; the others still report', async () => {
    let fail = true;
    const hub = createEventHub({
      stage: async () => { if (fail) throw new Error('down'); return { stage: null, progress: null, workerHealthy: false }; },
      pipeline: async () => ({ inbox: null }) as never,
    }, { tickMs: 1000, pipelineEvery: 1 });
    const got: FgEvent[] = [];
    hub.subscribe((e) => got.push(e));
    await vi.advanceTimersByTimeAsync(0);
    expect(got.map((e) => e.event)).toEqual(['pipeline']);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(got.map((e) => e.event)).toEqual(['pipeline', 'stage']);
  });
});

// ── GET /api/events ──────────────────────────────────────────────────────

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;
const beat = (name: string): WorkerStatus => ({
  version: 'x', startedAt: 't', lastBeat: new Date().toISOString(), lastCycleAt: null, lastCycle: null, lastError: null, providers: {},
  stage: { name, startedAt: 't', current: null, done: null, total: null },
} as WorkerStatus);
const view = (keys: string[]): ShownProjects => ({ initialized: true, keys, has: (k: string) => keys.includes(k) } as ShownProjects);

/** Reads a stream, a fake second at a time while nothing arrives (at most a minute), until `until` holds for what arrived. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until: (text: string) => boolean): Promise<string> {
  const dec = new TextDecoder();
  let text = '';
  for (let s = 0; s < 60 && !until(text);) {
    let got: ReadableStreamReadResult<Uint8Array> | null = null;
    const next = reader.read().then((r) => { got = r; });
    while (!got && s < 60) { await vi.advanceTimersByTimeAsync(1000); s++; }
    if (!got) break;
    await next;
    const { value, done } = got as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    text += dec.decode(value);
  }
  return text;
}

describe('GET /api/events', () => {
  test('streams the stage as server-sent events, with a retry hint and heartbeats, and closes cleanly', async () => {
    let name = 'ingest';
    const app = createApp(repo, { system: { version: 'x', ping: async () => true, worker: async () => beat(name) } });
    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const first = await readUntil(reader, (t) => t.includes('event: stage'));
    expect(first).toMatch(/^retry: \d+\n\n/);
    expect(first).toContain('"name":"ingest"');
    name = 'classify';
    const rest = await readUntil(reader, (t) => t.includes('"name":"classify"') && t.includes(': ping'));
    expect(rest).toContain('"name":"classify"');
    expect(rest).toContain(': ping\n\n');
    await reader.cancel();
  });

  test('never sends a project that is not shown', async () => {
    let list = [act('1', 'shop')];
    let jobs = [scan('shop', 's1', 'queued'), scan('secret', 's2', 'queued')];
    const app = createApp(repo, {
      shown: () => view(['shop']),
      // A store that ignores projectKeys: the stream drops another project's entry all the same.
      activity: { record: async () => {}, list: async () => list } as never,
      facts: { listProjects: async () => jobs.map((j) => ({ key: j.projectKey, lastScan: j, sessions: 0 })) } as never,
      projectDirs: async () => [],
    });
    const res = await app.request('/api/events');
    const reader = res.body!.getReader();
    await readUntil(reader, (t) => t.includes('retry:'));
    await vi.advanceTimersByTimeAsync(3000);
    list = [act('3', 'secret'), act('2', 'shop'), ...list];
    jobs = [scan('shop', 's1', 'running'), scan('secret', 's2', 'running')];
    const text = await readUntil(reader, (t) => t.includes('"id":"2"') && t.includes('"status":"running"'));
    expect(text).toContain('"id":"2"');
    expect(text).toContain('"projectKey":"shop"');
    expect(text).not.toContain('secret');
    await reader.cancel();
  });

  test('more than 20 open streams are refused', async () => {
    const app = createApp(repo, { system: { version: 'x', ping: async () => true, worker: async () => null } });
    const open = await Promise.all(Array.from({ length: 20 }, () => app.request('/api/events')));
    expect(open.every((r) => r.status === 200)).toBe(true);
    const over = await app.request('/api/events');
    expect(over.status).toBe(503);
    await open[0].body!.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect((await app.request('/api/events')).status).toBe(200);
  });

  test('needs the token like every other read', async () => {
    const app = createApp(repo, { auth: { token: 'x'.repeat(30) } });
    expect((await app.request('/api/events')).status).toBe(401);
  });
});
