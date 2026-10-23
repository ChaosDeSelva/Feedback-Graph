import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import type { ParsedSession } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const NUL = '\u0000';
const strip = (s: string | null | undefined) => (s ?? '').replaceAll(NUL, '');

/**
 * Transcripts can carry NUL characters (binary tool output pasted into a turn). Neo4j stores them; Postgres text and
 * jsonb refuse them. Every write must land on both, with the text otherwise intact.
 */
describeStores('Text with NUL characters', (h) => {
  let store: Store;
  let probe: StoreProbe;
  beforeAll(() => {
    store = h.store;
    probe = h.probe;
  });

  test('sessions, turns, tool calls, facts, docs, lessons and activity with NUL characters are stored', async () => {
    const text = `before${NUL}after`;
    const s: ParsedSession = {
      sessionId: 's1', sourceFile: `f${NUL}`, cwd: '/x', gitBranch: `main${NUL}`, startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:01:00Z',
      toolCalls: [],
      turns: [0, 1].map((i) => ({
        uuid: `t${i}`, sessionId: 's1', ts: `2026-10-01T10:0${i}:00Z`, index: i, text, precedingAssistantText: text,
        precedingToolCalls: [{ name: 'Bash', ts: '2026-10-01T10:00:00Z', command: `cat ${NUL}bin` }],
      })),
    };
    await store.graph.upsertSession({ key: 'demo', name: `demo${NUL}`, repoPath: '/x/demo' }, s, [{ sha: 'a'.repeat(40), ts: '2026-10-01T10:00:30Z', subject: `fix${NUL}` }]);
    expect(strip((await probe.turn('t1'))?.text)).toBe('beforeafter');

    await store.graph.saveClassification('t1', { label: 'pushback', confidence: 0.9, summary: text, signals: [text] }, true);
    await store.graph.decide('t1', 'confirmed', text);
    await store.facts.saveFileFacts('demo', { path: 'a.ts', hash: 'h', summary: text }, [
      { kind: 'gotcha', statement: text, path: 'a.ts', lines: null, confidence: 1, why: text, embedding: vec(1) },
    ], 'p');
    expect((await store.facts.listFacts({ projectKey: 'demo' })).map((f) => strip(f.statement))).toEqual(['beforeafter']);
    await store.docs.upsertDoc({ projectKey: 'demo', source: 'upload', ref: 'upload:a.md', title: text, url: null }, [{ text, embedding: vec(2) }]);
    await store.knowledge.upsertLesson({ id: 'mem:1', projectKey: 'demo', title: text, rule: text, appliesWhen: text, scope: 'project', paths: [text], status: 'approved', source: 'memory', embedding: vec(3) });
    await store.activity.record({ kind: 'doc_added', actor: 'you', projectKey: 'demo', subject: text, why: text, details: { text, nested: [text] }, targets: [text] });
    const [a] = await store.activity.list({ projectKey: 'demo' });
    expect(strip(a.subject)).toBe('beforeafter');
    expect(strip(a.details.text as string)).toBe('beforeafter');
    await store.codegraph.replaceCodeMap('demo', {
      files: [{ path: 'a.ts', lang: 'typescript', hash: 'h', loc: 1, isTest: false }],
      symbols: [{ id: 'a.ts#x', path: 'a.ts', name: `x${NUL}`, kind: 'const', exported: true, lines: '1-1' }],
      imports: [{ from: 'a.ts', to: 'pkg:x', names: [text], spec: text }],
      tests: [],
      churn: {},
      fingerprint: text,
    });
    expect(strip((await store.codegraph.codeMap('demo'))?.symbols[0].name)).toBe('x');
  });
});
