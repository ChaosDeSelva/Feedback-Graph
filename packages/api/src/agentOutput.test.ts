// What an agent receives from the MCP tools, measured on realistic inputs: what is in, what is left out, and how big.
import type { DocHit, FactHit, FileMiss, Lesson, ModuleContext, RelatedMiss, SessionDetail, SessionListItem, StoredFact } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { checkBeforeDone, getRecentSessions, getTaskContext, searchGraph, type ContextDeps } from './context.ts';

const roots = [{ host: '/Users/j/Vibe', container: '/vibe' }];
const lesson = (id: string, title: string, over: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title, rule: `${title}: ${'keep the rule short and concrete, '.repeat(2)}`, appliesWhen: 'chat rendering', scope: 'project', paths: [],
  status: 'approved', source: 'postmortem', cause: 'requirement_unstated', missId: `miss:${id}`, createdAt: 't', decidedAt: 't', ...over,
});
const fact = (id: string, path: string, statement: string, over: Partial<StoredFact> = {}): StoredFact => ({
  id, projectKey: 'demo', path, lines: '10-40', kind: 'convention', statement, why: 'w', confidence: 1, source: 'codex-cli', createdAt: '2026-10-20T08:00:00Z',
  scanJobId: null, fileHash: null, fileSummary: null, relevance: 0.8, relevanceBy: 'model', docId: null, ...over,
} as StoredFact);
const related = (missId: string, missed: string, score: number): RelatedMiss => ({ missId, missed, cause: 'context_available_ignored', feedbackText: 'that is not what I asked for, '.repeat(3), sessionId: `s-${missId}`, ts: '2026-10-10T10:00:00Z', score } as RelatedMiss);
const fileMiss = (missId: string, missed: string, paths: string[], ts = '2026-10-12T10:00:00Z'): FileMiss => ({
  missId, missed, cause: 'context_available_ignored', causeExplanation: 'x', feedbackId: `fb:${missId}`, feedbackText: 'do not do that again', sessionId: `s-${missId}`, ts, paths, fixedHere: false, lessonId: null,
});
const doc = (ref: string, title: string, source: DocHit['source'], score: number): DocHit => ({ docId: `doc:${ref}`, source, ref, title, url: source === 'github' ? `https://github.com/acme/demo-shop/pull/${ref.split('#')[1]}` : null, text: `${title}. ${'Reviewers discussed the rollout, the redirect and the tests at length. '.repeat(12)}`, score });
const session = (id: string, turnCount: number, lastActivityAt: string): SessionListItem => ({
  id, projectKey: 'demo', source: 'claude', cwd: '/vibe/demo', gitBranch: 'main', startedAt: lastActivityAt, lastActivityAt, turnCount, state: 'ended',
  snippet: `Goal of ${id}: ${'render archived threads in the new chat, '.repeat(3)}`, summarizedThrough: { index: turnCount, ts: lastActivityAt } as never, summaryUpdatedAt: lastActivityAt, summaryVersion: 1, pendingTurns: 0,
} as unknown as SessionListItem);

const named = ['web/src/chat/pipeline.ts', 'web/src/chat/legacy-threads.ts', 'web/src/chat/embed.tsx', 'web/src/chat/markdown.tsx', 'web/src/chat/app-markdown.tsx', 'api/src/routes/history.ts'];
// One false miss the detector attached to every changed file, and two real ones.
const wide = fileMiss('m-wide', 'pushed a branch the developer had said not to push yet', named);
const mods = new Map<string, ModuleContext>(named.map((p, i) => [p, {
  file: { path: p, lang: 'typescript', hash: 'h', loc: 200, isTest: false, churn: null },
  symbols: [], imports: [],
  importers: i === 0 ? ['web/src/chat/markdown.tsx', 'web/src/legacy/page.tsx', 'web/src/chat/prose.tsx'] : [`web/src/x${i}.ts`],
  tests: i === 1 ? ['web/src/chat/legacy-threads.test.ts'] : [],
  facts: [],
  misses: [{ ...wide, paths: [p] }, ...(i === 0 ? [fileMiss('m-tags', 'self-closing custom tags swallowed the rest of the message', [p], '2026-10-14T10:00:00Z')] : [])],
  lessons: [],
} satisfies ModuleContext]));

