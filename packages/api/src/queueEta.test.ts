import { expect, test, vi } from 'vitest';
import type { Lesson } from '@fb/core';
import { Admission } from './admission.ts';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const lesson: Lesson = { id: 'l', projectKey: 'demo', title: 'Tenant reads', rule: 'Scope database reads to the tenant.', appliesWhen: 'database reads', paths: ['src/a.ts'], status: 'approved', scope: 'project', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' };
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function appFor(queue: Admission, budget: number) {
  const context: ContextDeps = { roots: [{ host: '/projects', container: '/projects' }], exists: () => true, checkTimeoutMs: budget, judgeQueue: queue, embed: async () => [[1]],
    k: { searchLessons: async () => [{ lesson, score: .9 }], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'f' },
    judge: async () => [{ lessonId: 'l', status: 'addressed', applies: true, why: 'Tenant read is handled.' }],
  };
  return createApp(repo, { context });
}
const call = (app: ReturnType<typeof createApp>) => app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_before_done', arguments: { project: 'demo', task: 'edit src/a.ts', summary: 'done', files_changed: ['src/a.ts'] } } }) });

test('real MCP queued response carries observed ETA, capacity and retry state; later retry succeeds', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const queue = new Admission({ concurrency: 1, timeoutMs: 10000 });
    const training = queue.run(() => new Promise(resolve => setTimeout(resolve, 1000)));
    await vi.advanceTimersByTimeAsync(1000); await training;
    const held = gate(); const active = queue.run(() => held.promise);
    const app = appFor(queue, 100);
    const pending = call(app);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending; expect(response.status).toBe(200);
    const { result } = await response.json();
    expect(result.structuredContent).toMatchObject({ queued: true, queue: { state: 'retry_required', capacity: 1, running: 1, waiting: 0, position: null, nextRetryPosition: 1, arrivalAhead: 1, retained: false,
      estimate: { source: 'observed', samples: 1, startMs: [900, 900], completionMs: [1900, 1900] } } });
    expect(result.content[0].text).toContain('Estimated start:');
    expect(result.content[0].text).toContain('1 recent completed judge calls');
    expect(result.content[0].text).toContain('not retain a queue position');
    held.release(); await active;
    const success = call(app); await vi.advanceTimersByTimeAsync(0);
    const completed = await (await success).json();
    expect(completed.result.structuredContent).toMatchObject({ queued: false, queue: { state: 'completed', retained: false, position: null } });
    expect(completed.result.content[0].text).toContain('This judge call completed.');
    expect(queue.waiting).toBe(0);
  } finally { vi.useRealTimers(); }
});

test('real MCP busy response exposes a still-occupied overdue slot and does not invent an upper ETA', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const queue = new Admission({ concurrency: 1, timeoutMs: 50 });
    await queue.run(async () => 'training');
    const held = gate(); const active = queue.run(() => held.promise);
    const pending = call(appFor(queue, 5000));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    const { result } = await (await pending).json();
    expect(result.content[0].text).toContain('Not judged:');
    expect(result.structuredContent).toMatchObject({ queued: true, queue: { state: 'retry_required', running: 1, waiting: 0, retained: false, estimate: { overdue: true, startMs: [0, null] } } });
    expect(result.content[0].text).toContain('upper estimate unavailable');
    held.release(); await active; await vi.advanceTimersByTimeAsync(0);
    expect(queue.running).toBe(0);
  } finally { vi.useRealTimers(); }
});
