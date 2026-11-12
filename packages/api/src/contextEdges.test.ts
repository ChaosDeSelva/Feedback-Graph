import { shownProjects, type ActivityInput, type CodeMapMeta, type DocHit, type Lesson, type ModuleContext, type ProjectLink, type StoredFact } from '@fb/core';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { QueueInfo } from './admission.ts';
import { Admission } from './admission.ts';
import { checkBeforeDone, clipAtBoundary, getImpact, getModuleContext, getRecentSessions, getTaskContext, hashRepoFile, makeJudge, queueDescription, reportFeedback, searchGraph, taskFiles, type ContextDeps } from './context.ts';

const roots = [{ host: '/Users/j/Vibe', container: '/vibe' }];

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `Title ${id}`, rule: `Rule ${id}`, appliesWhen: 'always', scope: 'project', paths: ['src/orders.ts'],
  status: 'approved', source: 'postmortem', cause: 'requirement_unstated', missId: null, createdAt: 't', decidedAt: 't', ...over,
});
const doc = (o: Partial<DocHit> = {}): DocHit => ({ docId: 'doc:1', source: 'github', ref: 'acme/demo#5', title: 'Orders PR', url: null, text: 'orders review: paginate orders', score: 0.95, ...o });
const fact = (o: Partial<StoredFact> = {}) => ({
  id: 'fact:1', kind: 'convention', statement: 'Orders are paginated', path: 'src/orders.ts', lines: null, confidence: 0.9, why: '', source: 'scan', createdAt: '2026-11-01T12:00:00Z',
  scanJobId: null, fileHash: null, fileSummary: null, relevance: 1, relevanceBy: null, docId: null, ...o,
}) as StoredFact;
const link = (a: string, o: Partial<ProjectLink> = {}): ProjectLink => ({ id: `link:${a}|demo`, a, b: 'demo', relation: 'depends_on', note: '', status: 'confirmed', source: 'you', score: 0, evidence: [], createdAt: 't', updatedAt: 't', decidedBy: 'you', ...o });
const shown = (...keys: string[]) => () => shownProjects({ tracked: keys, initialized: true }, { excludeProjects: [] }, new Map());

