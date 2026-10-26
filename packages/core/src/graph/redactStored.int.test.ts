import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';

// Rows written straight into the store (seedEmbedded bypasses the redaction at the door), as data stored under older
// redaction rules is: then the current rules are run over it.
const V = 'Q9x' + 'w'.repeat(12) + '7Zk';
const vec = [1, 0];

describeStores('redaction of stored data under new rules', (h) => {
  let s: Store;
  let probe: StoreProbe;
  beforeAll(() => {
    s = h.store;
    probe = h.probe;
  });

  test('facts: secrets are redacted in place; a current fact that is a credential is closed; clean facts are not touched', async () => {
    await probe.seedEmbedded({ kind: 'Fact', id: 'f-code', path: 'src/aws.ts', statement: `src/aws.ts sets const AWS_SECRET_ACCESS_KEY = "${V}" for uploads`, current: true, embedding: vec });
    await probe.seedEmbedded({ kind: 'Fact', id: 'f-prose', path: 'notes.png', statement: 'The admin password is hunter2', current: true, embedding: vec });
    await probe.seedEmbedded({ kind: 'Fact', id: 'f-old', path: 'notes.png', statement: 'The old admin password is hunter1', current: false, embedding: vec });
    await probe.seedEmbedded({ kind: 'Fact', id: 'f-clean', path: 'src/a.ts', statement: 'Orders are scoped to the tenant', current: true, embedding: vec });
    // Ordinary code-fact prose rules v2 took for credentials: left alone and served.
    await probe.seedEmbedded({ kind: 'Fact', id: 'f-key', path: 'src/db.ts', statement: 'The primary key is user_id2.', current: true, embedding: vec });
    await probe.seedEmbedded({ kind: 'Fact', id: 'f-cache', path: 'src/cache.ts', statement: 'The cache key is v2:users list', current: true, embedding: vec });
    // What v2 already turned into [REDACTED] is not closed again on that alone.
    await probe.seedEmbedded({ kind: 'Fact', id: 'f-v2', path: 'src/db.ts', statement: 'The foreign key is [REDACTED].', current: true, embedding: vec });
    // Yours: never closed; only a known token shape goes.
    const gh = 'gh' + 'p_' + 'x'.repeat(36);
    await probe.seedEmbedded({ kind: 'Fact', id: 'f-you', path: '', statement: `The admin password is hunter2; CI pushes with ${gh}`, current: true, origin: 'you', embedding: vec });
    expect(await s.facts.redactStoredFacts!()).toEqual({ redacted: 4, closed: 2, owner: 1 });
    const rows = Object.fromEntries((await probe.rows('Fact')).map((r) => [r.id, r]));
    expect(rows['f-code'].statement).toBe('src/aws.ts sets const AWS_SECRET_ACCESS_KEY = "[REDACTED]" for uploads');
    expect(rows['f-prose'].statement).toBe('The admin password is [REDACTED]');
    expect(rows['f-old'].statement).toBe('The old admin password is [REDACTED]');
    expect(rows['f-prose'].current).toBe(false);
    expect(rows['f-code'].current).toBe(false);
    expect(rows['f-clean'].current).toBe(true);
    for (const id of ['f-key', 'f-cache', 'f-v2', 'f-you']) expect(rows[id].current).toBe(true);
    expect(rows['f-key'].statement).toBe('The primary key is user_id2.');
    expect(rows['f-cache'].statement).toBe('The cache key is v2:users list');
    expect(rows['f-you'].statement).toBe('The admin password is hunter2; CI pushes with [REDACTED]');
    const others = (await probe.rows('Fact')).filter((r) => r.id !== 'f-you');
    expect(JSON.stringify(others)).not.toMatch(new RegExp(`${V}|hunter[12]`));
    // Run again: nothing left to change.
    expect(await s.facts.redactStoredFacts!()).toEqual({ redacted: 0, closed: 0, owner: 0 });
  });

  test('document chunks and lessons: secrets are redacted in place, and a second run changes nothing', async () => {
    await probe.seedEmbedded({ kind: 'Chunk', id: 'c1', text: `Image "Notes" (notes.png): a sticky note says the admin password is hunter2`, embedding: vec });
    await probe.seedEmbedded({ kind: 'Chunk', id: 'c2', text: 'Checkout asks for the address before payment.', embedding: vec });
    await probe.seedEmbedded({ kind: 'Lesson', id: 'l1', title: 'Use the staging key', rule: `Run with -e API_TOKEN=${V} against staging`, appliesWhen: 'testing uploads', embedding: vec });
    await probe.seedEmbedded({ kind: 'Lesson', id: 'l2', title: 'Scope orders', rule: 'Always scope orders to the tenant', embedding: vec });
    expect(await s.docs.redactStoredDocs!()).toBe(1);
    expect(await s.knowledge.redactStoredLessons!()).toBe(1);
    const chunks = Object.fromEntries((await probe.rows('Chunk')).map((r) => [r.id, r.text]));
    expect(chunks.c1).toBe('Image "Notes" (notes.png): a sticky note says the admin password is [REDACTED]');
    expect(chunks.c2).toBe('Checkout asks for the address before payment.');
    const lessons = Object.fromEntries((await probe.rows('Lesson')).map((r) => [r.id, r.rule]));
    expect(lessons.l1).toBe('Run with -e API_TOKEN=[REDACTED] against staging');
    expect(lessons.l2).toBe('Always scope orders to the tenant');
    expect(await s.docs.redactStoredDocs!()).toBe(0);
    expect(await s.knowledge.redactStoredLessons!()).toBe(0);
  });

  test('misses, Inbox items, session summaries and Activity: secrets are redacted in place, clean text stays, a second run changes nothing', async () => {
    await probe.seedStaleText({
      kind: 'InboxItem', id: 'k1', text: `no, deploy with -e API_TOKEN=${V} like I said`, context: 'I deployed without the token', summary: 'the admin password is hunter2',
      note: 'The primary key is user_id2.', agentReport: { text: `export DB_PASSWORD=${V}`, sessionId: 's' },
      feedbackText: `no, deploy with -e API_TOKEN=${V} like I said`, missed: 'the admin password is hunter2', causeExplanation: 'The cache key is v2:users list',
    });
    await probe.seedStaleText({ kind: 'InboxItem', id: 'k2', text: 'use the tenant scope', context: 'done', summary: 'scope', note: '', agentReport: null, feedbackText: 'use the tenant scope', missed: 'scope', causeExplanation: 'why' });
    await probe.seedStaleText({ kind: 'Session', id: 's1', summary: { markdown: `Set API_TOKEN=${V} in .env`, open: ['the admin password is hunter2'] }, finalReply: 'Done: the password is hunter2' });
    await probe.seedStaleText({ kind: 'Session', id: 's2', summary: { markdown: 'The primary key is user_id2.' }, finalReply: 'Done.' });
    await probe.seedStaleText({ kind: 'Activity', id: 'a1', subject: 'PR says the password is hunter2', why: 'clean', details: { cmd: `API_TOKEN=${V}`, n: 1 } });
    await probe.seedStaleText({ kind: 'Activity', id: 'a2', subject: 'The primary key is user_id2.', why: 'clean', details: { n: 2 } });

    expect(await s.knowledge.redactStoredMisses!()).toBe(2); // k1's feedback and miss
    expect(await s.graph.redactStoredCandidates!()).toBe(1);
    expect(await s.sessions.redactStoredSummaries!()).toBe(1);
    expect(await s.activity.redactStoredActivity!()).toBe(1);

    const dump = JSON.stringify(await Promise.all((['Feedback', 'Miss', 'Turn', 'Candidate', 'Session', 'Activity'] as const).map((k) => probe.rows(k))));
    expect(dump).not.toMatch(new RegExp(`${V}|hunter2`));
    expect(dump).toContain('[REDACTED]');
    for (const clean of ['The primary key is user_id2.', 'The cache key is v2:users list', 'use the tenant scope']) expect(dump).toContain(clean);
    const activity = Object.fromEntries((await s.activity.list({ limit: 10 })).map((a) => [a.id, a]));
    expect(activity.a1.details).toEqual({ cmd: 'API_TOKEN=[REDACTED]', n: 1 });
    expect(activity.a2.subject).toBe('The primary key is user_id2.');
    expect(dump).toContain('Set API_TOKEN=[REDACTED] in .env');

    expect(await s.knowledge.redactStoredMisses!()).toBe(0);
    expect(await s.graph.redactStoredCandidates!()).toBe(0);
    expect(await s.sessions.redactStoredSummaries!()).toBe(0);
    expect(await s.activity.redactStoredActivity!()).toBe(0);
  });
});
