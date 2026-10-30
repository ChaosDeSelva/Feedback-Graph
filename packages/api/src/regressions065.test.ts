import { expect, test } from 'vitest';
import { gradeLessons, rankFacts, rankMisses, type Lesson } from '@fb/core';
import { Admission } from './admission.ts';
import { checkBeforeDone, getTaskContext, makeJudge, type ContextDeps } from './context.ts';
import { buildChatContext } from './chat.ts';

const lesson = (id = 'lesson:a', rule = 'Do not use console.log'): Lesson => ({ id, projectKey: 'demo', title: 'No console', rule, appliesWhen: 'editing app', scope: 'project', paths: ['src/app.ts'], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' });
const deps = (extra: Partial<ContextDeps> = {}): ContextDeps => ({ roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]], k: { searchLessons: async () => [{ lesson: lesson(), score: .9 }], relatedMisses: async () => [], createManualFeedback: async () => 'f1', recordPreDoneCheck: async () => {} }, judge: async () => [], ...extra });
const diff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const a = 1;\n+console.log("debug");\n';

test('an explicit no-console violation is evidence-backed on every run without a model guess', async () => {
  let called = 0;
  const judge = makeJudge({ id: 'fake', agentic: false, json: async () => { called++; return { verdicts: [] }; } });
  for (let i = 0; i < 35; i++) {
    const result = await checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'added debug', diff }, deps({ judge }));
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].evidence?.[0].line).toBe('+console.log("debug");');
    expect(result.cannotTell).toEqual([]);
  }
  expect(called).toBe(0);
});

test('console strings, comments and unrelated files do not become direct violations', async () => {
  const judge = makeJudge({ id: 'fake', agentic: false, json: async () => ({ verdicts: [{ lessonId: 'L1', status: 'cannot_tell', applies: true, why: 'unknown', evidence: [] }] }) });
  for (const line of ['// console.log("debug");', 'const text = "console.log(debug)";', '/*\n+ console.log("debug");\n+ */']) {
    const result = await judge({ task: 'edit', summary: 's', diff: diff.replace('console.log("debug");', line) }, [{ lesson: lesson(), score: 1 }]);
    expect(result[0].status).toBe('cannot_tell');
  }
});

test('150 checks queued behind a wedged embedder obey the total response budget', async () => {
  const d = deps({ checkTimeoutMs: 20, embed: async () => new Promise(() => {}) });
  const start = Date.now();
  const results = await Promise.all(Array.from({ length: 150 }, () => checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 's' }, d)));
  expect(Date.now() - start).toBeLessThan(500);
  expect(results.every((r) => r.queued && !r.gaps.length && r.markdown.startsWith('# Queued:'))).toBe(true);
});

test('queued judge admission cancels with its end-to-end caller and retry gets a fresh budget', async () => {
  const queue = new Admission({ concurrency: 1, timeoutMs: 10_000 });
  let calls = 0;
  const judge = async () => { calls++; return new Promise<never>(() => {}); };
  const d = deps({ checkTimeoutMs: 20, judgeQueue: queue, judge });
  await Promise.all(Array.from({ length: 20 }, () => checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 's' }, d)));
  await new Promise((r) => setTimeout(r, 5));
  expect(queue.waiting).toBe(0);
  expect(calls).toBe(1);
  const retry = await checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 's' }, deps({ checkTimeoutMs: 100, judge: async () => [{ lessonId: 'lesson:a', status: 'addressed', why: 'done' }] }));
  expect(retry.queued).toBeUndefined();
});

test('weighted ordering preserves the actual similarity and never serves a scored miss or fact below .78', () => {
  const misses = rankMisses([{ missed: 'src/other/file.ts', feedbackText: '', score: .79 }, { missed: 'src/app.ts', feedbackText: '', score: .59 }], 5, ['src/app.ts']);
  expect(misses.map((m) => m.score)).toEqual([.79]);
  const facts = rankFacts([{ fact: { path: 'src/other/file.ts', relevance: .3 } as never, score: .79 }, { fact: { path: 'src/app.ts', relevance: 1 } as never, score: .59 }], 5, ['src/app.ts']);
  expect(facts.map((h) => h.score)).toEqual([.79]);
  expect(gradeLessons([{ lesson: lesson(), score: .99 }], 'console', { projectKey: 'demo' })).toEqual({ follow: [], related: [] });
});

test('own PR review lessons and docs are both excluded, including comment identities', async () => {
  const own = lesson('lesson:github:acme/demo#17/review/9');
  own.missId = 'miss:github:acme/demo#17/review/9';
  const d = deps({ ownPrNumbers: async () => [17], k: { ...deps().k, searchLessons: async () => [{ lesson: own, score: 1 }, { lesson: lesson(), score: .9 }] }, docs: { searchDocs: async () => [{ docId: 'd', source: 'github', ref: 'github:acme/demo#17/comments/1', title: 'own', text: 'x', score: 1, url: null }] } });
  const result = await getTaskContext({ project: 'demo', task: 'edit src/app.ts' }, d);
  expect(result.lessons.map((h) => h.lesson.id)).toEqual(['lesson:a']);
  expect(result.docs).toEqual([]);
});

