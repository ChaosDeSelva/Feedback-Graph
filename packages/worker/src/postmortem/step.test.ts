import type { ActivityInput, PostMortem, PostMortemInput } from '@fb/core';
import { expect, test } from 'vitest';
import { runPostmortems, embedTexts } from './step.ts';
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
    trace: { provider: 'claude-cli', agentic: true, standing: ['/vibe/shop/CLAUDE.md'], facts: ['src/db.ts: use scoped'] },
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
