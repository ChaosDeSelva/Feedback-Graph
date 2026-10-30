import type { ActivityInput, Lesson, LessonDetail, PostMortem, PostMortemInput } from '@fb/core';
import { expect, test } from 'vitest';
import { runPostmortems, embedTexts, providerAnswers, UNAVAILABLE_CAP } from './step.ts';
import type { PostMortemTrace } from './postmortem.ts';

const input = (id: string) => ({ feedbackId: id }) as PostMortemInput;
const pm = { missed: 'm', causeExplanation: 'c', lesson: { title: 't', rule: 'r', appliesWhen: 'w' } } as PostMortem;

test('saves each post-mortem with miss and lesson embeddings', async () => {
  const saved: unknown[][] = [];
  const r = await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('a')],
      savePostmortem: async (...a) => { saved.push(a); },
      recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }),
    },
    postmortem: async () => pm,
    embed: async (texts) => texts.map((t) => [t.length]),
    batch: 3,
  });
  expect(r).toEqual({ done: 1, failed: 0 });
  const [id, , emb] = saved[0] as [string, PostMortem, { miss: number[]; lesson: number[] }];
  expect(id).toBe('a');
  expect(emb.miss).toEqual([embedTexts(pm).miss.length]);
  expect(emb.lesson).toEqual([embedTexts(pm).lesson.length]);
});

test('a dropped lesson: only the miss is embedded, no duplicate check runs, and Activity says why there is no lesson', async () => {
  const embedded: string[][] = [];
  const activity: ActivityInput[] = [];
  let similar = 0;
  await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('a')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }),
      similarLessons: async () => { similar++; return []; },
      setLessonChecks: async () => true,
    },
    postmortem: async () => ({ ...pm, lessonDropped: 'lesson.rule holds the scope word "project"' }),
    embed: async (texts) => { embedded.push(texts); return texts.map(() => [1]); },
    batch: 1,
    activity: { record: async (a) => void activity.push(a) },
  });
  expect(embedded).toEqual([[embedTexts(pm).miss]]);
  expect(similar).toBe(0);
  expect(activity[0].details).toMatchObject({ lesson: null, lessonDropped: 'lesson.rule holds the scope word "project"' });
  expect(activity[0].targets).toEqual(['a', 'miss:a']);
});

test('a failure is recorded and does not stop the batch', async () => {
  const failures: string[] = [];
  const r = await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('bad'), input('good')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async (id, err) => { failures.push(`${id}:${err}`); return { attempts: 1, retryAt: null }; },
    },
    postmortem: async (i) => { if (i.feedbackId === 'bad') throw new Error('rate limited'); return pm; },
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
  });
  expect(r).toEqual({ done: 1, failed: 1 });
  expect(failures).toEqual(['bad:Error: rate limited']);
});

test('a post-mortem that timed out is charged to that feedback (backoff, attempts) and the batch goes on', async () => {
  const failures: string[] = [];
  const r = await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('slow'), input('good')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async (id, err) => { failures.push(`${id}:${err}`); return { attempts: 1, retryAt: '2026-10-24T12:00:00Z' }; },
    },
    postmortem: async (i) => { if (i.feedbackId === 'slow') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); return pm; },
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
  });
  expect(r).toEqual({ done: 1, failed: 1 });
  expect(failures).toEqual([expect.stringMatching(/^slow:TimeoutError/)]);
});

test('while a scan holds the model, a post-mortem that timed out charges nothing and the batch waits', async () => {
  const failures: string[] = [];
  const r = await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('slow'), input('good')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async (id) => { failures.push(id); return { attempts: 1, retryAt: null }; },
    },
    postmortem: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
    modelBusy: () => true,
  });
  expect(failures).toEqual([]);
  expect(r).toEqual({ done: 0, failed: 0, unavailable: expect.stringMatching(/busy with a scan/) });
});

test('an unavailable model is not charged to the feedback: no failure recorded, and the batch pauses', async () => {
  const failures: string[] = [];
  const activity: ActivityInput[] = [];
  const asked: string[] = [];
  const down = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const r = await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('a'), input('b')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async (id) => { failures.push(id); return { attempts: 1, retryAt: null }; },
    },
    postmortem: async (i) => { asked.push(i.feedbackId); throw down; },
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
    activity: { record: async (a) => { activity.push(a); } },
  });
  expect(r).toEqual({ done: 0, failed: 0, unavailable: expect.stringMatching(/cannot reach.*ECONNREFUSED/) });
  expect(failures).toEqual([]);
  expect(activity).toEqual([]);
  expect(asked).toEqual(['a']); // the rest wait for the next cycle instead of each failing the same way
});