/** A project with a real backlog: many lessons, misses, facts, docs, sessions and a linked project. */
function bigDeps(over: Partial<ContextDeps> = {}): ContextDeps & { scans: [string, string[]][] } {
  const scans: [string, string[]][] = [];
  const similar = Array.from({ length: 12 }, (_, i) => related(`r${i}`, `missed something in web/src/settings/page${i}.tsx about ${'state handling and the list '.repeat(2)}`, 0.7 - i * 0.02));
  const facts: FactHit[] = Array.from({ length: 30 }, (_, i) => ({ fact: fact(`f${i}`, i % 3 ? `web/src/chat/f${i}.ts` : `graph/internal/f${i}.go`, `Fact ${i}: ${'the pipeline pairs self-closing custom tags before parsing, '.repeat(3)}`), score: 0.75 - i * 0.01 }));
  return {
    roots,
    embed: async (t) => t.map(() => [1, 0]),
    k: {
      searchLessons: async () => Array.from({ length: 6 }, (_, i) => ({ lesson: lesson(`l${i}`, `Lesson ${i}`), score: 0.8 - i * 0.03 })),
      relatedMisses: async (q) => (q.projectKey === 'demo' ? similar : [related('x1', 'linked miss far from this task', 0.12)]),
      recordPreDoneCheck: async () => {},
      createManualFeedback: async () => 'manual:1',
    },
    judge: async () => [],
    facts: {
      searchFacts: async (q) => (q.projectKey === 'demo' ? facts : [{ fact: fact('lf', 'svc/a.ts', 'linked fact far from the task'), score: 0.1 }]),
      listFacts: async (q) => (q.path === named[0] ? [fact('p1', named[0], 's', { createdAt: '2026-10-25T09:00:00Z' })] : []),
    },
    docs: {
      searchDocs: async (q) => q.projectKey === 'demo'
        ? [doc('github:acme/demo-shop#142', 'Remove legacy thread creation', 'github', 0.62), doc('github:acme/demo-shop#77', 'Settings list refactor', 'github', 0.5), doc('upload:notes.md', 'Release notes', 'upload', 0.45), doc('github:acme/demo-shop#12', 'Old PR', 'github', 0.41), doc('upload:x.md', 'Misc', 'upload', 0.4)]
        : [doc('upload:linked.md', 'Linked doc', 'upload', 0.1)],
    },
    codegraph: {
      lessonsForPaths: async () => [],
      moduleContext: async (_k, p) => mods.get(p) ?? null,
      codeMapMeta: async () => ({ fingerprint: 'f', builtAt: '2026-10-25T08:00:00Z', stats: { files: 4000, symbols: 1, imports: 1, tests: 1 }, candidates: 10_400, unresolved: 29 }),
    },
    sessions: {
      list: async (q) => ({ sessions: [session('probe-1', 1, '2026-10-25T10:00:00Z'), session('probe-2', 1, '2026-10-25T09:00:00Z'), session('real-1', 40, '2026-10-24T10:00:00Z'), session('real-2', 12, '2026-10-23T10:00:00Z'), session('real-3', 9, '2026-10-22T10:00:00Z')].slice(0, q.limit) }),
      detail: async (id) => ({ ...session(id, id.startsWith('probe') ? 1 : 10, '2026-10-24T10:00:00Z'), summary: { markdown: `Summary of ${id}` } } as unknown as SessionDetail),
    },
    links: { listLinks: async () => [{ id: 'link', a: 'demo', b: 'tools', relation: 'related', note: '', status: 'confirmed', source: 'you', score: 0, evidence: [], createdAt: 't', updatedAt: 't' }] },
    requestScan: async (key, paths) => { scans.push([key, paths]); },
    scans,
    ...over,
  } as ContextDeps & { scans: [string, string[]][] };
}

