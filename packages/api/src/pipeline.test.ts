import type { Candidate, ChatStore, Lesson, ProjectSummary, ScanJob, ScanQueueEntry, ShownProjects, WorkerStatus } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo, type AppOpts } from './app.ts';

const beat = (o: Partial<WorkerStatus> = {}): WorkerStatus => ({
  version: 't', startedAt: 't', lastBeat: new Date().toISOString(), lastCycleAt: null, lastCycle: null, lastError: null, providers: {}, ...o,
});
const cand = (id: string, projectKey: string, status: Candidate['status']) => ({ id, projectKey, status }) as Candidate;
const lesson = (id: string, projectKey: string | null, status: Lesson['status'], origin = projectKey) => ({ id, projectKey, origin, status }) as Lesson;
const scan = (status: ScanJob['status']) => ({ status }) as ScanJob;
const project = (key: string, sessions: number, lastScan: ScanJob | null): ProjectSummary =>
  ({ key, repoPath: `/r/${key}`, remote: null, aliases: [], sessions, feedback: 0, lessons: 0, facts: 0, lastScan, pinned: false });

/** The stores' queue reads (FactsStore.scanQueue, KnowledgeStore.postmortemQueue, ChatStore.chatQueue). */
type Queues = { scanQueue?: () => Promise<ScanQueueEntry[]>; postmortemQueue?: () => Promise<{ waiting: number; oldestAt: string | null }>; chatQueue?: ChatStore['chatQueue'] };

function app(o: { shown?: string[]; backlog?: number | null; worker?: WorkerStatus | null; older?: Map<string, number>; queues?: Queues } = {}) {
  const candidates = [cand('a', 'shop', 'pending'), cand('b', 'shop', 'pending'), cand('c', 'api', 'confirmed'), cand('d', 'hidden', 'pending')];
  // l4 is global (no project of its own), learned in shop; l5 global, learned in a project that is not shown.
  const lessons = [lesson('l1', 'shop', 'proposed'), lesson('l2', 'api', 'approved'), lesson('l3', 'hidden', 'proposed'), lesson('l4', null, 'approved', 'shop'), lesson('l5', null, 'proposed', 'hidden')];
  const repo = {
    listCandidates: async (f: { status?: string; projectKeys?: string[] } = {}) =>
      candidates.filter((c) => (!f.status || c.status === f.status) && (!f.projectKeys || f.projectKeys.includes(c.projectKey))),
    candidateDetail: async () => null, decide: async () => {}, stats: async () => [],
  } as unknown as ApiRepo;
  const projects = [project('shop', 4, scan('done')), project('api', 2, scan('queued')), project('docs', 0, null), project('hidden', 9, scan('failed'))];
  const shown = o.shown ?? ['shop', 'api', 'docs'];
  const opts: AppOpts = {
    system: { version: 't', ping: async () => true, worker: async () => (o.worker === undefined ? beat({ backlog: { classify: 120, classifyCapped: false, at: 't' }, stage: { name: 'classify', startedAt: 's', done: 2, total: 50, current: 'x' } }) : o.worker) },
    knowledge: {
      listLessons: async (f: { status?: string; projectKeys?: string[] }) => lessons.filter((l) => (!f.status || l.status === f.status) && (!f.projectKeys || f.projectKeys.includes((l.projectKey ?? l.origin)!))),
      lessonDetail: async () => null, updateLesson: async () => ({ unscoped: false }),
      ...(o.backlog === null ? {} : { postmortemBacklog: async () => o.backlog ?? 3 }),
      ...(o.queues?.postmortemQueue && { postmortemQueue: o.queues.postmortemQueue }),
    } as unknown as AppOpts['knowledge'],
    facts: { listProjects: async () => projects, requestScan: async () => ({}) as ScanJob, listFacts: async () => [], searchFacts: async () => [], ...(o.older && { olderScannerFiles: async () => o.older! }), ...(o.queues?.scanQueue && { scanQueue: o.queues.scanQueue }) },
    ...(o.queues?.chatQueue && { chat: { store: { chatQueue: o.queues.chatQueue } } as unknown as AppOpts['chat'] }),
    projectDirs: async () => [],
    shown: () => ({ keys: shown, has: (k: string) => shown.includes(k) }) as ShownProjects,
  };
  return createApp(repo, opts);
}

test('GET /api/pipeline: where every stage stands, in the shown projects only', async () => {
  const p = await (await app().request('/api/pipeline')).json();
  expect(p).toEqual({
    stage: { name: 'classify', startedAt: 's', current: 'x' },
    progress: { done: 2, total: 50 },
    sessions: 6,
    classify: { backlog: 120, capped: false },
    inbox: { pending: 2, confirmed: 1 },
    postmortems: { queued: 3 },
    // Global lessons count too, and say how many of them are global (no project row lists them).
    lessons: { proposed: 1, approved: 2, global: 1 },
    scans: { done: 1, queued: 1, running: 0, failed: 0, never: 1 },
    // Without the stores' queue reads: the worker's classify backlog and stage, the post-mortem count.
    queues: {
      scans: null,
      classify: { waiting: 120, capped: false, oldestAt: null, running: [{ what: 'x', since: 's' }] },
      postmortems: { waiting: 3, oldestAt: null, running: [] },
      chats: null,
    },
  });
});

