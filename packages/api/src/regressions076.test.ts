import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { taskPrNumbers } from './diff.ts';
import { issueKeyPattern, mentionedPaths, pathAffinity, storeRequestSignal, type ActivityInput, type Lesson, type RelatedMiss } from '@fb/core';
import { Admission } from './admission.ts';
import { checkBeforeDone, getTaskContext, taskFiles, type ContextDeps } from './context.ts';

const lesson = (id = 'lesson:a', rule = 'Do not use console.log'): Lesson => ({ id, projectKey: 'demo', title: 'No console', rule, appliesWhen: 'editing app', scope: 'project', paths: ['src/app.ts'], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' });
const deps = (extra: Partial<ContextDeps> = {}): ContextDeps => ({ roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]], k: { searchLessons: async () => [{ lesson: lesson(), score: .9 }], missesNaming: async () => [], relatedMisses: async () => [], createManualFeedback: async () => 'f1', recordPreDoneCheck: async () => {} }, judge: async () => [], ...extra });
const doc = (title: string, text: string) => ({ docId: title, source: 'linear' as const, ref: `linear:${title}`, title, text, score: .95, url: null });

test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('task and doc words that name prototype members (%s) do not break doc relevance', async (word) => {
  const d = deps({ docs: { searchDocs: async () => [doc(`${word} handling`, `the ${word} path in the parser`), doc('unrelated', 'billing export')] } });
  const task = `fix the ${word} check in the parser`;
  expect((await getTaskContext({ project: 'demo', task }, d)).docs.map((h) => h.title)).toEqual([`${word} handling`]);
  await expect(getTaskContext({ project: 'demo', task, brief: true }, d)).resolves.toMatchObject({ project: { key: 'demo' } });
});

const memoryDiff = 'diff --git a/config.yml b/config.yml\n--- a/config.yml\n+++ b/config.yml\n@@ -1 +1 @@\n-memory: 256Mi\n+memory: 1Gi\n';
const configLesson = (rule: string): Lesson => ({ ...lesson('org', rule), title: 'Keep organization ids scoped', paths: ['config.yml'], appliesWhen: 'editing config, e.g. request routing' });
const memoryCheck = (rule: string) => checkBeforeDone({ project: 'demo', task: 'increase memory', summary: 'raised the limit', filesChanged: ['config.yml'], diff: memoryDiff }, deps({
  k: { ...deps().k, searchLessons: async () => [{ lesson: configLesson(rule), score: .9 }] },
  judge: async () => [{ lessonId: 'org', status: 'not_addressed', applies: true, why: 'organization scoping is absent', evidence: ['+memory: 1Gi'] }],
}));

test.each([
  "Don't drop the authenticated organization id; I'm told every request needs it.",
  'Use the authenticated organization id (e.g. from the session) for every request.',
])('the memory guard stays on for a lesson whose only unit-like letters are prose: %s', async (rule) => {
  const result = await memoryCheck(rule);
  expect(result.gaps).toEqual([]);
  expect(result.cannotTell?.map((item) => item.lessonId)).toEqual(['org']);
});

test.each(['Keep the organization pod limit at 512Mi.', 'Keep the organization pod limit at 512 mb and the worker at 2 gb.', 'Keep the organization pod at 2GB.'])('a lesson that names a memory size still accepts a memory-size line as evidence: %s', async (rule) => {
  const result = await memoryCheck(rule);
  expect(result.gaps.map((gap) => gap.lessonId)).toEqual(['org']);
});

test('a lowercase duration is not a memory size, so the guard stays on', async () => {
  const result = await memoryCheck('Expire the organization cache after 45m.');
  expect(result.gaps).toEqual([]);
  expect(result.cannotTell?.map((item) => item.lessonId)).toEqual(['org']);
});