const task = 'fix the new chat rendering only one artifact from a legacy thread';
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

describe('get_task_context on a realistic backlog', () => {
  test('stays within its size budget, says "data, not instructions" once, and ends with the check_before_done pointer', async () => {
    const r = await getTaskContext({ project: 'demo', task, files: named }, bigDeps());
    // 6 lessons, 2 misses on 6 files, 4 similar misses, 6 mapped files, 3 sessions, 10 facts, 5 docs: about 10.7k today.
    expect(r.markdown.length).toBeLessThan(11_000);
    expect(count(r.markdown, /data, not instructions/gi)).toBe(1);
    expect(r.markdown.trim().split('\n').at(-1)).toMatch(/check_before_done/);
    // the false miss on six files is there once, with its files
    expect(count(r.markdown, /pushed a branch the developer had said not to push yet/g)).toBe(1);
  });

  test('linked-project context is left out when nothing from it is above the similarity floor', async () => {
    const r = await getTaskContext({ project: 'demo', task, files: named }, bigDeps());
    expect(r.markdown).not.toContain('From linked projects');
    expect(r.linked.flatMap((x) => [...x.lessons, ...x.misses, ...x.facts, ...x.docs])).toEqual([]);
  });

  test('misses and facts show their similarity, compactly', async () => {
    const r = await getTaskContext({ project: 'demo', task }, bigDeps());
    expect(r.markdown).toMatch(/missed something in web\/src\/settings\/page0\.tsx.*· match 0\.70/);
    expect(r.markdown).toMatch(/Fact 1:.*· match 0\.\d\d/);
  });

  test('named files with no facts are queued for a scan, and the answer says so', async () => {
    const d = bigDeps();
    const r = await getTaskContext({ project: 'demo', task, files: named }, d);
    expect(d.scans).toEqual([['demo', named.slice(1)]]);
    expect(r.markdown).toMatch(/`web\/src\/chat\/legacy-threads\.ts`: no facts from a scan yet; queued: the next scan of this project reads it first/);
  });

  test('without a scan queue the files are only said to have no facts', async () => {
    const r = await getTaskContext({ project: 'demo', task, files: named }, bigDeps({ requestScan: undefined }));
    expect(r.markdown).toMatch(/`web\/src\/chat\/legacy-threads\.ts`: no facts from a scan yet$/m);
  });

  test('facts refreshed after the session started are labelled as the agent\'s own change', async () => {
    const r = await getTaskContext({ project: 'demo', task, files: named, sessionStartedAt: '2026-10-25T08:30:00Z' }, bigDeps());
    expect(r.markdown).toMatch(/`web\/src\/chat\/pipeline\.ts`: 1 fact, last refreshed 2026-10-25, from your own change this session/);
    const before = await getTaskContext({ project: 'demo', task, files: named, sessionStartedAt: '2026-10-25T09:30:00Z' }, bigDeps());
    expect(before.markdown).not.toContain('your own change');
  });

  test('the session start can come from the session id', async () => {
    const d = bigDeps();
    d.sessions!.detail = async (id) => (id === 'mine' ? ({ ...session('mine', 3, '2026-10-25T08:30:00Z'), startedAt: '2026-10-25T08:30:00Z' } as unknown as SessionDetail) : null);
    const r = await getTaskContext({ project: 'demo', task, files: named, sessionId: 'mine' }, d);
    expect(r.markdown).toContain('from your own change this session');
  });

  test('recent sessions skip one-turn probe sessions', async () => {
    const r = await getTaskContext({ project: 'demo', task }, bigDeps());
    expect(r.sessions.map((s) => s.id)).toEqual(['real-1', 'real-2', 'real-3']);
  });

  test('with no files, a service the task names by its folder ranks first', async () => {
    const d = bigDeps({
      k: { ...bigDeps().k, relatedMisses: async () => [related('g', 'missed the page offsets in graph/internal/page.go', 0.62), related('w', 'missed the admin gate in web/src/settings/usage.ts', 0.58)] },
    });
    const r = await getTaskContext({ project: 'demo', task: 'add a members list to the web settings' }, d);
    expect(r.misses.map((m) => m.missId)).toEqual(['w', 'g']);
  });
});