test('an embedding model that is down is not charged either', async () => {
  const failures: string[] = [];
  const r = await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('a')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async (id) => { failures.push(id); return { attempts: 1, retryAt: null }; },
    },
    postmortem: async () => pm,
    embed: async () => { throw new Error('ollama embed 503: loading'); },
    batch: 3,
  });
  expect(r.unavailable).toMatch(/503/);
  expect(failures).toEqual([]);
});

test('a failure that quotes a secret is redacted before it is stored, logged or recorded as activity', async () => {
  const key = 'ghp_' + 'C'.repeat(36);
  const stored: string[] = [];
  const logged: string[] = [];
  const activity: ActivityInput[] = [];
  await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('f3')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async (_id, err) => { stored.push(err); return { attempts: 1, retryAt: null }; },
    },
    postmortem: async () => { throw new Error('claude error: the config holds ' + key); },
    embed: async (texts) => texts.map(() => [1]),
    batch: 1,
    log: (_m, extra) => { logged.push(JSON.stringify(extra)); },
    activity: { record: async (a) => { activity.push(a); } },
  });
  for (const text of [...stored, ...logged, activity[0].why ?? '']) {
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(key);
  }
});

test('embedTexts builds the text that gets embedded', () => {
  expect(embedTexts(pm)).toEqual({ miss: 'm\nc', lesson: 't\nr\nApplies when: w' });
});

test('each post-mortem is logged with the model, the context it was given, and what it concluded', async () => {
  const activity: ActivityInput[] = [];
  const full = {
    ...pm, cause: 'context_available_ignored', taskTitle: 'Orders list',
    contextItems: [{ kind: 'claude_md', ref: 'CLAUDE.md', excerpt: 'scope', why: 'stated rule', wasAvailable: true }],
    facts: [{ path: 'src/db.ts', statement: 'the pool holds 10 clients' }], subject: 'process',
    trace: { provider: 'claude-cli', agentic: true, standing: ['/vibe/shop/CLAUDE.md'], facts: ['src/db.ts: use scoped'], lessonFlags: [{ name: 'meta-lesson', why: 'about feedback' }], lessonShaped: ['title'] },
  } as PostMortem & { trace: PostMortemTrace };
  await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [{ ...input('f1'), projectKey: 'shop', feedback: { text: 'not good enough' } } as PostMortemInput],
      savePostmortem: async () => {}, recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }),
    },
    postmortem: async () => full,
    embed: async (texts) => texts.map(() => [1]),
    batch: 1,
    activity: { record: async (a) => { activity.push(a); } },
  });
  expect(activity).toEqual([expect.objectContaining({
    kind: 'postmortem_done', actor: 'claude-cli', projectKey: 'shop', subject: 'missed: m', why: 'c',
    targets: ['f1', 'miss:f1', 'lesson:f1'],
  })]);
  expect(activity[0].details).toMatchObject({
    cause: 'context_available_ignored', feedback: 'not good enough', lesson: { title: 't', rule: 'r' },
    contextGiven: { standing: ['/vibe/shop/CLAUDE.md'], facts: ['src/db.ts: use scoped'], agentic: true },
    contextFound: [{ kind: 'claude_md', ref: 'CLAUDE.md', why: 'stated rule', wasAvailable: true }],
    lessonChecks: [{ name: 'meta-lesson', why: 'about feedback' }],
    // What the shape check repaired, whether the miss is about a file at all, and the facts it proposed (logged, never stored).
    lessonShaped: ['title'],
    subject: 'process',
    proposedFacts: [{ path: 'src/db.ts', statement: 'the pool holds 10 clients' }],
  });
});