describe('issue keys in a check', () => {
  const miss = (missId: string, missed: string, feedbackText = '') => ({ missId, missed, feedbackText, cause: 'requirement_unstated' as const, sessionId: 's', ts: 't', score: .9 });
  const cipher = miss('cipher', 'encryption key rotation skipped the payload cipher', 'rotate the payload cipher key');
  // Like the stores: relatedMisses is the nearest k, missesNaming a text match over all of them.
  const naming = (misses: RelatedMiss[]) => async ({ keys, k }: { keys: string[]; k: number }) => {
    const pattern = new RegExp(issueKeyPattern(keys), 'i');
    return misses.filter((m) => pattern.test(m.missed) || pattern.test(m.feedbackText)).slice(0, k);
  };
  const judgedFor = async (task: string, misses: ReturnType<typeof miss>[], replies: string[] = []) => {
    const judged: string[][] = [];
    const d = deps({
      k: { ...deps().k, searchLessons: async () => [], relatedMisses: async ({ k }) => misses.slice(0, k), missesNaming: naming(misses) },
      judge: async (_work, lessons) => { judged.push(lessons.map((hit) => hit.lesson.id)); return lessons.map((hit) => ({ lessonId: hit.lesson.id, status: 'not_applicable' as const, why: 'n/a' })); },
    });
    replies.push((await checkBeforeDone({ project: 'demo', task, summary: 'rotated the payload cipher key' }, d)).markdown);
    return judged;
  };

  test.each(['AES-256', 'HTTP-2', 'HTTP-1.1', 'RFC-7231', 'CVE-2026', 'PR-4', 'PEP-8', 'HTML-5', 'OAUTH-2', 'BASE-64', 'ARM-64', 'X86-64', 'WCAG-21', 'K8S-1', 'TLS-13'])('%s in a task is not an issue key that hides topical misses', async (ref) => {
    expect(await judgedFor(`rotate the payload cipher key per ${ref}`, [cipher])).toEqual([['cipher']]);
  });

  test('a standard numbered like a size stays a standard when a miss names one from its series', async () => {
    const aes = miss('aes', 'the payload cipher used AES-128', 'rotate the payload cipher key');
    expect(await judgedFor('rotate the payload cipher key per AES-256', [aes, cipher])).toEqual([['aes', 'cipher']]);
  });

  const cold = miss('cold', 'SHOP-77 left the cache cold');

  test('a key a miss names exactly adds that miss, keeps the topical ones and drops pathless misses off the topic', async () => {
    const other = miss('other', 'SHOP-140 broke the invoice export');
    expect(await judgedFor('rotate the payload cipher key for SHOP-140', [cipher, cold, other])).toEqual([['cipher', 'other']]);
    expect(await judgedFor('rotate the payload cipher key for SHOP-1400', [cipher, cold, other])).toEqual(await judgedFor('rotate the payload cipher key', [cipher, cold, other]));
  });

  test('a miss naming the key is judged however far down the search it ranks', async () => {
    const others = Array.from({ length: 14 }, (_, i) => ({ ...miss(`r${i}`, `the report in src/reports/r${i}.ts was wrong`), score: .85 }));
    const ticket = { ...miss('ticket', 'SHOP-140 broke the invoice export'), score: .3 };
    expect(await judgedFor('rotate the payload cipher key for SHOP-140', [cipher, ...others, ticket])).toEqual([['cipher', 'ticket']]);
  });

  test('a miss naming the key is judged when it ranks below every other miss, however many there are', async () => {
    const charts = Array.from({ length: 60 }, (_, i) => ({ ...miss(`chart${i}`, `the chart colours on the dashboard were wrong ${i}`), score: .9 - i / 1000 }));
    const zed = { ...miss('zed', 'ZED-77: the archive restore dropped file permissions'), score: .2 };
    const judged = await judgedFor('Fixes ZED-77: fix the chart colours on the dashboard', [cipher, ...charts, zed]);
    expect(judged[0]).toContain('zed');
  });

  test('every named ticket gets a judged miss, one per key in turn', async () => {
    const tickets = ['APP-4521', 'PROJ-77', 'GH-1234'].flatMap((key, i) => [0, 1, 2].map((j) => ({ ...miss(`${key}#${j}`, `${key} broke the invoice export ${j}`), score: .5 - i / 10 - j / 100 })));
    const replies: string[] = [];
    const [judged] = await judgedFor('Fixes APP-4521, PROJ-77 and GH-1234', [cipher, ...tickets], replies);
    expect(judged).toEqual(['cipher', 'APP-4521#0', 'PROJ-77#0', 'GH-1234#0', 'APP-4521#1', 'PROJ-77#1', 'GH-1234#1']);
    // The rest are named in the reply, not dropped silently.
    expect(replies[0]).toContain('Not judged: 3 more past misses name APP-4521, PROJ-77, GH-1234');
    expect(replies[0]).toContain('APP-4521#2, PROJ-77#2, GH-1234#2');
  });

  test('"Not judged" names the keys of the misses left out, not every key of the work (sweep 4 rel #3)', async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `END-${i + 1}`);
    const tickets = keys.map((key, i) => ({ ...miss(`tk${i}`, `${key} broke the invoice export`), score: .5 - i / 100 }));
    const replies: string[] = [];
    const [judged] = await judgedFor(`Fixes ${keys.join(', ')}`, [cipher, ...tickets], replies);
    const left = tickets.filter((t) => !judged.includes(t.missId));
    expect(left.length).toBeGreaterThan(0);
    const named = /Not judged: \d+ more past misses? names? ([^(]+) \(/.exec(replies[0])![1].trim().split(', ');
    expect(named).toEqual(left.map((t) => keys[tickets.indexOf(t)]));
  });

  test('a miss naming the key does not take a topical miss\'s place', async () => {
    const keyedCipher = miss('keyed', 'SHOP-140 rotated the payload cipher key twice');
    const cipher2 = miss('cipher2', 'the payload cipher key was logged');
    expect(await judgedFor('rotate the payload cipher key for SHOP-140', [keyedCipher, cipher, cipher2])).toEqual([['cipher', 'cipher2', 'keyed']]);
  });

  test('a key no miss names changes nothing', async () => {
    const other = miss('other', 'SHOP-140 broke the invoice export');
    expect(await judgedFor('rotate the payload cipher key for SHOP-91', [cipher, cold, other])).toEqual(await judgedFor('rotate the payload cipher key', [cipher, cold, other]));
  });

  test.each(['ISO-8601', 'RFC-9110', 'RFC-7231', 'ECMA-262', 'AES-192', 'WCAG-22', 'PEP-440', 'IOS-17', 'NODE-22'])('a standard a miss also names (%s) adds that miss without hiding the topical one', async (ref) => {
    const std = miss('std', `the audit log ignored ${ref}`);
    expect(await judgedFor(`rotate the payload cipher key per ${ref}`, [cipher, std])).toEqual([['cipher', 'std']]);
  });

  test.each([
    ['APP-7', 'APP-7'], ['APP-12', 'APP-12'], ['APP-64', 'APP-64'], ['APP-2048', 'APP-2048'], ['APP-1999', 'APP-1999'], ['APP-2026', 'APP-2026'],
    ['ABC2-15', 'ABC2-15'], ['WAREHOUSING-42', 'WAREHOUSING-42'], ['PROJ-077', 'PROJ-077'], ['APP-1234567', 'APP-1234567'], ['alex/app-4521-fix', 'APP-4521'],
  ])('a ticket a miss names (%s) is judged with the topical miss', async (ref, key) => {
    const ticket = miss('ticket', `${key} broke the invoice export`);
    expect(await judgedFor(`rotate the payload cipher key on ${ref}`, [cipher, cold, ticket])).toEqual([['cipher', 'ticket']]);
  });
});