function deps(over: Partial<ContextDeps> = {}): ContextDeps & { logged: ActivityInput[] } {
  const logged: ActivityInput[] = [];
  return {
    roots,
    embed: async (texts) => texts.map(() => [1, 0]),
    k: { searchLessons: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:1' },
    judge: async () => [],
    activity: { record: async (a) => { logged.push(a); } },
    logged,
    ...over,
  } as ContextDeps & { logged: ActivityInput[] };
}

describe('the files an agent names', () => {
  test('without a cwd an absolute path is dropped, and a named secret file is counted, never listed', async () => {
    expect(taskFiles({ project: 'demo', files: ['/etc/orders.ts', 'src/orders.ts'] }, roots)).toEqual(['src/orders.ts']);
    const r = await getTaskContext({ project: 'demo', task: 'orders', files: ['/abs/.env', '.env'] }, deps());
    expect(r.markdown).toContain('## Code map for the files you named\n- 1 named credential file omitted');
    expect(r.markdown).not.toContain('.env');
  });

  test('a named folder is kept, however long; a base64 run is not (sweep 4 rel #2)', () => {
    const cwd = '/Users/j/Vibe/demo';
    for (const f of ['src/notify/internal/pagerules', 'src/notify/internal/pagerules/', 'packages/api/src'])
      expect(taskFiles({ project: 'demo', cwd, files: [f] }, roots)).toEqual([f.replace(/\/$/, '')]);
    expect(taskFiles({ project: 'demo', files: ['src/notify/internal/pagerules/'] }, roots)).toEqual(['src/notify/internal/pagerules/']);
    for (const key of [`${'YWJjZGVm'.repeat(3)}/YWJjZGVm`, 'MIIEvQIBADANBgkqhkiG9w0BAQEF', 'abc/def+ghi/jklmnopq=']) expect(taskFiles({ project: 'demo', cwd, files: [key] }, roots)).toEqual([]);
  });

  test('a file name with spaces is kept, named or quoted in the task; other whitespace is not (sweep 4 rel #4)', () => {
    const cwd = '/Users/j/Vibe/demo';
    const sql = 'db/migrations/20240117042139_initial tables.sql';
    expect(taskFiles({ project: 'demo', cwd, files: [sql, 'a\tb.ts', 'a\nb.ts', ' lead.ts'] }, roots)).toEqual([sql]);
    expect(taskFiles({ project: 'demo', cwd, task: `fix the index in \`${sql}\` and "src/My Folder/page one.tsx"` }, roots)).toEqual([sql, 'src/My Folder/page one.tsx']);
    // A quoted sentence is not a path (the path inside it still is).
    expect(taskFiles({ project: 'demo', cwd, task: 'he said "see the docs/notes on the release and the spec.md"' }, roots)).toEqual(['docs/notes']);
  });

  test('a long text is cut between words when no sentence ends in reach, and mid-word when there is no space', () => {
    expect(clipAtBoundary('alpha beta gamma delta epsilon zeta', 20)).toBe('alpha beta gamma…');
    expect(clipAtBoundary('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('get_task_context', () => {
  test('an unknown project is named by its key, or said to be missing when neither cwd nor key is given', async () => {
    expect((await getTaskContext({ project: '../x', task: 't' }, deps())).markdown).toContain('not a tracked project (../x)');
    expect((await getTaskContext({ task: 't' }, deps())).markdown).toContain('not a tracked project (no cwd given)');
  });

  test('a global lesson learned here and tied to a named file is served when its origin is selected', async () => {
    const global = lesson('g1', { projectKey: undefined, origin: 'demo', scope: 'global' });
    const elsewhere = lesson('g2', { projectKey: undefined, origin: 'other', scope: 'global' });
    const d = deps({ shown: shown('demo'), codegraph: { lessonsForPaths: async () => [{ lesson: global, paths: ['src/orders.ts'] }, { lesson: elsewhere, paths: ['src/orders.ts'] }] } });
    const r = await getTaskContext({ project: 'demo', task: 'orders', files: ['src/orders.ts'] }, d);
    expect(r.lessons.map((h) => h.lesson.id)).toEqual(['g1']);
  });

  test('with nothing approved, the backlog counts only selected projects and says "or more" at the listing cap', async () => {
    const asked: unknown[] = [];
    const d = deps({
      shown: shown('demo'),
      k: {
        ...deps().k,
        listLessons: async (q) => { asked.push(q.projectKeys); return q.status === 'proposed' ? Array.from({ length: 1000 }, (_, i) => lesson(`p${i}`, { status: 'proposed' })) : []; },
      },
    });
    const r = await getTaskContext({ project: 'demo', task: 'orders' }, d);
    expect(r.markdown).toContain('No lesson is approved for demo yet (1000 or more proposed, waiting on the Lessons page).');
    // The backlog's approved and proposed counts, and the approved lessons read for their triggers: all selected only.
    expect(asked).toEqual([['demo'], ['demo'], ['demo']]);
  });

  test('linked projects: an out-of-scope one is skipped, at most four are read, and without a document store none of their docs', async () => {
    const searched: string[] = [];
    const d = deps({
      links: { listLinks: async () => ['a1', 'secret', 'a2', 'a3', 'a4', 'a5'].map((a) => link(a)) },
      inScope: (k) => k !== 'secret',
      k: { ...deps().k, relatedMisses: async (q) => { searched.push(q.projectKey!); return []; } },
    });
    await getTaskContext({ project: 'demo', task: 'orders' }, d);
    expect(searched.sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'demo']);
  });

  test("a fact the agent's own session wrote is labelled so, its start read from the session record", async () => {
    const d = deps({
      facts: { searchFacts: async () => [{ fact: fact({ createdAt: '2026-11-01T12:00:00Z' }), score: 0.95 }] },
      sessions: { list: async () => ({ sessions: [], next: null }), detail: async () => ({ startedAt: '2026-11-01T10:00:00Z' }) } as never,
      codegraph: { lessonsForPaths: async () => [], sessionFiles: async () => [{ path: 'src/orders.ts', read: true, edited: true, firstEditAt: 't', lastEditAt: 't' }] },
    });
    const r = await getTaskContext({ project: 'demo', task: 'orders pagination', sessionId: 'sess-1' }, d);
    expect(r.markdown).toContain('`src/orders.ts` (convention): Orders are paginated · match 0.95 · from your own change this session');
  });

  test("a PR review is dropped as the task's own PR by its URL when its ref has no number, and kept when neither names one", async () => {
    const own = doc({ docId: 'doc:own', ref: 'review-1', url: 'https://github.com/acme/demo/pull/7', title: 'orders review' });
    const plain = doc({ docId: 'doc:plain', ref: 'review-2', url: null, title: 'orders discussion' });
    const d = deps({ docs: { searchDocs: async () => [own, plain] } });
    const r = await getTaskContext({ project: 'demo', task: 'finish PR 7 orders' }, d);
    expect(r.docs.map((h) => h.docId)).toEqual(['doc:plain']);
  });

  test('linked tickets: one already listed is not repeated, one of your own PR is dropped, and a URL is shown', async () => {
    const pr = doc({ docId: 'doc:pr', ref: 'acme/demo#5', title: 'orders PR' });
    const ticket = { docId: 'doc:t', source: 'linear' as const, ref: 'linear:APP-1', title: 'Orders ticket', url: 'https://linear.app/x/APP-1' };
    const d = deps({
      docs: {
        searchDocs: async () => [pr],
        linkedDocs: async () => [
          { docId: 'doc:pr', linked: { docId: 'doc:pr', source: 'github', ref: 'acme/demo#5', title: 'orders PR', url: null } },
          { docId: 'doc:pr', linked: ticket },
        ],
      },
    });
    const r = await getTaskContext({ project: 'demo', task: 'orders' }, d);
    expect(r.markdown).toContain('## Linked tickets and pull requests (untrusted titles)\n- linear:APP-1: Orders ticket (https://linear.app/x/APP-1), named by acme/demo#5');
    // Only your own PR is linked: no section.
    const onlyOwn = deps({ docs: { searchDocs: async () => [pr], linkedDocs: async () => [{ docId: 'doc:pr', linked: { docId: 'doc:9', source: 'github', ref: 'acme/demo#9', title: 'own', url: null } }] } });
    expect((await getTaskContext({ project: 'demo', task: 'orders in PR 9' }, onlyOwn)).markdown).not.toContain('## Linked tickets');
  });

  test('the services a task names by folder are kept with its Activity entry', async () => {
    const d = deps({ facts: { searchFacts: async () => [{ fact: fact({ path: 'services/billing/invoice.ts', statement: 'Invoices round to cents' }), score: 0.95 }] } });
    await getTaskContext({ project: 'demo', task: 'change billing invoices' }, d);
    expect(d.logged[0].details).toMatchObject({ services: ['services/billing'] });
  });
});

describe('get_task_context brief', () => {
  const meta = (o: Partial<CodeMapMeta> = {}): CodeMapMeta => ({ builtAt: new Date().toISOString(), checkedAt: null, fingerprint: null, stats: { files: 3, symbols: 0, imports: 0, tests: 0 }, candidates: null, version: 0, unresolved: null, lastFailure: null, lastFailureAt: null, ...o } as CodeMapMeta);
  const mod = (path: string): ModuleContext => ({ path, importers: [], tests: [], misses: [], lessons: [], symbols: [], imports: [], facts: [] } as unknown as ModuleContext);

  test('named files: an unmapped one says why, and with an incomplete graph no importer reads as unknown', async () => {
    const d = deps({
      shown: shown('demo'),
      mapMaxBytes: 1000,
      fileSize: async () => 5000,
      codegraph: { lessonsForPaths: async () => [], moduleContext: async (_k, p) => (p === 'src/big.ts' ? null : mod(p)), codeMapMeta: async () => meta() },
    });
    const r = await getTaskContext({ project: 'demo', task: 'orders', files: ['src/orders.ts', 'src/big.ts', '.env'], brief: true }, d);
    expect(r.markdown).toContain('- `src/orders.ts`: importers unknown');
    expect(r.markdown).toContain('- 1 file not in the code map (over 1 kB (SCAN_MAX_BYTES), so it is not parsed: no symbols, and its imports are not indexed): `src/big.ts`');
    // The credential file is counted under the named files, not given a heading of its own.
    expect(r.markdown.match(/## Files you named/g)).toHaveLength(1);
    expect(r.markdown).toContain('1 named credential file omitted');
    expect(r.markdown).not.toContain('## Code map for the files you named');
  });

  test('what did not fit is recorded with the brief', async () => {
    const rule = 'r'.repeat(140);
    const lessons = Array.from({ length: 4 }, (_, i) => lesson(`l${i}`, { title: `T${'t'.repeat(200)}${i}`, rule }));
    const d = deps({ codegraph: { lessonsForPaths: async () => lessons.map((l) => ({ lesson: l, paths: ['src/orders.ts'] })) } });
    const r = await getTaskContext({ project: 'demo', task: 'orders', files: ['src/orders.ts'], brief: true }, d);
    expect(r.markdown).toMatch(/Brief: left out .*lesson/);
    expect(d.logged[0].details).toMatchObject({ brief: true, cut: [expect.stringMatching(/lesson/)] });
  });
});

describe('more of get_task_context', () => {
  test('a hand-written global lesson (no project, no origin) on a file is shown wherever projects are selected', async () => {
    const handwritten = lesson('g0', { projectKey: undefined, origin: undefined, scope: 'global', title: 'Hand-written rule' });
    const mod: ModuleContext = { file: { path: 'src/orders.ts', lang: 'ts', hash: 'h', loc: 10, isTest: false, churn: null }, importers: [], tests: [], misses: [], lessons: [handwritten], symbols: [], imports: [], facts: [] };
    const d = deps({ shown: shown('demo'), codegraph: { lessonsForPaths: async () => [], moduleContext: async () => mod } });
    expect((await getModuleContext({ project: 'demo', path: 'src/orders.ts' }, d)).markdown).toContain('Hand-written rule');
  });

  test('without session records, a session id alone does not mark facts as the agent\'s own', async () => {
    const d = deps({
      facts: { searchFacts: async () => [{ fact: fact(), score: 0.95 }] },
      codegraph: { lessonsForPaths: async () => [], sessionFiles: async () => [{ path: 'src/orders.ts', read: true, edited: true, firstEditAt: 't', lastEditAt: 't' }] },
    });
    const r = await getTaskContext({ project: 'demo', task: 'orders pagination', sessionId: 'sess-1' }, d);
    expect(r.markdown).toContain('Orders are paginated');
    expect(r.markdown).not.toContain('from your own change');
  });

  test('a linked ticket with no URL is listed by its ref and title only', async () => {
    const d = deps({ docs: { searchDocs: async () => [doc()], linkedDocs: async () => [{ docId: 'doc:1', linked: { docId: 'doc:t', source: 'linear', ref: 'linear:APP-2', title: 'Ticket', url: null } }] } });
    expect((await getTaskContext({ project: 'demo', task: 'orders' }, d)).markdown).toContain('- linear:APP-2: Ticket, named by acme/demo#5');
  });

  test('brief: an unmapped file with no known reason just says so; a credential file with no code map gets the heading', async () => {
    const d = deps({ codegraph: { lessonsForPaths: async () => [], moduleContext: async () => null } });
    expect((await getTaskContext({ project: 'demo', task: 'orders', files: ['src/new.ts'], brief: true }, d)).markdown).toContain('- 1 file not in the code map (new, ignored, generated or not source): `src/new.ts`\n');
    const noMap = await getTaskContext({ project: 'demo', task: 'orders', files: ['.env'], brief: true }, deps());
    expect(noMap.markdown).toContain('\n## Code map for the files you named\n- 1 named credential file omitted');
  });
});

describe('search_graph', () => {
  test('an unknown project is said to be untracked', async () => {
    expect((await searchGraph({ cwd: '/tmp/x', query: 'orders' }, deps())).markdown).toMatch(/not a tracked project \(\/tmp\/x\)/);
    // A project key is not a directory.
    expect((await searchGraph({ project: 'nope', query: 'orders' }, { ...deps(), exists: () => false })).markdown).toMatch(/^This project key is not a tracked project \(nope\)/);
  });

  test('long docs are clipped, a URL is shown, the services named are recorded, and what was cut is recorded', async () => {
    const docs = Array.from({ length: 8 }, (_, i) => doc({ docId: `doc:${i}`, source: 'upload', ref: `notes-${i}.md`, title: `billing notes ${i}`, url: i === 0 ? 'https://example.com/n0' : null, text: `billing invoices ${'w '.repeat(400)}` }));
    const d = deps({
      docs: { searchDocs: async () => docs },
      facts: { searchFacts: async () => Array.from({ length: 12 }, (_, i) => ({ fact: fact({ id: `f${i}`, path: `services/billing/f${i}.ts`, statement: `Billing fact ${i} ${'s'.repeat(150)}` }), score: 0.95 })) },
    });
    const r = await searchGraph({ project: 'demo', query: 'billing invoices' }, d);
    expect(r.markdown).toContain('billing notes 0 (notes-0.md, https://example.com/n0)');
    expect(r.markdown).toMatch(/billing invoices (w ){100,}w?…/);
    expect(d.logged[0].details).toMatchObject({ tool: 'search_graph', services: ['services/billing'], cut: expect.any(Array) });
  });
});

describe('queueDescription', () => {
  const base: QueueInfo = {
    state: 'waiting', capacity: 2, running: 2, waiting: 1, position: 1, nextRetryPosition: 2, arrivalAhead: null, retained: false,
    estimate: { scope: 'judge', source: 'observed', samples: 3, startMs: [1000, 2000], completionMs: [3000, null], overdue: false }, retryAfterMs: null,
  };

  test('a completed check says whether it reused, joined or made its judge call', () => {
    expect(queueDescription({ ...base, state: 'completed', observed: { waitedMs: 0, serviceMs: 0, shared: 'reused' } })).toBe('Reused the verdict of an identical check; no new judge call was made.');
    expect(queueDescription({ ...base, state: 'completed', observed: { waitedMs: 1500, serviceMs: 2000, shared: 'joined' } }))
      .toBe('Joined an identical judge call already in progress; its verdict arrived after 1.5 s waiting and 2.0 s more.');
    expect(queueDescription({ ...base, state: 'completed', observed: { waitedMs: 500, serviceMs: 2500 } })).toBe('Judge completed after 0.5 s waiting and 2.5 s judging.');
    expect(queueDescription({ ...base, state: 'completed' })).toBe('Judge completed.');
  });

  test('an unfinished check says how long the judge has been on it, or how many checks are ahead, and when to call again', () => {
    expect(queueDescription({ ...base, state: 'retry_required', inFlight: { elapsedMs: 4200 }, retryAfterMs: 1500 }))
      .toBe('Not finished: the judge has been on this check for 4 s. Call check_before_done again with the same arguments in about 2 s.');
    expect(queueDescription({ ...base, position: 3 })).toBe('Not finished: the judge is busy (3 checks ahead of this one). Call check_before_done again with the same arguments in about 30 s.');
    // Not in the queue: the place a retry would take, less this check.
    expect(queueDescription({ ...base, state: 'retry_required', position: null, nextRetryPosition: 1 })).toBe('Not finished: the judge is busy. Call check_before_done again with the same arguments in about 30 s.');
  });
});

describe('makeJudge', () => {
  const hit = (id: string, over: Partial<Lesson> = {}) => ({ lesson: lesson(id, over), score: 1 });
  const provider = (...answers: unknown[]) => ({ id: 'f', agentic: false, json: async () => answers.shift() });

  test('verdicts keep the lessons they were given for, whatever the lesson ids look like', async () => {
    // Lesson ids that read like the judge's short ids (L1, L2), in the other order.
    const judge = makeJudge(provider({ verdicts: [
      { lessonId: 'L1', applies: true, status: 'not_addressed', why: 'no paging', evidence: [] },
      { lessonId: 'L2', applies: true, status: 'addressed', why: 'paged', evidence: [] },
    ] }));
    const out = await judge({ task: 't', summary: 's' }, [hit('l2'), hit('l1')]);
    expect(out.map((v) => [v.lessonId, v.status])).toEqual([['l2', 'not_addressed'], ['l1', 'addressed']]);
  });

  test('a verdict that names the lesson by its full id is taken as that lesson', async () => {
    const judge = makeJudge(provider({ verdicts: [{ lessonId: 'lesson:abc', applies: true, status: 'addressed', why: 'ok', evidence: [] }] }));
    expect((await judge({ task: 't', summary: 's' }, [hit('lesson:abc')]))[0]).toMatchObject({ lessonId: 'lesson:abc', status: 'addressed' });
  });

  test('a backed verdict from the first answer survives a second answer that is not JSON at all', async () => {
    const diff = 'diff --git a/src/orders.ts b/src/orders.ts\n--- a/src/orders.ts\n+++ b/src/orders.ts\n@@ -1,1 +1,2 @@\n context\n+const page = paginate(orders);\n';
    const judge = makeJudge(provider(
      { verdicts: [
        { lessonId: 'L1', applies: true, status: 'addressed', why: 'paged', evidence: ['+const page = paginate(orders);'] },
        { lessonId: 'L2', applies: true, status: 'not_addressed', why: 'no limit', evidence: [] },
      ] },
      'not json',
    ));
    const out = await judge({ task: 't', summary: 's', diff }, [hit('lesson:a'), hit('lesson:b')]);
    expect(out).toEqual([expect.objectContaining({ lessonId: 'lesson:a', status: 'addressed' })]);
  });

  test('a no-console.log rule flags only console.log, and a quoted escape does not end the string early', async () => {
    const rule = hit('lesson:c', { rule: 'Never use console.log in the api', paths: [] });
    const diff = (line: string) => `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n${line}\n`;
    const judge = makeJudge(provider({ verdicts: [{ lessonId: 'L1', applies: true, status: 'addressed', why: 'ok', evidence: [] }] }, { verdicts: [{ lessonId: 'L1', applies: true, status: 'addressed', why: 'ok', evidence: [] }] }));
    expect(await judge({ task: 't', summary: 's', diff: diff('+console.log("a \\" console.warn(x)");') }, [rule])).toEqual([expect.objectContaining({ status: 'not_addressed', evidence: ['+console.log("a \\" console.warn(x)");'] })]);
    // Inside the string, and a console.warn: the model decides.
    expect((await judge({ task: 't', summary: 's', diff: diff('+const s = "a \\" console.log(x)"; console.warn(s);') }, [rule]))[0]).toMatchObject({ status: 'addressed', why: 'ok' });
  });
});

// ── check_before_done ─────────────────────────────────────────────────

const fileDiff = (path: string, ...added: string[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${added.length + 1} @@\n context\n${added.map((l) => `+${l}`).join('\n')}\n`;
const miss = (id: string, missed: string, o: Record<string, unknown> = {}) => ({ missId: id, missed, cause: 'requirement_unstated' as const, feedbackText: 'again', sessionId: `s-${id}`, ts: '2026-10-01T10:00:00Z', score: 0.9, ...o });
const tied = (id: string, over: Partial<Lesson> = {}) => ({ lesson: lesson(id, over), score: 0.9 });

describe('check_before_done edges', () => {
  test('an unknown folder is said to be untracked, and nothing is judged or kept', async () => {
    const d = deps({ judge: async () => { throw new Error('never'); } });
    const r = await checkBeforeDone({ cwd: '/tmp/x', task: 't', summary: 's' }, d);
    expect(r.markdown).toMatch(/^This directory is not a tracked project \(\/tmp\/x\)/);
    expect(r.recorded).toBeNull();
  });

  test('a store that throws a non-Error fails the check with that value, recorded as failed with the session', async () => {
    const d = deps({ k: { ...deps().k, searchLessons: async () => { throw 'store offline'; }, recordPreDoneCheck: async () => { throw new Error('no db'); } } });
    await expect(checkBeforeDone({ project: 'demo', task: 'orders', summary: 's', sessionId: 'sess-9' }, d)).rejects.toBe('store offline');
    expect(d.logged).toEqual([expect.objectContaining({ kind: 'predone_check', details: { status: 'failed', notJudged: true, recorded: false, error: 'store offline', sessionId: 'sess-9' } })]);
  });

  test('a check that runs out of time before the judge queue: a fresh queue snapshot, or none without a queue', async () => {
    const hang = { embed: () => new Promise<number[][]>(() => {}) };
    const queued = await checkBeforeDone({ project: 'demo', task: 'orders', summary: 's' }, deps({ ...hang, checkTimeoutMs: 40, judgeQueue: new Admission({ concurrency: 1, timeoutMs: 1000 }) }));
    expect(queued).toMatchObject({ queued: true, status: 'queued', queue: { state: 'retry_required', arrivalAhead: null } });
    expect(queued.markdown).toContain('Not finished: the judge is busy');
    const bare = await checkBeforeDone({ project: 'demo', task: 'orders', summary: 's' }, deps({ ...hang, checkTimeoutMs: 40 }));
    expect(bare.queue).toBeUndefined();
    // No judge queue to describe: the plain retry line, and no lessons were known yet to check by hand.
    expect(bare.markdown).toBe('# Queued: pre-done check has not completed\nNothing was decided yet; a queued answer is not a completed check.\nCall check_before_done again with the same arguments.');
  });

  test('a judge that fails with a non-Error is "not judged", with its reason; one that fails at the deadline is "busy"', async () => {
    const lessons = { searchLessons: async () => [tied('l1')] };
    const failed = await checkBeforeDone({ project: 'demo', task: 'orders', summary: 's', filesChanged: ['src/orders.ts'] }, deps({ k: { ...deps().k, ...lessons }, judge: async () => { throw 'model gone'; } }));
    expect(failed.markdown).toMatch(/^# Not judged: the judge failed \(model gone\)/);
    // The judge's 120 ms and the 300 ms budget run on a fake clock, so a loaded machine cannot reorder them.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let late: Awaited<ReturnType<typeof checkBeforeDone>>;
    try {
      const pending = checkBeforeDone({ project: 'demo', task: 'orders', summary: 's', filesChanged: ['src/orders.ts'] }, deps({
        checkTimeoutMs: 300, k: { ...deps().k, ...lessons },
        judge: async () => { await new Promise((r) => setTimeout(r, 120)); throw new Error('late'); },
      }));
      await vi.advanceTimersByTimeAsync(300);
      late = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(late.markdown).toMatch(/^# Not judged: the check response budget was exhausted while waiting/);
  });

  test("an identical check that joins one in flight and runs out of time reports that call's retry priority", async () => {
    const judgeQueue = new Admission({ concurrency: 1, timeoutMs: 5000 });
    const d = (checkTimeoutMs: number) => deps({ judgeQueue, checkTimeoutMs, checkRetryIdentity: 'owner', k: { ...deps().k, searchLessons: async () => [tied('l1')] }, judge: () => new Promise(() => {}) });
    const q = { project: 'demo', task: 'orders', summary: 's', filesChanged: ['src/orders.ts'] };
    // On a fake clock, so a loaded machine cannot let the first time out before the second does.
    vi.useFakeTimers();
    try {
      // Joined while the first still waits for its verdict: no priority is held yet.
      const first = checkBeforeDone(q, d(400));
      await vi.advanceTimersByTimeAsync(30);
      const joined = checkBeforeDone(q, d(100));
      await vi.advanceTimersByTimeAsync(100);
      expect((await joined).queue).toMatchObject({ state: 'retry_required', arrivalAhead: 0, retryPriority: { retained: false } });
      // Once the first timed out, its call keeps running with priority held: a retry that joins it says so.
      await vi.advanceTimersByTimeAsync(300);
      expect((await first).queue).toMatchObject({ retryPriority: { retained: true } });
      const retry = checkBeforeDone(q, d(100));
      await vi.advanceTimersByTimeAsync(100);
      expect((await retry).queue).toMatchObject({ retryPriority: { retained: true } });
      expect((await retry).markdown).not.toContain('does not retain a queue position');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a check queued for ten seconds or more says the wait in whole seconds', async () => {
    vi.useFakeTimers();
    try {
      const judgeQueue = new Admission({ concurrency: 1, timeoutMs: 60_000 });
      let release!: () => void;
      const busy = judgeQueue.run(() => new Promise<void>((r) => { release = r; }));
      const pending = checkBeforeDone({ project: 'demo', task: 'orders', summary: 's', filesChanged: ['src/orders.ts'] }, deps({ judgeQueue, k: { ...deps().k, searchLessons: async () => [tied('l1')] }, judge: async () => [{ lessonId: 'l1', status: 'addressed', why: 'ok' }] }));
      await vi.advanceTimersByTimeAsync(12_000);
      release();
      await busy;
      const r = await pending;
      expect(r.markdown).toContain('Queued behind 1 check for 12 s before the judge read this one.');
    } finally { vi.useRealTimers(); }
  });

  test('a repo diff with no file headers is judged as "the files you changed"; one over the budget names what it left out', async () => {
    const judged = (repoDiff: ContextDeps['repoDiff']) => checkBeforeDone({ project: 'demo', task: 'orders', summary: 's', filesChanged: ['src/orders.ts'] }, deps({
      repoDiff, k: { ...deps().k, searchLessons: async () => [tied('l1')] }, judge: async () => [{ lessonId: 'l1', status: 'not_applicable', applies: true, why: 'n/a' }],
    }));
    expect((await judged(async () => ({ text: 'some change', files: ['src/orders.ts'] }))).markdown).toContain('Judged against the diff read from the repo for the files you changed');
    const d = deps({
      repoDiff: async () => ({ text: fileDiff('src/orders.ts', 'a'.repeat(20_000)) + fileDiff('src/other.ts', 'b'.repeat(20_000)), files: ['src/orders.ts'] }),
      k: { ...deps().k, searchLessons: async () => [tied('l1')] }, judge: async () => [{ lessonId: 'l1', status: 'not_applicable', applies: false, why: 'n/a' }],
    });
    await checkBeforeDone({ project: 'demo', task: 'orders', summary: 's', filesChanged: ['src/orders.ts'] }, d);
    expect(d.logged[0].details).toMatchObject({ diff: { source: 'repo', omitted: ['src/other.ts'] } });
  });

  test('a verdict backed by a quoted added line, a documentation file, or a call the lesson does not name', async () => {
    const run = (diff: string, why: string, status: 'addressed' | 'not_addressed', over: Partial<Lesson> = {}, changed = 'src/orders.ts') => checkBeforeDone({ project: 'demo', task: 'orders', summary: 's', diff, filesChanged: [changed] }, deps({
      k: { ...deps().k, searchLessons: async () => [tied('l1', over)] }, judge: async () => [{ lessonId: 'l1', status, applies: true, why }],
    }));
    // The reason quotes the added line with its + mark.
    expect((await run(fileDiff('src/orders.ts', 'paginate(orders);'), 'it adds `+paginate(orders);`', 'not_addressed')).gaps).toHaveLength(1);
    // A markdown file keeps its comment-like lines as evidence.
    const md = fileDiff('src/orders.ts', '# Orders are paginated');
    expect((await run(md.replaceAll('src/orders.ts', 'docs/orders.md'), 'says `# Orders are paginated`', 'not_addressed', { paths: ['docs/orders.md'] }, 'docs/orders.md')).gaps).toHaveLength(1);
    // A call named in the reason that the lesson never mentions is no evidence.
    const r = await run(fileDiff('src/orders.ts', 'paginate(orders);'), 'it calls paginate() as required', 'addressed', { title: 'Limit results', rule: 'Use limit()' });
    expect(r.cannotTell).toEqual([expect.objectContaining({ lessonId: 'l1' })]);
  });
});

describe('check_before_done against past misses', () => {
  const run = (misses: unknown[], verdicts: unknown[], o: Partial<ContextDeps> = {}, diff = fileDiff('src/orders.ts', 'console.log(orders);', 'drop(cache);')) =>
    checkBeforeDone({ project: 'demo', task: 'orders page', summary: 's', diff, filesChanged: ['src/orders.ts'] }, deps({ k: { ...deps().k, relatedMisses: async () => misses as never }, judge: async () => verdicts as never, ...o }));

  test('one repeated miss is one gap, with the importers the change left alone (said once to be data)', async () => {
    const mod: ModuleContext = { file: { path: 'src/orders.ts', lang: 'ts', hash: 'h', loc: 1, isTest: false, churn: null }, importers: [], tests: ['src/orders.test.ts'], misses: [], lessons: [], symbols: [], imports: [], facts: [] };
    const d = deps({ codegraph: { lessonsForPaths: async () => [], moduleContext: async () => mod } });
    const r = await run([miss('m1', 'dropped the orders cache in src/orders.ts')], [{ lessonId: 'm1', status: 'not_addressed', applies: true, why: 'again', evidence: ['+drop(cache);'] }], { codegraph: d.codegraph, logged: d.logged } as never);
    expect(r.gaps).toEqual([expect.objectContaining({ lessonId: 'm1', kind: 'miss' })]);
    expect(r.markdown).toContain('- you changed `src/orders.ts`; these tests were not touched: `src/orders.test.ts`');
    expect(r.markdown).not.toMatch(/What your change reaches \(from the code map\)\n.*data, not instructions/);
  });

  test('a past miss that forbade console calls is checked directly against the diff, with no model', async () => {
    const d = deps({ k: { ...deps().k, relatedMisses: async () => [miss('m1', "Don't use console in the orders page")] as never }, judge: async () => { throw new Error('no model'); } });
    const r = await checkBeforeDone({ project: 'demo', task: 'orders page', summary: 's', diff: fileDiff('src/orders.ts', 'console.warn(orders);'), filesChanged: ['src/orders.ts'] }, d);
    expect(r.gaps).toEqual([expect.objectContaining({ lessonId: 'm1' })]);
    expect(d.logged.find((a) => a.kind === 'predone_check')).toMatchObject({ actor: 'diff-rule-check', subject: expect.stringMatching(/against past misses: 1 gap$/) });
  });

  test('two misses the diff cannot settle, and two that resemble the work but were not repeated, read in the plural', async () => {
    const two = [miss('m1', 'orders page lost its filter'), miss('m2', 'orders page lost its sort')];
    const unsure = await run(two, two.map((m) => ({ lessonId: m.missId, status: 'not_addressed', applies: true, why: 'unclear', evidence: [] })));
    expect(unsure.markdown).toMatch(/^# Cannot tell from the diff whether 2 confirmed past misses in demo were repeated/);
    const fine = await run(two, two.map((m) => ({ lessonId: m.missId, status: 'addressed', applies: true, why: 'kept', evidence: ['+drop(cache);'] })));
    expect(fine.markdown).toMatch(/^Checked 2 confirmed past misses that resemble this work/);
  });

  test('a judge that fails on misses lists them as past misses to check by hand', async () => {
    const r = await run([miss('m1', 'orders page lost its filter'), miss('m2', 'orders page lost its sort')], [], { judge: async () => { throw new Error('down'); } });
    expect(r.markdown).toContain('Check it yourself against these past misses, or call check_before_done again in a minute:');
    const d = deps({ k: { ...deps().k, relatedMisses: async () => [miss('m1', 'orders page lost its filter')] as never }, judge: async () => { throw new Error('down'); } });
    await checkBeforeDone({ project: 'demo', task: 'orders page', summary: 's', filesChanged: ['src/orders.ts'] }, d);
    expect(d.logged[0].details).toMatchObject({ misses: [{ id: 'm1' }] });
  });

  test('a miss naming another file is judged only when it names a changed one, even off topic', async () => {
    const r = await run([miss('m1', 'broke the cache warmup in src/billing.ts')], [{ lessonId: 'm1', status: 'addressed', applies: true, why: 'fine', evidence: ['+drop(cache);'] }]);
    expect(r.markdown).toMatch(/^Checked 1 confirmed past miss that resembles this work/);
  });
});

// ── The code map ──────────────────────────────────────────────────────

describe('code map answers', () => {
  const meta = (o: Partial<CodeMapMeta> = {}): CodeMapMeta => ({ builtAt: '2026-01-01T00:00:00Z', checkedAt: null, fingerprint: null, stats: { files: 3, symbols: 0, imports: 0, tests: 0 }, candidates: null, version: 99, unresolved: 0, lastFailure: null, lastFailureAt: null, ...o } as CodeMapMeta);
  const mod = (o: Partial<ModuleContext> = {}): ModuleContext => ({ file: { path: 'src/orders.ts', lang: 'ts', hash: 'h', loc: 1, isTest: true, churn: null }, importers: [], tests: [], misses: [], lessons: [], symbols: [], imports: [], facts: [], ...o });

  test('without a code map, an unknown project or none of the paths a file, impact and module context say so', async () => {
    expect((await getModuleContext({ project: 'demo', path: 'src/a.ts' }, deps())).markdown).toBe('The code map is not available on this server.');
    expect((await getImpact({ project: 'demo', paths: ['src/a.ts'] }, deps())).markdown).toBe('The code map is not available on this server.');
    expect((await getImpact({ cwd: '/tmp/x', paths: ['src/a.ts'] }, deps())).markdown).toMatch(/not a tracked project/);
    const cg = { codegraph: { lessonsForPaths: async () => [], impact: async () => { throw new Error('never'); } } } as Partial<ContextDeps>;
    expect((await getImpact({ project: 'demo', paths: ['.env', '/etc/passwd'] }, deps(cg))).markdown).toBe('# Impact in demo\n- 1 named credential file omitted: secret-file paths and contents are never read, mapped, logged or echoed.\n- the other paths are not files in demo: give paths relative to your cwd, or absolute paths inside the project.');
    expect((await getImpact({ project: 'demo', paths: ['.env'] }, deps(cg))).markdown).not.toContain('other paths');
    expect((await getImpact({ project: 'demo', paths: ['/etc/passwd'] }, deps(cg))).markdown).toMatch(/^None of these paths is a file in demo/);
  });

  test('impact of files none of which is mapped: they are listed together, with the credential file counted', async () => {
    const d = deps({ codegraph: { lessonsForPaths: async () => [], impact: async () => ({ paths: [], dependents: [], tests: [], misses: [], lessons: [] }) as never, codeMapMeta: async () => meta() } });
    const r = await getImpact({ project: 'demo', paths: ['src/a.ts', 'src/b.ts', '.env'] }, d);
    expect(r.markdown).toMatch(/^`src\/a\.ts`, `src\/b\.ts` are not in the code map of demo/);
    expect(r.markdown).toContain('1 named credential file omitted');
    expect((await getImpact({ project: 'demo', paths: ['src/a.ts'] }, d)).markdown).not.toContain('credential');
  });

  test('a module: test file, fact lines, imported names, a lesson with no applies-when, a dated map note', async () => {
    const d = deps({ codegraph: { lessonsForPaths: async () => [], codeMapMeta: async () => meta({ checkedAt: 'not a date', lastFailureAt: '2026-11-01T00:00:00Z' }), moduleContext: async () => mod({
      facts: [fact({ lines: '3-9' }), fact({ id: 'f2', statement: 'No lines' })], imports: [{ to: 'src/db.ts', names: ['query'] }, { to: 'src/log.ts', names: [] }], lessons: [lesson('l1', { appliesWhen: '' })],
    }) } });
    const r = await getModuleContext({ project: 'demo', path: 'src/orders.ts' }, d);
    expect(r.markdown).toContain(' · test file');
    expect(r.markdown).toContain('- (convention) Orders are paginated · lines 3-9');
    expect(r.markdown).toContain('- `src/db.ts`: query');
    expect(r.markdown).toContain('- (convention) No lines\n');
    expect(r.markdown).toContain('- `src/log.ts`\n');
    expect(r.markdown).toContain('applies when: n/a');
    expect(r.markdown).toMatch(/Code map built \d+d ago/);
    expect(r.markdown).toContain('the latest rebuild failed at 2026-11-01T00:00:00Z.');
  });

  test('a file past the cap: its importers counted, and a map with no candidate count or readable build date', async () => {
    const outside = (importers: string[], candidates: number | null) => deps({ codegraph: { lessonsForPaths: async () => [], moduleContext: async (_k, p) => mod({ file: { ...mod().file, path: p }, importers, tests: [], outside: true }), codeMapMeta: async () => meta({ builtAt: 'never', candidates }) } });
    const r = await getModuleContext({ project: 'demo', path: 'src/big.ts' }, outside(['src/a.ts'], null));
    expect(r.markdown).toContain("`src/big.ts` is past the code map's cap (it holds 3 files: source and the most imported and changed files first)");
    expect(r.markdown).toContain('## Imported by (1)\n- `src/a.ts`');
    expect(r.markdown).not.toContain('Code map built');
    expect((await getModuleContext({ project: 'demo', path: 'src/big.ts' }, outside([], 9))).markdown).toContain('(it holds 3 of 9 files');
  });

  test("task context: files past the cap with tests or no importers, more than eight files, an incomplete map's reasons", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const d = deps({ codegraph: {
      lessonsForPaths: async () => [],
      moduleContext: async (_k, p) => (p === 'src/f0.ts' ? mod({ file: { ...mod().file, path: p }, tests: ['src/f0.test.ts'] })
        : p === 'src/f1.ts' ? mod({ file: { ...mod().file, path: p }, importers: [], tests: ['src/f1.test.ts'], outside: true })
        : p === 'src/f2.ts' ? mod({ file: { ...mod().file, path: p }, importers: ['src/f9.ts'], tests: [], outside: true }) : null),
      codeMapMeta: async () => meta({ builtAt: 'bad', lastFailureAt: '2026-11-01T00:00:00Z', lastFailure: 'disk full', unresolved: null }),
    } });
    const r = await getTaskContext({ project: 'demo', task: 'orders', files }, d);
    expect(r.markdown).toContain('- `src/f0.ts`: imported by no file found (import graph incomplete) · tests: `src/f0.test.ts`');
    // Files past the cap read like mapped ones (their module context comes from the import index).
    expect(r.markdown).toContain('- `src/f1.ts`: imported by no file found (import graph incomplete) · tests: `src/f1.test.ts`');
    expect(r.markdown).toContain('- `src/f2.ts`: imported by 1 file · no tests found (import graph incomplete)');
    expect(r.markdown).toContain('- 5 files not in the code map (new, ignored, generated or not source): `src/f3.ts`');
    expect(r.markdown).toContain('- and 2 more files: ask `get_module_context` for them');
    expect(r.markdown).toContain('the latest rebuild failed at 2026-11-01T00:00:00Z (disk full)');
    expect(r.markdown).toContain('the map of demo did not count the imports it could not follow');
  });

  test('freshness: the newest of a file\'s facts decides, whichever order they come in', async () => {
    const d = deps({
      facts: { searchFacts: async () => [], listFacts: async () => [fact({ createdAt: '2026-11-02T00:00:00Z', fileHash: 'h1' }), fact({ id: 'f2', createdAt: '2026-11-01T00:00:00Z', fileHash: 'h0' })] },
      fileHash: async () => 'h1',
    });
    expect((await getTaskContext({ project: 'demo', task: 'orders', files: ['src/orders.ts'] }, d)).markdown).toContain('- `src/orders.ts`: 2 facts, last refreshed 2026-11-02; the file is unchanged since');
  });

  test('a demo fact says it was seeded, not that its file changed', async () => {
    const d = deps({ facts: { searchFacts: async () => [], listFacts: async () => [fact({ fileHash: 'demo' })] }, fileHash: async () => 'h1' });
    const md = (await getTaskContext({ project: 'demo', task: 'orders', files: ['src/orders.ts'] }, d)).markdown;
    expect(md).toContain('- `src/orders.ts`: 1 fact, last refreshed');
    expect(md).toContain('; seeded by the demo; no scan has read this file yet');
    expect(md).not.toContain('changed since');
  });

  test('the context_served entry counts the misses on the named files with the similar ones (sweep 4 UI #3)', async () => {
    const fm = { missId: 'a', missed: 'lost the filter', cause: 'requirement_unstated' as const, causeExplanation: '', feedbackId: 'fb-a', feedbackText: 'x', sessionId: 's-a', ts: '2026-10-01T00:00:00Z', paths: ['src/orders.ts'], fixedHere: false, lessonId: null };
    const d = deps({ codegraph: { lessonsForPaths: async () => [], moduleContext: async () => mod({ misses: [fm] }) } });
    await getTaskContext({ project: 'demo', task: 'orders', files: ['src/orders.ts'] }, d);
    expect(d.logged.find((a) => a.kind === 'context_served')!.subject).toMatch(/: 0 lessons, 1 past miss, /);
  });

  test('misses on the named files: one text recorded twice keeps the newer, newest first', async () => {
    const fm = (id: string, missed: string, ts: string) => ({ missId: id, missed, cause: 'requirement_unstated' as const, causeExplanation: '', feedbackId: `fb-${id}`, feedbackText: 'x', sessionId: `s-${id}`, ts, paths: ['src/orders.ts'], fixedHere: false, lessonId: null });
    const d = deps({ codegraph: { lessonsForPaths: async () => [], moduleContext: async () => mod({ misses: [fm('a', 'lost the filter', '2026-10-01T00:00:00Z'), fm('b', 'lost the filter', '2026-10-03T00:00:00Z'), fm('c', 'lost the sort', '2026-10-03T00:00:00Z'), fm('d', 'lost the page', '2026-10-02T00:00:00Z')] }) } });
    const r = await getTaskContext({ project: 'demo', task: 'orders', files: ['src/orders.ts'] }, d);
    const section = r.markdown.slice(r.markdown.indexOf('## Past misses on the files you named'));
    expect(section.match(/^- lost the \w+/gm)).toEqual(['- lost the sort', '- lost the filter', '- lost the page']);
    expect(section).toContain('session s-b · 2026-10-03');
  });

  test('hashRepoFile: a directory or an unreadable file has no hash', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'fb-hash-'));
    mkdirSync(join(repo, 'dir'));
    writeFileSync(join(repo, 'locked.ts'), 'x');
    chmodSync(join(repo, 'locked.ts'), 0o000);
    expect(await hashRepoFile(repo, 'dir')).toBeNull();
    expect(await hashRepoFile(repo, 'locked.ts')).toBeNull();
  });
});

// ── Sessions and reports ──────────────────────────────────────────────

describe('recent sessions and reports', () => {
  test('without session summaries the server says so; a summary shows how far, the branch and what is pending', async () => {
    expect((await getRecentSessions({ project: 'demo' }, deps())).markdown).toBe('Session summaries are not available on this server.');
    const item = { id: 's1', projectKey: 'demo', source: 'claude', cwd: null, gitBranch: 'feat/x', startedAt: null, lastActivityAt: '2026-11-01T10:00:00Z', turnCount: 9, state: 'idle', snippet: 'x', summarizedThrough: { index: 7 }, summaryUpdatedAt: null, summaryVersion: 2, pendingTurns: 2 };
    const d = deps({ sessions: { list: async () => ({ sessions: [item], next: null }), detail: async () => ({ ...item, summary: { markdown: 'Did things.' } }) } as never });
    const r = await getRecentSessions({ project: 'demo' }, d);
    expect(r.markdown).toContain('- summarized through turn 7 of 9 · branch `feat/x` · 2 newer turns not summarized yet');
    expect(d.logged[0].details).toMatchObject({ sessions: [{ id: 's1', through: 7, version: 2 }] });
    const fresh = { ...item, gitBranch: null, summarizedThrough: null, pendingTurns: 0 };
    const unsummarized = deps({ sessions: { list: async () => ({ sessions: [fresh], next: null }), detail: async () => ({ ...fresh, summary: { markdown: 'Started.' } }) } as never });
    expect((await getRecentSessions({ project: 'demo' }, unsummarized)).markdown).toContain('\n- \n');
    expect(unsummarized.logged[0].details).toMatchObject({ sessions: [{ id: 's1', through: null }] });
  });

  test('a report without a cwd is filed against the project folder, and a long one is shortened in Activity', async () => {
    const made: unknown[] = [];
    const d = deps({ k: { ...deps().k, createManualFeedback: async (o) => { made.push(o); return 'manual:1'; } } });
    await reportFeedback({ project: 'demo', feedback: 'f'.repeat(100), whatWasDone: 'w' }, d);
    expect(made[0]).toMatchObject({ cwd: '/vibe/demo' });
    expect(d.logged[0].subject).toBe(`reported by an agent: "${'f'.repeat(80)}…"`);
  });
});

describe('makeJudge: what the model may answer', () => {
  test('a verdict for a lesson it was not given is dropped, and a general no-console rule flags any console call', async () => {
    const judge = makeJudge({ id: 'f', agentic: false, json: async () => ({ verdicts: [{ lessonId: 'L7', applies: true, status: 'addressed', why: 'ok', evidence: [] }, { lessonId: 'L1', applies: true, status: 'addressed', why: 'ok', evidence: [] }] }) });
    expect(await judge({ task: 't', summary: 's' }, [{ lesson: lesson('lesson:a'), score: 1 }])).toEqual([expect.objectContaining({ lessonId: 'lesson:a' })]);
    const direct = makeJudge({ id: 'f', agentic: false, json: async () => { throw new Error('never'); } });
    const out = await direct({ task: 't', summary: 's', diff: fileDiff('src/a.ts', 'console.warn(x);') }, [{ lesson: lesson('lesson:c', { rule: 'No console calls in the api', paths: [] }), score: 1 }]);
    expect(out).toEqual([expect.objectContaining({ status: 'not_addressed', evidence: ['+console.warn(x);'] })]);
  });
});

test('a file an agent names in NFD is looked up in NFC, as the code map stores it', () => {
  const cwd = '/Users/j/Vibe/demo';
  const nfd = (p: string) => p.normalize('NFD');
  expect(taskFiles({ project: 'demo', cwd, files: [nfd('src/café.ts'), nfd(`${cwd}/src/menü.ts`)] }, roots)).toEqual(['src/café.ts', 'src/menü.ts']);
  expect(taskFiles({ project: 'demo', files: [nfd('src/café.ts')] }, roots)).toEqual(['src/café.ts']);
});

test('from a session in a subfolder, a relative file is repo-relative, or relative to the cwd when only that exists', () => {
  const top = mkdtempSync(join(tmpdir(), 'fb-subdir-'));
  mkdirSync(join(top, 'demo-shop', 'src', 'routes'), { recursive: true });
  writeFileSync(join(top, 'demo-shop', 'src', 'routes', 'customers.ts'), '');
  const disk = [{ host: top, container: top }];
  const cwd = join(top, 'demo-shop', 'src');
  expect(taskFiles({ project: 'demo-shop', cwd, files: ['src/routes/customers.ts'] }, disk)).toEqual(['src/routes/customers.ts']);
  expect(taskFiles({ project: 'demo-shop', cwd, files: ['routes/customers.ts'] }, disk)).toEqual(['src/routes/customers.ts']);
  expect(taskFiles({ project: 'demo-shop', cwd, files: ['../README.md', `${cwd}/routes/x.ts`] }, disk)).toEqual(['README.md', 'src/routes/x.ts']);
  // Neither reading on disk (a new file): repo-relative.
  expect(taskFiles({ project: 'demo-shop', cwd, files: ['src/routes/new.ts'] }, disk)).toEqual(['src/routes/new.ts']);
  rmSync(top, { recursive: true, force: true });
});
