import { beforeAll, expect, test } from 'vitest';
import type { ActivityStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { ActivityRepo } from './activity.ts';
import { neo4jStore } from './neo4j-store.ts';
import { GraphRepo } from './repo.ts';

const targetsOf = (h: { store: { activity: unknown } }) => (h.store.activity as ActivityRepo).targets!;

describeStores('ActivityStore', (h) => {
  let a: ActivityStore;
  beforeAll(() => {
    a = h.store.activity;
  });

  test('cursor pagination reads every run entry without duplicates', async () => {
    for (let i = 0; i < 7; i++) await a.record({ kind: 'context_served', actor: 'fixture', projectKey: null, subject: String(i), why: 'fixture', run: 'paged', sandbox: true });
    const first = await a.list({ run: 'paged', limit: 3 });
    const second = await a.list({ run: 'paged', before: first.at(-1)!.id, limit: 3 });
    const last = await a.list({ run: 'paged', before: second.at(-1)!.id, limit: 3 });
    expect([...first, ...second, ...last].map(x => x.subject)).toEqual(['6', '5', '4', '3', '2', '1', '0']);
    expect(await a.list({ run: 'paged', before: last.at(-1)!.id, limit: 3 })).toEqual([]);
  });

  test('since reads the log in the order it was written, page by page from a cursor, by kind, unlabelled and settled', async () => {
    const page0 = await a.since({ limit: 10 });
    expect(page0).toEqual({ entries: [], next: null });
    for (let i = 0; i < 5; i++) {
      await a.record({ kind: i % 2 ? 'predone_check' : 'context_served', actor: 'fixture', projectKey: null, subject: String(i), why: 'w', run: i === 4 ? 'labelled' : null });
    }
    const first = await a.since({ limit: 2 });
    const second = await a.since({ after: first.next, limit: 2 });
    const third = await a.since({ after: second.next, limit: 2 });
    expect([first, second, third].map((p) => p.entries.map((x) => x.subject))).toEqual([['0', '1'], ['2', '3'], ['4']]);
    expect(third.entries[0]).toMatchObject({ kind: 'context_served', run: 'labelled', details: {}, targets: [] });
    // Nothing new: the same cursor comes back, so a reader keeps its place.
    expect(await a.since({ after: third.next, limit: 2 })).toEqual({ entries: [], next: third.next });
    await a.record({ kind: 'lessons_checked', actor: 'worker', projectKey: 'demo', subject: '5', why: 'w' });
    expect((await a.since({ after: third.next, limit: 2 })).entries.map((x) => x.subject)).toEqual(['5']);
    expect((await a.since({ kinds: ['predone_check', 'lessons_checked'], limit: 10 })).entries.map((x) => x.subject)).toEqual(['1', '3', '5']);
    expect((await a.since({ unlabelled: true, limit: 10 })).entries.map((x) => x.subject)).toEqual(['0', '1', '2', '3', '5']);
    expect(await a.since({ until: '2000-01-01T00:00:00.000Z', limit: 10 })).toEqual({ entries: [], next: null });
    expect((await a.since({ until: '2999-01-01T00:00:00.000Z', limit: 10 })).entries).toHaveLength(6);
    // last: the end of the log, oldest first, and the cursor that reads on from it.
    const tail = await a.since({ last: true, limit: 2 });
    expect(tail.entries.map((x) => x.subject)).toEqual(['4', '5']);
    expect(await a.since({ after: tail.next, limit: 2 })).toEqual({ entries: [], next: tail.next });
    expect((await a.since({ last: true, kinds: ['context_served'], unlabelled: true, limit: 5 })).entries.map((x) => x.subject)).toEqual(['0', '2']);
    expect((await a.since({ last: true, after: first.next, limit: 10 })).entries.map((x) => x.subject)).toEqual(['2', '3', '4', '5']);
    expect(await a.since({ last: true, limit: 10, until: '2000-01-01T00:00:00.000Z' })).toEqual({ entries: [], next: null });
    for (const bad of ['garbage', 'abc/act:1']) await expect(a.since({ after: bad, limit: 1 })).rejects.toThrow('not an Activity cursor');
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
    await a.record({ kind: 'doc_added', actor: 'github', projectKey: 'shop', subject: 'PR ghp' + '_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', why: 'why ghp' + '_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', details: { prs: [{ title: 'x ghp' + '_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }] } });
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

  test('an entry is found by a target through its (:ActivityTarget) key; entries an older version stored get theirs on start', async () => {
    const g = h.store.graph as GraphRepo;
    await a.record({ kind: 'context_served', actor: 'x', projectKey: 'shop', subject: 'new', why: 'w', targets: ['lesson:1', 's1', 'lesson:1'] });
    await g.run(`CREATE (:Activity {id: 'old', ts: 't', order: 1, kind: 'context_served', actor: 'x', subject: 'old', why: 'w', details: '{}', targets: ['lesson:1', 's0', 's0']})`);
    expect((await a.list({ target: 'lesson:1' })).map((x) => x.subject)).toEqual(['new']);
    await h.store.ensureSchema();
    expect((await a.list({ target: 'lesson:1' })).map((x) => x.subject)).toEqual(['new', 'old']);
    expect((await a.list({ target: 's0' })).map((x) => x.subject)).toEqual(['old']);
    // The upgrade runs in the background; until it is done the reads above found 'old' by its targets list.
    expect(await targetsOf(h).settled()).toBe(true);
    // One key per id, one edge per target an entry names, however often it names it.
    const [r] = await g.run('MATCH (k:ActivityTarget) WITH count(k) AS keys MATCH ()-[e:ABOUT]->() RETURN keys, count(e) AS edges');
    expect([Number(r.get('keys')), Number(r.get('edges'))]).toEqual([3, 4]);
    await h.store.ensureSchema();
    await targetsOf(h).settled();
    const [again] = await g.run('MATCH ()-[e:ABOUT]->() RETURN count(e) AS edges');
    expect(Number(again.get('edges'))).toBe(4);
  });

  test('the upgrade removes the duplicate ABOUT edges an earlier build left, once, and reads list each entry once meanwhile', async () => {
    const g = h.store.graph as GraphRepo;
    // As an RC's api and worker left them, both linking the same entry: two edges per target.
    await g.run(`UNWIND range(1, 30) AS i CREATE (x:Activity {id: 'old' + i, ts: 't', order: i, kind: 'context_served', actor: 'x', subject: 'old' + i, why: 'w', details: '{}', targets: ['lesson:1', 's' + (i % 3)]})
                 WITH x UNWIND x.targets AS tid MERGE (k:ActivityTarget {id: tid}) CREATE (x)-[:ABOUT]->(k) CREATE (x)-[:ABOUT]->(k)`);
    await h.store.ensureSchema();
    expect(await a.list({ target: 'lesson:1' })).toHaveLength(30);
    expect(await targetsOf(h).settled()).toBe(true);
    const edges = async () => Number((await g.run('MATCH (:Activity)-[e:ABOUT]->() RETURN count(e) AS n'))[0].get('n'));
    expect(await edges()).toBe(60);
    expect((await a.list({ target: 'lesson:1' })).map((x) => x.id).sort()).toEqual(Array.from({ length: 30 }, (_, i) => `old${i + 1}`).sort());
    // Done is kept on the store: a later start does not walk the log again.
    await g.run("MATCH (x:Activity {id: 'old1'}), (k:ActivityTarget {id: 'lesson:1'}) CREATE (x)-[:ABOUT]->(k)");
    await h.store.ensureSchema();
    await targetsOf(h).settled();
    expect(await edges()).toBe(61);
  });

  test('entries recorded while the upgrade links older ones to the same keys are all written, and every entry is linked once', async () => {
    const g = h.store.graph as GraphRepo;
    await g.run(`UNWIND range(1, 4000) AS i CREATE (:Activity {id: 'old' + i, ts: 't', order: i, kind: 'context_served', actor: 'x', subject: 's', why: 'w', details: '{}', targets: ['session:' + (i % 5), 'lesson:' + (i % 3)]})`);
    await h.store.ensureSchema();
    const written = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => a.record({ kind: 'context_served', actor: 'x', projectKey: 'shop', subject: `new${i}`, why: 'w', targets: [`session:${i % 5}`, `lesson:${i % 3}`] })));
    expect(written.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await targetsOf(h).settled()).toBe(true);
    const [r] = await g.run('MATCH (x:Activity) OPTIONAL MATCH (x)-[e:ABOUT]->(k) WITH x, k, count(e) AS c RETURN count(DISTINCT x) AS entries, sum(c) AS edges, max(c) AS most');
    expect([Number(r.get('entries')), Number(r.get('edges')), Number(r.get('most'))]).toEqual([4060, 8120, 1]);
  });

  test('two processes starting at once link each older entry once, and neither waits for the upgrade', async () => {
    const g = h.store.graph as GraphRepo;
    await g.run(`UNWIND range(1, 3000) AS i CREATE (:Activity {id: 'old' + i, ts: 't', order: i, kind: 'context_served', actor: 'x', subject: 's', why: 'w', details: '{}', targets: ['session:' + (i % 40), 'lesson:' + (i % 7)]})`);
    const other = neo4jStore(await GraphRepo.connect(process.env.NEO4J_TEST_URL ?? 'bolt://127.0.0.1:7688', process.env.NEO4J_TEST_USER ?? 'neo4j', process.env.NEO4J_TEST_PASSWORD ?? 'testpassword'));
    try {
      await Promise.all([h.store.ensureSchema(), other.ensureSchema()]);
      // Correct before either is done: by the targets list, then by key.
      expect(await other.activity.list({ target: 'lesson:3', limit: 1000 })).toHaveLength(429);
      await Promise.all([targetsOf(h).settled(), (other.activity as ActivityRepo).targets!.settled()]);
      // The one that did not hold the lease is told on its next try; it reads by key from then on.
      expect(await (other.activity as ActivityRepo).targets!.run()).toBe(0);
      const [r] = await g.run('MATCH (x:Activity)-[e:ABOUT]->(k) WITH x, k, count(e) AS c RETURN sum(c) AS edges, max(c) AS most');
      expect([Number(r.get('edges')), Number(r.get('most'))]).toEqual([6000, 1]);
      const listed = await a.list({ target: 'lesson:3', limit: 1000 });
      expect(new Set(listed.map((x) => x.id)).size).toBe(listed.length);
      expect(listed).toHaveLength(429);
    } finally {
      await other.close();
    }
  });
}, { only: ['neo4j'] });

/** A target's or a kind's entries, and the log's next page, are found by index: the loop and the track route read them every round. */
describeStores('ActivityStore at scale', (h) => {
  test('list by target or kind, and since a cursor, do about the same work with ten times the log', async () => {
    const a = h.store.activity;
    const fill = async (from: number, to: number) => {
      for (let i = from; i < to; i += 50) {
        await Promise.all(Array.from({ length: Math.min(50, to - i) }, (_, j) => a.record({ kind: 'context_served', actor: 'x', projectKey: 'shop', subject: 's', why: 'w', targets: [`lesson:${i + j}`, `s${(i + j) % 7}`] })));
      }
    };
    // The database work of 31 reads of each kind (StoreProbe.work): by target, by kind, and the next page of the log in
    // write order from a cursor near its start. A count of rows or db hits, so a busy host cannot fail it.
    const reads = async (n: number) => {
      const cursor = (await a.since({ limit: 20 })).next;
      const out = [];
      for (const read of [
        (i: number) => a.list({ target: `lesson:${(i * 37) % n}`, limit: 200 }),
        () => a.list({ kind: 'context_served', limit: 20 }),
        () => a.since({ after: cursor, kinds: ['context_served'], limit: 20 }),
      ]) {
        out.push(await h.probe.work(async () => { for (let i = 0; i < 31; i++) await read(i); }));
      }
      return out;
    };
    await fill(0, 300);
    const small = await reads(300);
    await fill(300, 3000);
    const large = await reads(3000);
    for (const [i, what] of ['list by target', 'list by kind', 'since a cursor'].entries()) {
      // An index read, not a scan: a deeper index costs a few more per read, never ten times as many.
      expect(large[i], `${what}: ${small[i]} at 300, ${large[i]} at 3000`).toBeLessThan(1.5 * small[i] + 31 * 4);
    }
  }, 300_000);
});