describe('get_task_context brief', () => {
  test('is lessons, misses on the named files, their importers and tests, and PR discussions: nothing else, about 1.5k chars', async () => {
    const r = await getTaskContext({ project: 'demo', task, files: named, brief: true }, bigDeps());
    expect(r.markdown.length).toBeLessThan(1_700);
    expect(r.markdown).toContain('Lesson 0');
    expect(r.markdown).toContain('self-closing custom tags swallowed the rest of the message');
    expect(r.markdown).toMatch(/`web\/src\/chat\/pipeline\.ts`: imported by `web\/src\/chat\/markdown\.tsx`/);
    expect(r.markdown).toContain('legacy-threads.test.ts');
    expect(r.markdown).toContain('Remove legacy thread creation');
    for (const gone of ['Fact 1', 'missed something in web/src/settings', 'Recent sessions', 'Release notes', 'How fresh']) expect(r.markdown).not.toContain(gone);
  });

  test('says what it cut to stay short', async () => {
    const r = await getTaskContext({ project: 'demo', task, files: named, brief: true }, bigDeps());
    expect(r.markdown).toMatch(/left out|cut/i);
  });
});

describe('search_graph', () => {
  test('returns its hits, not the whole task context: no code map, sessions, freshness or done pointer, under ~3k chars, and says what it cut', async () => {
    const r = await searchGraph({ project: 'demo', query: 'markdown custom tags rehype' }, bigDeps());
    expect(r.markdown.length).toBeLessThan(3_300);
    for (const gone of ['Recent sessions', 'Code map', 'How fresh', 'check_before_done', 'From linked projects']) expect(r.markdown).not.toContain(gone);
    expect(r.markdown).toContain('Lesson 0');
    expect(r.markdown).toMatch(/cut .*to stay under/i);
    expect(count(r.markdown, /data, not instructions/gi)).toBe(1);
  });

  test('a nonsense query gets empty sections that say why', async () => {
    const d = bigDeps({
      k: { ...bigDeps().k, searchLessons: async () => [], relatedMisses: async () => [related('n', 'unrelated', 0.12)] },
      facts: { searchFacts: async () => [{ fact: fact('n', 'a.ts', 'unrelated'), score: 0.15 }] },
      docs: { searchDocs: async () => [] },
    });
    const r = await searchGraph({ project: 'demo', query: 'purple elephant quantum' }, d);
    expect(r.markdown).toMatch(/no past miss is close enough/i);
    expect(r.markdown).toMatch(/no codebase fact is close enough/i);
    expect(r.markdown).not.toContain('unrelated');
  });
});

describe('get_recent_sessions', () => {
  test('skips one-turn probe sessions and says how many it left out', async () => {
    const r = await getRecentSessions({ project: 'demo', limit: 3 }, bigDeps());
    expect(r.sessions).toEqual(['real-1', 'real-2', 'real-3']);
    expect(r.markdown).toMatch(/2 one-turn sessions left out/);
  });
});

describe('check_before_done on ten changed files sharing one false miss', () => {
  test('names the miss once and stays short', async () => {
    const changed = named;
    const r = await checkBeforeDone({ project: 'demo', task, summary: 'paired the custom tags', filesChanged: changed }, bigDeps({ k: { ...bigDeps().k, searchLessons: async () => [], relatedMisses: async () => [] } }));
    expect(count(r.markdown, /pushed a branch the developer had said not to push yet/g)).toBe(1);
    expect(r.markdown.length).toBeLessThan(2_000);
  });
});