test('what this server cannot tell is null, not zero', async () => {
  const p = await (await app({ backlog: null, worker: null }).request('/api/pipeline')).json();
  expect(p.postmortems).toBeNull();
  expect(p.classify).toBeNull();
  expect([p.stage, p.progress]).toEqual([null, null]);
  expect(p.inbox).toEqual({ pending: 2, confirmed: 1 });
});

test('GET /api/pipeline?project=: the counts of one shown project (the worker-wide backlog stays worker-wide)', async () => {
  const p = await (await app().request('/api/pipeline?project=api')).json();
  expect(p).toMatchObject({ sessions: 2, inbox: { pending: 0, confirmed: 1 }, lessons: { proposed: 0, approved: 1, global: 0 }, scans: { done: 0, queued: 1, running: 0, failed: 0, never: 0 }, classify: { backlog: 120, capped: false } });
  // A project that is not shown counts nothing, rather than leaking its numbers.
  const hidden = await (await app().request('/api/pipeline?project=hidden')).json();
  expect(hidden).toMatchObject({ sessions: 0, inbox: { pending: 0, confirmed: 0 }, lessons: { proposed: 0, approved: 0 } });
});

test('the pipeline counts files an older scanner read, in the shown projects only, by project', async () => {
  const p = await (await app({ older: new Map([['shop', 12], ['api', 3], ['hidden', 40]]) }).request('/api/pipeline')).json();
  expect(p.scans).toEqual({ done: 1, queued: 1, running: 0, failed: 0, never: 1, olderScanner: { files: 15, projects: { shop: 12, api: 3 } } });
  // None, or a store that cannot count them: not said.
  expect((await (await app({ older: new Map() }).request('/api/pipeline')).json()).scans.olderScanner).toBeUndefined();
  expect((await (await app().request('/api/pipeline')).json()).scans.olderScanner).toBeUndefined();
});

test('GET /api/pipeline: every queue says how many wait, since when the oldest has, and what runs now since when', async () => {
  const entry = (projectKey: string, status: ScanJob['status'], waitingSince: string, o: Partial<ScanJob> = {}): ScanQueueEntry =>
    ({ id: `scan:${projectKey}`, projectKey, status, waitingSince, requestedAt: waitingSince, startedAt: null, shards: null, ...o }) as ScanQueueEntry;
  const worker = beat({
    backlog: { classify: 120, classifyCapped: true, at: 't', oldestAt: '2026-10-25T07:00:00.000Z' },
    stage: { name: 'postmortem', startedAt: '2026-10-25T09:57:00.000Z', done: null, total: null, current: 'fb-1' },
  });
  const p = await (await app({
    worker,
    shown: ['shop', 'api', 'big'],
    queues: {
      scanQueue: async () => [
        entry('big', 'running', '2026-10-25T07:30:00.000Z', { startedAt: '2026-10-25T09:46:00.000Z', shards: { total: 40, done: 11, rescanned: 11, failed: 0 } }),
        entry('shop', 'queued', '2026-10-25T08:00:00.000Z'),
        entry('api', 'queued', '2026-10-25T09:55:00.000Z'),
        entry('hidden', 'queued', '2026-10-25T01:00:00.000Z'),
      ],
      postmortemQueue: async () => ({ waiting: 2, oldestAt: '2026-10-25T09:50:00.000Z' }),
      chatQueue: async () => ({ waiting: 1, oldestAt: '2026-10-25T09:59:00.000Z', running: [{ id: 't1', projectKey: 'shop', startedAt: '2026-10-25T09:59:30.000Z' }, { id: 't2', projectKey: 'hidden', startedAt: '2026-10-25T09:59:40.000Z' }] }),
    },
  }).request('/api/pipeline')).json();
  // Scans by project in the shown projects only, the running one with its shards; the oldest wait is the queued ones'.
  expect(p.queues.scans).toEqual({
    waiting: 2, oldestAt: '2026-10-25T08:00:00.000Z',
    running: [{ what: 'big', since: '2026-10-25T09:46:00.000Z', shards: { done: 11, total: 40 } }],
    projects: [
      { project: 'big', status: 'running', since: '2026-10-25T09:46:00.000Z', shards: { done: 11, total: 40 } },
      { project: 'shop', status: 'queued', since: '2026-10-25T08:00:00.000Z', shards: null },
      { project: 'api', status: 'queued', since: '2026-10-25T09:55:00.000Z', shards: null },
    ],
  });
  // The classify backlog is the worker's count (capped: at least that many) and its oldest fetched turn; none runs now.
  expect(p.queues.classify).toEqual({ waiting: 120, capped: true, oldestAt: '2026-10-25T07:00:00.000Z', running: [] });
  // A post-mortem runs now (the worker's stage).
  expect(p.queues.postmortems).toEqual({ waiting: 2, oldestAt: '2026-10-25T09:50:00.000Z', running: [{ what: 'fb-1', since: '2026-10-25T09:57:00.000Z' }] });
  // An answer written for a project that is not shown is counted, not named.
  expect(p.queues.chats).toEqual({
    waiting: 1, oldestAt: '2026-10-25T09:59:00.000Z',
    running: [{ what: 'shop', since: '2026-10-25T09:59:30.000Z' }, { what: 'a project not shown', since: '2026-10-25T09:59:40.000Z' }],
  });
});

test('a queue this server cannot read is null, not empty', async () => {
  const p = await (await app({ worker: null, backlog: null }).request('/api/pipeline')).json();
  expect(p.queues).toEqual({ scans: null, classify: null, postmortems: null, chats: null });
});