test('an unbracketed "pull request N of M" is a series counter, not a PR identity', () => {
  expect(taskPrNumbers('pull request 1 of 2: add the export')).toEqual([]);
  expect(taskPrNumbers('Stack: pull request 2/3, see #14036')).toEqual([14036]);
  expect(taskPrNumbers('address pull request 14036 of 2 open ones')).toEqual([14036]);
});

describe('linked-project docs', () => {
  const link = { id: 'link', a: 'demo', b: 'payments', status: 'confirmed', relation: 'same product', note: '', createdAt: 't', decidedAt: 't' };
  const linkedDocs = (docs: ReturnType<typeof doc>[]) => deps({
    links: { listLinks: async () => [link] } as never,
    docs: { searchDocs: async (q) => (q.projectKey === 'payments' ? docs : []) },
  });
  const linkedTitles = async (task: string, docs: ReturnType<typeof doc>[]) => (await getTaskContext({ project: 'demo', task }, linkedDocs(docs))).linked.flatMap((x) => x.docs.map((h) => h.title));

  test('one shared common word does not bring a linked project doc', async () => {
    expect(await linkedTitles('add a revenue chart to the billing export', [doc('Charts', 'Dashboard charts use the shared palette.')])).toEqual([]);
    expect(await linkedTitles('switch the invoice theme', [doc('Theme tokens', 'Dark theme colours live in tokens.css.')])).toEqual([]);
  });

  test('the layout folders of a path in the task are not topics', async () => {
    const refunds = doc('PR #43: refund export', 'Exports refunds in src/exports/refunds.ts with a revenue summary.');
    expect(await linkedTitles('add a revenue chart in src/routes/customers.ts', [refunds])).toEqual([]);
    expect(await linkedTitles('add a revenue chart in packages/app/src/lib/customers.ts', [refunds])).toEqual([]);
    expect(await linkedTitles('add the revenue total to src/routes/refunds.ts', [refunds])).toEqual(['PR #43: refund export']);
  });

  test('a Windows path in the task is split like a forward-slash one', async () => {
    const refunds = doc('PR #43: refund export', 'Exports refunds in src/exports/refunds.ts with a revenue summary.');
    expect(await linkedTitles('add a revenue chart in src\\routes\\customers.ts', [refunds])).toEqual([]);
    expect(await linkedTitles('add a revenue chart in packages\\app\\src\\lib/customers.ts', [refunds])).toEqual([]);
    expect(await linkedTitles('add the revenue total to src\\routes\\refunds.ts', [refunds])).toEqual(['PR #43: refund export']);
    const webhooks = doc('Webhook error handling', 'Error handling for webhook retries lives in src/webhooks/retry.ts.');
    expect(await linkedTitles('add retry logging in src\\webhooks\\retry.ts', [webhooks])).toEqual(['Webhook error handling']);
  });

  test('a domain folder of a path in the task is a topic', async () => {
    const webhooks = doc('Webhook error handling', 'Error handling for webhook retries lives in src/webhooks/retry.ts.');
    expect(await linkedTitles('add retry logging in src/webhooks/retry.ts', [webhooks])).toEqual(['Webhook error handling']);
  });

  test('two shared topics, or one naming the linked project, still bring it', async () => {
    expect(await linkedTitles('add a revenue chart with the shared palette', [doc('Charts', 'Dashboard charts use the shared palette.')])).toEqual(['Charts']);
    expect(await linkedTitles('call payments from the invoice page', [doc('Payments webhooks', 'Webhooks retry for a day.')])).toEqual(['Payments webhooks']);
  });
});