test('Ask includes a code-map file miss even when vector search finds no miss', async () => {
  const miss = { missId: 'miss:file', missed: 'Forgot authentication', cause: 'implementation_error', causeExplanation: 'x', feedbackId: 'f1', feedbackText: 'check auth', sessionId: 's1', ts: '2026-10-27', paths: ['src/app.ts'], fixedHere: false, lessonId: null };
  const context = deps({ codegraph: { lessonsForPaths: async () => [], moduleContext: async () => ({ file: {}, symbols: [], importers: [], imports: [], tests: [], facts: [], misses: [miss], lessons: [] }) } as never });
  const pack = await buildChatContext('demo', 'what does src/app.ts do?', [], { context, codeMap: async () => ({ fingerprint: null, builtAt: 't', stats: {}, candidates: null, files: [{ path: 'src/app.ts', lang: 'typescript', hash: 'h', loc: 1, isTest: false }], symbols: [], imports: [], outside: [] }) as never });
  expect(pack.context).toContain('Forgot authentication');
  expect(pack.sources.some((s) => s.kind === 'miss' && s.ref === 'src/app.ts')).toBe(true);
});


test('a permissive or conditional console lesson is left to the judge rather than inverted into a ban', async () => {
  const judge = makeJudge({ id: 'fake', agentic: false, json: async () => ({ verdicts: [{ lessonId: 'L1', status: 'cannot_tell', applies: true, why: 'conditional', evidence: [] }] }) });
  for (const rule of ['Allow console.log for CLI debugging', 'Do not use console.log unless this is a debug build']) {
    const result = await judge({ task: 'edit', summary: 's', diff }, [{ lesson: lesson('lesson:a', rule), score: 1 }]);
    expect(result[0].status).toBe('cannot_tell');
  }
});


test('the response deadline cancels the underlying embedding request instead of leaving Ollama queued', async () => {
  let signal: AbortSignal | undefined;
  const result = await checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 's' }, deps({ checkTimeoutMs: 20,
    embed: async (_texts, options) => { signal = options?.signal; return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); } }));
  expect(result.queued).toBe(true);
  expect(signal?.aborted).toBe(true);
});

test('task-named PR excludes its lessons and docs without commit lookup or a session identity', async () => {
  const own = lesson('lesson:github:acme/demo#14194/review/9');
  const d = deps({ k: { ...deps().k, searchLessons: async () => [{ lesson: own, score: .95 }] }, docs: { searchDocs: async () => [{ docId: 'own', source: 'github', ref: 'github:acme/demo#14194', title: 'own', text: 'x', score: .95, url: null }] } });
  const result = await getTaskContext({ project: 'demo', task: 'review PR #14194 in src/app.ts' }, d);
  expect(result.lessons).toEqual([]);
  expect(result.docs).toEqual([]);
});

test('Ask requests the exact named file even when token matching prefers siblings', async () => {
  const wanted = 'src/dialog/workos-invite-dialog.tsx';
  const requested: string[] = [];
  const miss = { missId: 'miss:exact', missed: 'Named file miss', cause: 'implementation_error', feedbackId: 'f', feedbackText: 'fix', sessionId: 's', ts: '2026-10-28', paths: [wanted], fixedHere: false, lessonId: null };
  const context = deps({ codegraph: { lessonsForPaths: async () => [], moduleContext: async (_key: string, path: string) => {
    requested.push(path); return { file: {}, symbols: [], importers: [], imports: [], tests: [], facts: [], misses: path === wanted ? [miss] : [], lessons: [] };
  } } as never });
  const files = [...Array.from({ length: 30 }, (_, i) => ({ path: `src/dialog/workos-invite-dialog-sibling-${i}.tsx`, lang: 'typescript', hash: 'h', loc: 1, isTest: false })), { path: wanted, lang: 'typescript', hash: 'h', loc: 1, isTest: false }];
  const pack = await buildChatContext('demo', 'What went wrong in workos-invite-dialog.tsx?', [], { context, codeMap: async () => ({ fingerprint: null, builtAt: 't', stats: {}, candidates: null, files, symbols: [], imports: [], outside: [] }) as never });
  expect(requested).toContain(wanted);
  expect(pack.context).toContain('Named file miss');
});

test('deadline response exposes judge capacity, a labeled cold-start estimate and no retained position', async () => {
  const queue = new Admission({ concurrency: 5, timeoutMs: 1000 });
  const result = await checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 's' }, deps({ checkTimeoutMs: 10, judgeQueue: queue, embed: async () => new Promise(() => {}) }));
  expect(result.markdown).toContain('Judge capacity: 5');
  expect(result.markdown).toContain('cold-start response-budget scenario');
  expect(result.queue).toMatchObject({ retained: false, estimate: { source: 'response_budget', samples: 0 } });
  expect(result.markdown).toContain('does not retain a queue position');
});