test('a failed post-mortem is logged with when it will be retried, or that it gave up', async () => {
  const activity: ActivityInput[] = [];
  let next: { attempts: number; retryAt: string | null } = { attempts: 1, retryAt: '2026-10-22T10:05:00.000Z' };
  const run = () => runPostmortems({
    k: { feedbackNeedingPostmortem: async () => [{ ...input('f2'), projectKey: 'shop' } as PostMortemInput], savePostmortem: async () => {}, recordPostmortemFailure: async () => next },
    postmortem: async () => { throw new Error('timeout'); },
    embed: async (t) => t.map(() => [1]), batch: 1, activity: { record: async (a) => { activity.push(a); } },
  });
  await run();
  expect(activity[0]).toMatchObject({ kind: 'postmortem_failed', projectKey: 'shop', subject: 'post-mortem failed (attempt 1); retrying at 2026-10-22T10:05:00.000Z', why: 'Error: timeout', targets: ['f2'] });
  next = { attempts: 5, retryAt: null };
  await run();
  expect(activity[1].subject).toBe('post-mortem failed (attempt 5); gave up, retry it from the API');
});

test('one feedback that is "unavailable" cycle after cycle is charged after a few, so it cannot stall the queue forever', async () => {
  const failures: string[] = [];
  const asked: string[] = [];
  // The same item heads the queue every cycle and its run is classified unavailable each time.
  const streak = { feedbackId: null as string | null, count: 0 };
  const run = (head = 'stuck') => runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input(head), input('next')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async (id, err) => { failures.push(`${id}:${err}`); return { attempts: 1, retryAt: '2026-10-25T12:00:00Z' }; },
    },
    postmortem: async (i) => { asked.push(i.feedbackId); if (i.feedbackId !== 'next') throw new Error('claude exit 1: Invalid API key · Please run /login'); return pm; },
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
    unavailableStreak: streak,
    unavailableCap: 3,
    // Other asks of the same provider are answered: it is this item, not the provider.
    providerHealthy: async () => true,
  });
  expect((await run()).unavailable).toMatch(/not signed in/);
  expect((await run()).unavailable).toMatch(/not signed in/);
  expect(failures).toEqual([]);
  const third = await run();
  // The third time in a row it is recorded as this item's failure (attempts, backoff) and the batch goes on.
  expect(third).toEqual({ done: 1, failed: 1 });
  expect(failures).toEqual([expect.stringMatching(/^stuck:.*unavailable 3 times in a row on this feedback.*not signed in/)]);
  expect(asked.slice(-2)).toEqual(['stuck', 'next']);
  expect(streak.count).toBe(0);
  // A different item heading the queue starts its own count.
  await run();
  await run('other');
  expect(streak).toEqual({ feedbackId: 'other', count: 1 });
});

// A two-hour outage at one cycle every 30 seconds, ten items queued: the head item reads "unavailable" every cycle.
test('a provider-wide outage charges nothing: two hours down with ten queued items, none is charged or given up on', async () => {
  const failures: string[] = [];
  const streak = { feedbackId: null as string | null, count: 0 };
  const queue = Array.from({ length: 10 }, (_, i) => input(`f${i}`));
  const down = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  let probes = 0;
  for (let cycle = 0; cycle < 240; cycle++) {
    const r = await runPostmortems({
      k: {
        feedbackNeedingPostmortem: async () => queue,
        savePostmortem: async () => {},
        recordPostmortemFailure: async (id) => { failures.push(id); return { attempts: 1, retryAt: null }; },
      },
      postmortem: async () => { throw down; },
      embed: async (texts) => texts.map(() => [1]),
      batch: 1,
      unavailableStreak: streak,
      // The provider does not answer a health ask either: it is down, not this item.
      providerHealthy: async () => { probes++; return false; },
    });
    expect(r.unavailable).toMatch(/ECONNREFUSED/);
  }
  expect(failures).toEqual([]);
  expect(streak.count).toBe(0);
  expect(probes).toBe(240);
});

test('"busy with a scan" never counts toward the cap, and the health ask is not even made', async () => {
  const failures: string[] = [];
  const streak = { feedbackId: null as string | null, count: 0 };
  let probes = 0;
  for (let cycle = 0; cycle < UNAVAILABLE_CAP * 4; cycle++) {
    await runPostmortems({
      k: {
        feedbackNeedingPostmortem: async () => [input('a'), input('b')],
        savePostmortem: async () => {},
        recordPostmortemFailure: async (id) => { failures.push(id); return { attempts: 1, retryAt: null }; },
      },
      postmortem: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
      embed: async (texts) => texts.map(() => [1]),
      batch: 1,
      modelBusy: () => true,
      unavailableStreak: streak,
      providerHealthy: async () => { probes++; return true; },
    });
  }
  expect(failures).toEqual([]);
  expect(probes).toBe(0);
});