// Check budgets, slow writes and slow judges run on fake timers and a fake clock: each test says when time passes, so a
// loaded machine cannot reorder a deadline and the work it races. Waits for promise chains use node:timers, which stays real.
const fakeClock = () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });
};

describe('every check attempt leaves exactly one predone_check Activity entry', () => {
  fakeClock();
  /** Runs a check out on the fake clock: its store retries and its whole budget pass. */
  const settled = async <T>(check: Promise<T>) => { await vi.advanceTimersByTimeAsync(10_000); return check; };
  const never = () => new Promise<never>(() => {});
  const run = async (extra: Partial<ContextDeps>) => {
    const entries: ActivityInput[] = [];
    const d = deps({ checkTimeoutMs: 1000, activity: { record: async (input) => { entries.push(input); } }, ...extra });
    const pending = checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    await nextTurn();
    return { result, checks: entries.filter((e) => e.kind === 'predone_check') };
  };

  test('completed', async () => {
    const { result, checks } = await run({ judge: async () => [{ lessonId: 'lesson:a', status: 'addressed', applies: true, why: 'done' }] });
    expect(result.queued).toBeUndefined();
    expect(checks).toHaveLength(1);
  });


  test('timed out while embedding', async () => {
    const { result, checks } = await run({ embed: never });
    expect(result.queued).toBe(true);
    expect(checks).toHaveLength(1);
  });

  test.each([
    ['embedding', { embed: async () => { throw new Error('embedding failed'); } }],
    ['the graph search', { k: { ...deps().k, searchLessons: async () => { throw new Error('The graph request exceeded its deadline'); } } }],
  ] as [string, Partial<ContextDeps>][])('failed in %s', async (_where, extra) => {
    const entries: ActivityInput[] = [];
    const d = deps({ checkTimeoutMs: 1000, activity: { record: async (input) => { entries.push(input); } }, ...extra });
    await settled(expect(checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d)).rejects.toThrow());
    const checks = entries.filter((e) => e.kind === 'predone_check');
    expect(checks).toHaveLength(1);
    expect(checks[0].details).toMatchObject({ status: 'failed', notJudged: true });
  });

  test('failed, with a store slower than a second: its entry gets the rest of the budget', async () => {
    const entries: ActivityInput[] = [];
    const slow = async (input: ActivityInput) => {
      const signal = storeRequestSignal();
      await new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, 1500); signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }); });
      entries.push(input);
    };
    const d = deps({ checkTimeoutMs: 10_000, embed: async () => { throw new Error('ollama embed 500'); }, activity: { record: slow } });
    const failed = expect(checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d)).rejects.toThrow('ollama embed 500');
    // The slow store's 1.5 s and the check's 10 s budget run on the fake clock.
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(entries.filter((e) => e.kind === 'predone_check')).toMatchObject([{ details: { status: 'failed' } }]);
  });

  test('failed, and so did its entry: the lost entry is logged', async () => {
    const logged: [string, object | undefined][] = [];
    const d = deps({ checkTimeoutMs: 1000, embed: async () => { throw new Error('ollama embed 500'); },
      activity: { record: async () => { throw new Error('graph write refused'); } }, log: (msg, extra) => { logged.push([msg, extra]); } });
    await settled(expect(checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d)).rejects.toThrow('ollama embed 500'));
    expect(logged).toMatchObject([['predone_check activity entry not written', { project: 'demo', status: 'failed', error: 'graph write refused' }]]);
  });

  test('failed while the store refuses connections, which recovers inside the budget: exactly one entry, nothing logged', async () => {
    const entries: ActivityInput[] = [];
    const logged: string[] = [];
    const down = Date.now() + 700;
    const d = deps({ checkTimeoutMs: 3000, embed: async () => { throw new Error('The graph store is temporarily unavailable'); }, log: (msg) => { logged.push(msg); },
      activity: { record: async (input) => { if (Date.now() < down) throw new Error('Failed to connect to server'); entries.push(input); } } });
    await settled(expect(checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d)).rejects.toThrow('temporarily unavailable'));
    expect(entries.filter((e) => e.kind === 'predone_check')).toMatchObject([{ details: { status: 'failed', notJudged: true } }]);
    expect(logged).toEqual([]);
  });

  test('failed before it knew its project, while the store refuses connections: the project is resolved once it answers', async () => {
    const entries: ActivityInput[] = [];
    const down = Date.now() + 700;
    const refused = () => { if (Date.now() < down) throw new Error('Failed to connect to server'); };
    const d = deps({ checkTimeoutMs: 3000, inScope: async (key) => { refused(); return key === 'demo'; },
      activity: { record: async (input) => { refused(); entries.push(input); } } });
    await settled(expect(checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d)).rejects.toThrow('Failed to connect'));
    expect(entries.filter((e) => e.kind === 'predone_check')).toMatchObject([{ projectKey: 'demo', details: { status: 'failed' } }]);
    // A project that turns out not to be selected gets no entry.
    entries.length = 0;
    const later = Date.now() + 700;
    await settled(expect(checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, { ...d, inScope: async () => { if (Date.now() < later) throw new Error('Failed to connect to server'); return false; } })).rejects.toThrow('Failed to connect'));
    expect(entries).toEqual([]);
  });

  test('failed writing its own entry', async () => {
    const saved: ActivityInput[] = [];
    let calls = 0;
    const d = deps({ checkTimeoutMs: 1000, judge: async () => [{ lessonId: 'lesson:a', status: 'addressed', applies: true, why: 'done' }],
      activity: { record: async (input) => { if (calls++ === 0) throw new Error('write refused'); saved.push(input); } } });
    await settled(expect(checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d)).rejects.toThrow('write refused'));
    expect(saved.filter((e) => e.kind === 'predone_check')).toMatchObject([{ details: { status: 'failed' } }]);
  });

  test('timed out while its own entry is being written', async () => {
    const entries: ActivityInput[] = [];
    const d = deps({ checkTimeoutMs: 200, judge: async () => [{ lessonId: 'lesson:a', status: 'addressed', applies: true, why: 'done' }],
      activity: { record: (input) => { entries.push(input); return new Promise<void>((resolve) => setTimeout(resolve, 300)); } } });
    const pending = checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d);
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    await vi.advanceTimersByTimeAsync(200);
    expect(result.queued).toBe(true);
    expect(entries.filter((e) => e.kind === 'predone_check')).toHaveLength(1);
  });
});

