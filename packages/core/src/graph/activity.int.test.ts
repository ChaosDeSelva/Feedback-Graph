import { beforeAll, expect, test } from 'vitest';
import type { ActivityStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { GraphRepo } from './repo.ts';

describeStores('ActivityStore', (h) => {
  let a: ActivityStore;
  beforeAll(() => {
    a = h.store.activity;
  });

  test('records an activity and lists it back with details and targets', async () => {
    await a.record({
      kind: 'facts_extracted', actor: 'ollama:gemma4', projectKey: 'shop', subject: '3 facts from src/db.ts',
      why: 'file is new', details: { scanJobId: 'scan:1', hash: 'abc' }, targets: ['shop:src/db.ts'],
    });
    const [x] = await a.list({});
    expect(x).toMatchObject({
      kind: 'facts_extracted', actor: 'ollama:gemma4', projectKey: 'shop', subject: '3 facts from src/db.ts',
      why: 'file is new', details: { scanJobId: 'scan:1', hash: 'abc' }, targets: ['shop:src/db.ts'],
    });
    expect(x.id).toMatch(/^act:/);
    expect(Date.parse(x.ts)).not.toBeNaN();
  });

  test('filters by project, kind and target, newest first, with a limit', async () => {
    await a.record({ kind: 'memory_imported', actor: 'memory-file', projectKey: 'shop', subject: 'one', why: 'w', targets: ['lesson:1'] });
    await a.record({ kind: 'facts_extracted', actor: 'm', projectKey: 'blog', subject: 'two', why: 'w', targets: ['blog:a.ts'] });
    await a.record({ kind: 'facts_extracted', actor: 'm', projectKey: 'shop', subject: 'three', why: 'w', targets: ['shop:a.ts', 'lesson:1'] });
    expect((await a.list({})).map((x) => x.subject)).toEqual(['three', 'two', 'one']);
    expect((await a.list({ projectKey: 'shop' })).map((x) => x.subject)).toEqual(['three', 'one']);
    expect((await a.list({ kind: 'facts_extracted' })).map((x) => x.subject)).toEqual(['three', 'two']);
    expect((await a.list({ target: 'lesson:1' })).map((x) => x.subject)).toEqual(['three', 'one']);
    expect(await a.list({ limit: 1 })).toHaveLength(1);
  });

  test('a list with maxDetailBytes leaves big details out and says so; get(id) returns them whole', async () => {
    await a.record({ kind: 'scan_finished', actor: 'm', projectKey: 'shop', subject: 'big', why: 'w', details: { log: 'x'.repeat(5000) } });
    await a.record({ kind: 'lesson_decided', actor: 'you', projectKey: 'shop', subject: 'small', why: 'w', details: { status: 'approved' } });
    const [small, big] = await a.list({ maxDetailBytes: 512 });
    expect(small).toMatchObject({ subject: 'small', details: { status: 'approved' } });
    expect(small.detailsOmitted).toBeFalsy();
    expect(big).toMatchObject({ subject: 'big', details: {}, detailsOmitted: true });
    expect((await a.get(big.id))?.details).toEqual({ log: 'x'.repeat(5000) });
    expect((await a.get(big.id))?.detailsOmitted).toBeFalsy();
    expect(await a.get('act:nope')).toBeNull();
    // Without the option the list is as it always was.
    expect((await a.list({}))[1].details).toEqual({ log: 'x'.repeat(5000) });
  });

  test('a subject over 500 characters is cut at write; details say how long it was', async () => {
    await a.record({ kind: 'doc_added', actor: 'agent', projectKey: 'shop', subject: `reported: ${'x'.repeat(1024 * 1024)}`, why: 'w', details: { tool: 'report_feedback' } });
    const [row] = await a.list({});
    expect(row.subject).toHaveLength(500);
    expect(row.subject.endsWith('…')).toBe(true);
    expect(row.details).toEqual({ tool: 'report_feedback', subjectChars: 10 + 1024 * 1024 });
  });

  test('defaults: no details, no targets, global project', async () => {
    await a.record({ kind: 'feedback_decided', actor: 'you', projectKey: null, subject: 's', why: 'w' });
    const [x] = await a.list({});
    expect(x).toMatchObject({ details: {}, targets: [], projectKey: null });
  });

  test('record redacts secrets in subject, why and details', async () => {
    await a.record({ kind: 'doc_added', actor: 'github', projectKey: 'shop', subject: 'PR ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', why: 'why ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', details: { prs: [{ title: 'x ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }] } });
    const [x] = await a.list({});
    expect(JSON.stringify(x)).not.toContain('ghp_');
  });

  test('details that look like config survive redaction as valid JSON', async () => {
    await a.record({ kind: 'doc_added', actor: 'x', projectKey: 'shop', subject: 's', why: 'w', details: { cmd: 'password: "hunter2-EXAMPLE"', env: 'API_TOKEN=abcdefEXAMPLE' } });
    const [x] = await a.list({});
    expect(x.details).toEqual({ cmd: 'password: "[REDACTED]"', env: 'API_TOKEN=[REDACTED]' });
  });
});

/**
 * NEO4J ONLY: Neo4j keeps details as a JSON string, which old or hand-edited rows can corrupt. Postgres stores them
 * as jsonb, which cannot hold unreadable JSON, so there is no such row to survive.
 */
describeStores('ActivityStore (Neo4j details are JSON text)', (h) => {
  let a: ActivityStore;
  beforeAll(() => {
    a = h.store.activity;
  });

  test('one unreadable row does not break the log', async () => {
    await a.record({ kind: 'doc_added', actor: 'x', projectKey: 'shop', subject: 'good', why: 'w', details: { ok: 1 } });
    await (h.store.graph as GraphRepo).run(`CREATE (:Activity {id: 'bad', ts: 't', order: -1, kind: 'doc_added', actor: 'x', subject: 'bad', why: 'w', details: '{not json', targets: []})`);
    const rows = await a.list({});
    expect(rows.map((r) => r.subject)).toEqual(['good', 'bad']);
    expect(rows[1].details).toEqual({ unreadable: '{not json' });
  });

  test('on start, a subject stored over the cap by an older version is cut the same way', async () => {
    const g = h.store.graph as GraphRepo;
    await g.run(`CREATE (:Activity {id: 'old', ts: 't', order: 1, kind: 'doc_added', actor: 'x', subject: $s, why: 'w', details: '{"name":"a.md"}', targets: []})`, { s: 'y'.repeat(2000) });
    await g.run(`CREATE (:Activity {id: 'old2', ts: 't', order: 2, kind: 'doc_added', actor: 'x', subject: $s, why: 'w', details: '{}', targets: []})`, { s: 'z'.repeat(600) });
    await h.store.ensureSchema();
    const rows = await a.list({});
    expect(rows.map((r) => [r.subject.length, r.details])).toEqual([[500, { subjectChars: 600 }], [500, { name: 'a.md', subjectChars: 2000 }]]);
  });
}, { only: ['neo4j'] });