test('one poisoned item while the provider answers everything else is charged once after the cap, then the queue moves', async () => {
  const failures: string[] = [];
  const streak = { feedbackId: null as string | null, count: 0 };
  const results: { done: number; failed: number; unavailable?: string }[] = [];
  // An outage in the middle: those cycles neither count nor reset the item's streak.
  const healthy = [true, true, false, false, true, true, true];
  for (const ok of healthy) {
    results.push(await runPostmortems({
      k: {
        feedbackNeedingPostmortem: async () => (failures.length ? [input('next')] : [input('poisoned'), input('next')]),
        savePostmortem: async () => {},
        recordPostmortemFailure: async (id) => { failures.push(id); return { attempts: 1, retryAt: '2026-10-25T12:05:00Z' }; },
      },
      postmortem: async (i) => { if (i.feedbackId === 'poisoned') throw new Error('ollama:gemma 500: llama runner process has terminated'); return pm; },
      embed: async (texts) => texts.map(() => [1]),
      batch: 2,
      unavailableStreak: streak,
      unavailableCap: 4,
      providerHealthy: async () => ok,
    }));
  }
  expect(failures).toEqual(['poisoned']);
  expect(results.map((r) => r.failed)).toEqual([0, 0, 0, 0, 0, 1, 0]);
  expect(results[5].done).toBe(1);
});

test('providerAnswers: a tiny ask; down or timed out is false, any answer (even a bad one) is true', async () => {
  const llm = (json: () => Promise<unknown>) => ({ id: 'x', agentic: false, json });
  expect(await providerAnswers(llm(async () => ({ ok: true })))).toBe(true);
  expect(await providerAnswers(llm(async () => { throw new Error('not JSON: hello'); }))).toBe(true);
  expect(await providerAnswers(llm(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }))).toBe(false);
  expect(await providerAnswers(llm(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }))).toBe(false);
});

test('a new lesson that repeats one already in the project is flagged duplicate-of it once saved', async () => {
  const checks: unknown[][] = [];
  const old = { id: 'lesson:old', status: 'approved' as const, createdAt: '2026-10-01T00:00:00Z' };
  await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('a'), input('b')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }),
      similarLessons: async (id) => [{ ...old, cosine: id === 'lesson:a' ? 0.96 : 0.5 }],
      setLessonChecks: async (...a) => { checks.push(a); return true; },
    },
    postmortem: async () => ({ ...pm, lessonChecks: [{ name: 'needs-path', why: 'none' }] }),
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
  });
  expect(checks).toEqual([['lesson:a', [{ name: 'needs-path', why: 'none' }, expect.objectContaining({ name: 'duplicate-of', of: 'lesson:old' })]]]);
});

test('a post-mortem that says there was no miss is saved with its lesson rejected, never proposed, and Activity says why', async () => {
  const decided: [string, unknown, unknown][] = [];
  const activity: ActivityInput[] = [];
  const none = { ...pm, missed: 'The agent did not miss any defects.', noMiss: 'The agent did not miss any defects.' };
  const r = await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [{ ...input('a'), projectKey: 'data-pipeline' }],
      savePostmortem: async () => {},
      recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }),
      updateLesson: async (id, patch, o) => { decided.push([id, patch, o]); return { unscoped: false }; },
    },
    postmortem: async () => none,
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
    activity: { record: async (a) => void activity.push(a) },
  });
  expect(r).toEqual({ done: 1, failed: 0 });
  expect(decided).toEqual([['lesson:a', { status: 'rejected' }, { by: 'postmortem', note: expect.stringContaining('no miss') }]]);
  expect(activity[0]).toMatchObject({ kind: 'postmortem_done', subject: expect.stringMatching(/^no miss, no lesson: /), details: expect.objectContaining({ noLesson: 'The agent did not miss any defects.' }) });
});