describe('a kept-alive judge call', () => {
  fakeClock();
  test('a check that times out while its kept-alive judge call runs says a retry joins it, not that nothing is retained', async () => {
    const queue = new Admission({ concurrency: 1, timeoutMs: 10_000 });
    let calls = 0;
    const d = deps({ checkTimeoutMs: 1000, judgeQueue: queue, checkRetryIdentity: 'owner',
      judge: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 1500)); return [{ lessonId: 'lesson:a', status: 'addressed' as const, applies: true, why: 'done' }]; } });
    const pending = checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, d);
    await vi.advanceTimersByTimeAsync(1000);
    const first = await pending;
    expect(first.queued).toBe(true);
    expect(first.queue).toMatchObject({ state: 'retry_required', inFlight: {} });
    expect(first.markdown).toMatch(/Not finished: the judge has been on this check for \d+ s\. Call check_before_done again with the same arguments/);
    expect(first.markdown).toContain('**No console**: Do not use console.log');
    // The retry reaches the running call (promise chains only) before the judge's remaining 500 ms pass.
    const retrying = checkBeforeDone({ project: 'demo', task: 'edit src/app.ts', summary: 'changed it' }, { ...d, checkTimeoutMs: 5000 });
    await nextTurn();
    await vi.advanceTimersByTimeAsync(500);
    const retry = await retrying;
    expect(retry.queue?.observed?.shared).toBe('joined');
    expect(retry.markdown).toContain('Joined an identical judge call already in progress');
    expect(calls).toBe(1);
  });
});

