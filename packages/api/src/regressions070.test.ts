import { expect, test, vi } from 'vitest';
import { type Lesson, rankFacts, rankMisses, rankDocs } from '@fb/core';
import { buildChatContext } from './chat.ts';
import { checkBeforeDone, getTaskContext, makeJudge, taskFiles, type ContextDeps } from './context.ts';
import { createApp, type ApiRepo } from './app.ts';
import { taskPrNumbers } from './diff.ts';
import { Admission } from './admission.ts';

const lesson: Lesson = { id: 'prefix', projectKey: 'demo', title: 'Reference identifiers', rule: 'Use ReferenceID(...) instead of KeyPrefix 005.', appliesWhen: 'editing schema', paths: ['src/schema.ts'], status: 'approved', scope: 'project', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' };
const deps = (over: Partial<ContextDeps> = {}): ContextDeps => ({ roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]], k: { searchLessons: async () => [{ lesson, score: 1 }], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'f' }, judge: async () => [{ lessonId: lesson.id, applies: true, status: 'not_addressed', why: 'Required identifier is missing' }], ...over });
const change = '--- a/src/schema.ts\n+++ b/src/schema.ts\n@@ -1 +1 @@\n-KeyPrefix = "005";\n+schema.ReferenceID("tenant");\n';

test('real MCP structured result preserves gaps, cannotTell and clean verdicts instead of replacing them with queue data', async () => {
  for (const status of ['addressed', 'not_addressed', 'cannot_tell'] as const) {
    const context = deps({ judgeQueue: new Admission({ concurrency: 1, timeoutMs: 1000 }), judge: async () => [{ lessonId: lesson.id, applies: true, status, why: 'Observed result' }] });
    const app = createApp({ listCandidates: async () => [], stats: async () => [] } as unknown as ApiRepo, { context });
    const response = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_before_done', arguments: { project: 'demo', task: 'edit src/schema.ts', summary: 'done', files_changed: ['src/schema.ts'] } } }) });
    const { result } = await response.json();
    expect(result.structuredContent.markdown).toBe(result.content[0].text);
    expect(result.structuredContent.verdicts[0].status).toBe(status);
    expect(result.structuredContent.gaps).toHaveLength(status === 'not_addressed' ? 1 : 0);
    expect(result.structuredContent.cannotTell).toHaveLength(status === 'cannot_tell' ? 1 : 0);
    expect(result.structuredContent.queue.state).toBe('completed');
  }
});

test('clean ReferenceID prose evidence resolves to actual added executable call, never a removed call or comment', async () => {
  const json = vi.fn(async () => ({ verdicts: [{ lessonId: 'L1', applies: true, status: 'addressed', why: 'Uses ReferenceID(...) for the identifier.' }] }));
  const judge = makeJudge({ id: 'fake', agentic: false, json });
  const clean = await checkBeforeDone({ project: 'demo', task: 'edit src/schema.ts', summary: 'done', diff: change }, deps({ judge }));
  expect(clean.cannotTell).toEqual([]);
  expect(json).toHaveBeenCalledTimes(1);
  for (const diff of [change.replace('+schema.ReferenceID("tenant");', '+// schema.ReferenceID("tenant");'), change.replace('+schema.ReferenceID("tenant");', '+schema.OtherReferenceID("tenant");')]) {
    const result = await checkBeforeDone({ project: 'demo', task: 'edit src/schema.ts', summary: 'done', diff }, deps({ judge }));
    expect(result.cannotTell).toHaveLength(1);
  }
});

test('secret-like Ask paths cannot reach scans, code-file identities or Activity files', async () => {
  const secret = `ghp_${'a'.repeat(36)}/src.ts`;
  expect(taskFiles({ files: [secret, '.env', 'src/good.ts'] }, [])).toEqual(['.env', 'src/good.ts']);
  const requested: string[][] = [], activities: unknown[] = [];
  const context = deps({ requestScan: async (_project, paths) => { requested.push(paths); }, activity: { record: async value => { activities.push(value); } } });
  await buildChatContext('demo', `Explain ${secret} and src/good.ts`, [], { context });
  expect(JSON.stringify([requested, activities])).not.toContain(secret);
  expect(JSON.stringify([requested, activities])).not.toContain(`ghp_${'a'.repeat(36)}`);
});

test('weighted misses/docs drop below .80 while exact named source facts survive relevance weighting', async () => {
  const miss = { missed: 'Missed src/other.ts', feedbackText: '', score: .79 };
  expect(rankMisses([miss], 5, [], [], .78, .8)).toEqual([]);
  expect(rankDocs([{ ref: 'guide', title: 'Guide', text: 'text', score: .799 }], 5, [], [], .78, .8)).toEqual([]);
  const fact = { fact: { id: 'f', path: 'src/org_clock.py', relevance: .4, statement: 'Clock convention', kind: 'convention' } as never, score: .84 };
  expect(rankFacts([fact], 5, ['src/org_clock.py'], [], .78, .8)).toHaveLength(1);
  expect(rankFacts([fact], 5, ['src/other.py'], [], .78, .8)).toEqual([]);
  expect(taskPrNumbers('PR1 of 2')).toEqual([]);
  expect(taskPrNumbers('review PR 14299')).toEqual([14299]);
});

test('every selected completed or unjudged check records one explicit outcome', async () => {
  for (const kind of ['lesson', 'none', 'failed', 'timeout'] as const) {
    const checks: unknown[] = [];
    const context = deps({ checkTimeoutMs: kind === 'timeout' ? 15 : 1000, k: { ...deps().k, searchLessons: async () => kind === 'none' ? [] : [{ lesson, score: 1 }], recordPreDoneCheck: async check => { checks.push(check); } }, judge: async () => {
      if (kind === 'failed') throw Error('offline');
      if (kind === 'timeout') return new Promise(() => {});
      return [{ lessonId: lesson.id, status: 'addressed', why: 'done' }];
    } });
    await checkBeforeDone({ project: 'demo', task: 'edit src/schema.ts', summary: 'done' }, context);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: { lesson: 'lesson_judged', none: 'no_applicable_rules', failed: 'failed', timeout: 'queued' }[kind] });
  }
});

test('completed queue metadata contains measured wait and service totals rather than zero ETA', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const queue = new Admission({ concurrency: 1, timeoutMs: 1000 });
    let state: ReturnType<Admission['snapshot']> | undefined;
    const running = queue.run(() => new Promise(resolve => setTimeout(resolve, 50)));
    const next = queue.run(() => new Promise(resolve => setTimeout(resolve, 20)), { onState: info => { state = info; } });
    await vi.advanceTimersByTimeAsync(70); await running; await next;
    expect(state).toMatchObject({ observed: { waitedMs: 50, serviceMs: 20 }, estimate: { source: 'measured', startMs: [50, 50], completionMs: [70, 70] } });
  } finally { vi.useRealTimers(); }
});


test('an unavailable outcome store cannot stretch the end-to-end check response indefinitely', async () => {
  const context = deps({ checkTimeoutMs: 30, k: { ...deps().k, recordPreDoneCheck: async () => new Promise(() => {}) } });
  const started = Date.now();
  const result = await checkBeforeDone({ project: 'demo', task: 'edit src/schema.ts', summary: 'done' }, context);
  expect(Date.now() - started).toBeLessThan(200);
  expect(result.recorded).toBe(false);
});