test.each([undefined, "empty rule"])("a re-saved no-miss post-mortem preserves owner decisions even with dropped lesson %s", async (lessonDropped) => {
  const decided: unknown[] = [];
  const checks: [string, unknown][] = [];
  const none = { ...pm, missed: 'Nothing was missed.', noMiss: 'Nothing was missed.', ...(lessonDropped && { lessonDropped }) };
  const stored: Record<string, Partial<Lesson>> = {
    'lesson:edited': { status: 'proposed', proposedAs: { title: 't', rule: 'r', appliesWhen: 'w', scope: 'project', paths: [] }, checks: [{ name: 'needs-path', why: 'x' }] },
    'lesson:approved': { status: 'approved', proposedAs: null, checks: [] },
    'lesson:fresh': { status: 'proposed', proposedAs: null, checks: [] },
  };
  await runPostmortems({
    k: {
      feedbackNeedingPostmortem: async () => [input('edited'), input('approved'), input('fresh')],
      savePostmortem: async () => {},
      recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }),
      lessonDetail: async (id) => ({ lesson: { id, ...stored[id] } as Lesson }) as LessonDetail,
      updateLesson: async (id) => { decided.push(id); return { unscoped: false }; },
      setLessonChecks: async (id, c) => { checks.push([id, c]); return true; },
      similarLessons: async () => [],
    },
    postmortem: async () => none,
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
  });
  expect(decided).toEqual(['lesson:fresh']);
  expect(checks).toEqual([
    ['lesson:edited', [{ name: 'needs-path', why: 'x' }, { name: 'no-miss', why: expect.stringContaining('Nothing was missed.') }]],
    ['lesson:approved', [{ name: 'no-miss', why: expect.stringContaining('Nothing was missed.') }]],
  ]);
});

test('the session a comment was worked out against, and how it was matched, are kept in Activity', async () => {
  const activity: ActivityInput[] = [];
  await runPostmortems({
    k: { feedbackNeedingPostmortem: async () => [input('a')], savePostmortem: async () => {}, recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }) },
    postmortem: async () => ({ ...pm, trace: { provider: 'fake', agentic: false, standing: [], facts: [], lessonFlags: [], workSession: { id: 's-loader', matchedBy: 'files' } } }),
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
    activity: { record: async (a) => void activity.push(a) },
  });
  expect(activity[0].details).toMatchObject({ workSession: { id: 's-loader', matchedBy: 'files' } });
});

test("the lessons shown to the writer as the owner's examples are kept in Activity by id (none shown: an empty list)", async () => {
  const activity: ActivityInput[] = [];
  const traces = [['lesson:e1', 'lesson:r1', 'lesson:w1'], undefined];
  await runPostmortems({
    k: { feedbackNeedingPostmortem: async () => [input('a'), input('b')], savePostmortem: async () => {}, recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }) },
    postmortem: async () => ({ ...pm, trace: { provider: 'fake', agentic: false, standing: [], facts: [], lessonFlags: [], ...(traces[0] && { examples: traces.shift() }) } }),
    embed: async (texts) => texts.map(() => [1]),
    batch: 3,
    activity: { record: async (a) => void activity.push(a) },
  });
  expect(activity.map((a) => a.details?.examples)).toEqual([['lesson:e1', 'lesson:r1', 'lesson:w1'], []]);
});


test('post-mortem Activity inherits the feedback run on success and failure', async () => {
  for (const fail of [false, true]) {
    const activity: ActivityInput[] = [];
    await runPostmortems({
      k: { feedbackNeedingPostmortem: async () => [{ ...input('labelled'), run: 'source-run', sandbox: true }], savePostmortem: async () => {}, recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }) },
      postmortem: async () => { if (fail) throw new Error('failed'); return pm; },
      embed: async texts => texts.map(() => [1]), batch: 1,
      activity: { record: async a => { activity.push(a); } },
    });
    expect(activity[0]).toMatchObject({ kind: fail ? 'postmortem_failed' : 'postmortem_done', run: 'source-run', sandbox: true });
  }
});


test('an undone decision while the model runs emits no false completed Activity or lesson actions', async () => {
  const activity: ActivityInput[] = []; let checks = 0;
  const result = await runPostmortems({ k: { feedbackNeedingPostmortem: async () => [input('undone')], savePostmortem: async () => false,
    recordPostmortemFailure: async () => ({ attempts: 1, retryAt: null }), setLessonChecks: async () => { checks++; return true; } },
    postmortem: async () => pm, embed: async texts => texts.map(() => [1]), batch: 1, activity: { record: async a => { activity.push(a); } } });
  expect(result).toEqual({ done: 0, failed: 0 }); expect(activity).toEqual([]); expect(checks).toBe(0);
});