describe('the KeyPrefix violation case keeps an active lesson, so its judge check cannot pass vacuously', () => {
  const keyPrefix = (status: Lesson['status']): Lesson => ({ ...lesson('lesson:keyprefix', 'Never reuse a KeyPrefix value: bump KeyPrefix to the next unused number when the schema changes.'), title: 'Bump KeyPrefix on schema change', paths: ['src/schema.ts'], appliesWhen: 'changing the stored schema', status });
  const violation = 'diff --git a/src/schema.ts b/src/schema.ts\n--- a/src/schema.ts\n+++ b/src/schema.ts\n@@ -1 +1 @@\n-KeyPrefix = "004";\n+KeyPrefix = "004"; // schema changed\n';
  const check = async (status: Lesson['status']) => {
    const judged: string[][] = [];
    const store = [keyPrefix(status)];
    const result = await checkBeforeDone({ project: 'demo', task: 'change the stored schema in src/schema.ts', summary: 'added a field', filesChanged: ['src/schema.ts'], diff: violation }, deps({
      // Like the stores: only approved lessons are found.
      k: { ...deps().k, searchLessons: async () => store.filter((l) => l.status === 'approved').map((l) => ({ lesson: l, score: .92 })) },
      judge: async (_work, lessons) => { judged.push(lessons.map((h) => h.lesson.id)); return lessons.map((h) => ({ lessonId: h.lesson.id, status: 'not_addressed' as const, applies: true, why: 'KeyPrefix stays "004" although the schema changed', evidence: ['+KeyPrefix = "004"; // schema changed'] })); },
    }));
    return { result, judged };
  };

  test('the active lesson reaches the judge and the violation is a cited gap', async () => {
    const { result, judged } = await check('approved');
    expect(judged).toEqual([['lesson:keyprefix']]);
    expect(result.gaps.map((g) => g.lessonId)).toEqual(['lesson:keyprefix']);
    expect(result.gaps[0].evidence?.[0].line).toBe('+KeyPrefix = "004"; // schema changed');
  });

  test('a revoked lesson leaves nothing to judge, which this case would report instead of passing', async () => {
    const { result, judged } = await check('revoked');
    expect(judged).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.status).toBe('no_applicable_rules');
  });
});

describe('Windows paths', () => {
  test('a backslash path is a mentioned path, with forward slashes; an escape in quoted text is not', () => {
    expect(mentionedPaths('fix src\\api\\orders.ts and .\\lib/util.ts')).toEqual(['src/api/orders.ts', './lib/util.ts']);
    expect(mentionedPaths('it printed "done\\nnext" twice')).toEqual([]);
  });

  test('a backslash path is placed like its forward-slash form', () => {
    expect(pathAffinity('src\\api\\orders.ts', ['src/api/items.ts'])).toBe(pathAffinity('src/api/orders.ts', ['src/api/items.ts']));
    expect(pathAffinity('src/api/orders.ts', ['src\\api\\items.ts'])).toBe(1.3);
  });

  test('a file named with backslashes is the same task file; a drive-letter path is outside the project', () => {
    const roots = [{ host: '/projects', container: '/projects' }];
    expect(taskFiles({ files: ['src\\api\\orders.ts', 'C:\\Users\\me\\demo\\a.ts'] }, roots)).toEqual(['src/api/orders.ts']);
    expect(taskFiles({ cwd: '/projects/demo', files: ['src\\api\\orders.ts', 'C:\\Users\\me\\demo\\a.ts'] }, roots)).toEqual(['src/api/orders.ts']);
  });
});
