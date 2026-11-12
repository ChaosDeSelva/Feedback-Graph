import type { ActivityInput, ClassifiableTurn, Project } from '@fb/core';
import { expect, test } from 'vitest';
import { runCycle, type CycleDeps } from './cycle.ts';
import { FileState } from './state.ts';

const line = (o: object) => JSON.stringify({ sessionId: 's1', cwd: '/H/Vibe/demo', ...o });
const transcript = [
  line({ type: 'user', uuid: 'u0', timestamp: '2026-10-01T10:00:00Z', message: { content: 'build search' } }),
  line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:01:00Z', message: { content: [{ type: 'text', text: 'done' }] } }),
  line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:02:00Z', message: { content: 'this is still broken' } }),
].join('\n');

function deps(over: Partial<CycleDeps> = {}): CycleDeps {
  return {
    listFiles: async () => [{ path: '/t/demo/s1.jsonl', size: 100, mtimeMs: 1 }],
    readFile: async () => transcript,
    readLines: async function* () {},
    state: new FileState(':memory:'),
    repo: {
      upsertSession: async () => {},
      unclassifiedTurns: async () => [],
      saveClassification: async (uuid, _c, cand) => (cand ? uuid : null),
      recordClassifyFailure: async () => {},
    },
    roots: [{ host: '/H/Vibe', container: '/vibe' }],
    commits: async () => [],
    classify: async () => ({ label: 'pushback', confidence: 0.8, summary: 'it is broken', signals: [] }),
    classifyBatch: 5,
    ...over,
  };
}

test('a folder made a clone of an unselected project between the dry run and the write is skipped, not ingested under it', async () => {
  const main: Project = { key: 'demo-main', name: 'demo-main', repoPath: '/vibe/demo-main', remote: 'github.com/org/demo' };
  const upserted: string[] = [];
  const d = deps({
    remote: async () => 'github.com/org/demo',
    includeProject: (k) => k === 'demo',
    projects: {
      // The dry run sees no other clone yet; by the real call one has been recorded with the same remote.
      canonicalProject: async (folder, o) => (o?.dryRun ? { project: folder, aliasedNow: false } : { project: main, aliasedNow: true }),
      projectsMissingFolder: async () => [],
      fillProjectFolder: async () => {},
    },
  });
  d.repo.upsertSession = async (p) => { upserted.push(p.key); };
  expect((await runCycle(d)).filesIngested).toBe(0);
  expect(upserted).toEqual([]);
  expect(d.state.ingestState('/t/demo/s1.jsonl', 100, 1).skipped).toEqual(['demo-main']);
});

test("a flagged turn from a sandboxed run is logged with its run, and a long message is clipped in the subject", async () => {
  const text = 'this is still broken '.repeat(6);
  const turn: ClassifiableTurn = {
    uuid: 'u1', sessionId: 's1', ts: '2026-10-01T10:02:00Z', index: 1, text, precedingAssistantText: 'done', precedingToolCalls: [],
    projectKey: 'demo', run: 'run-7', sandbox: true,
  };
  const activity: ActivityInput[] = [];
  let given = false;
  const d = deps({ listFiles: async () => [], activity: { record: async (a) => void activity.push(a) } });
  d.repo.unclassifiedTurns = async () => (given ? [] : ((given = true), [turn]));
  await runCycle(d);
  const [flagged] = activity.filter((a) => a.kind === 'candidate_flagged');
  expect(flagged).toMatchObject({ run: 'run-7', sandbox: true, actor: 'classifier', targets: ['u1'] });
  expect(flagged.subject).toBe(`flagged as pushback: "${text.slice(0, 80)}…"`);
});

test('one comment kept from the classifier is counted in the singular', async () => {
  const external = {
    source: 'github' as const, kind: 'review_comment' as const, author: 'bot', authorKind: 'bot' as const, url: 'u', thread: 'acme/shop#7', title: 'Add checkout',
    threadUrl: 'u', path: null, line: null, diffHunk: null, branch: 'feat', createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: [],
  };
  const turn: ClassifiableTurn = {
    uuid: 'github:acme/shop#7/review_comment/1', sessionId: 'github:acme/shop#7', ts: '2026-10-02T10:00:00Z', index: 1,
    text: 'Docs out of date (HIGH)', precedingAssistantText: '', precedingToolCalls: [], external, projectKey: 'shop',
  };
  const activity: ActivityInput[] = [];
  let given = false;
  const d = deps({ listFiles: async () => [], activity: { record: async (a) => void activity.push(a) } });
  d.repo.unclassifiedTurns = async () => (given ? [] : ((given = true), [turn]));
  await runCycle(d);
  expect(activity.find((a) => a.kind === 'comments_skipped')?.subject).toBe('1 comment skipped before the classifier');
});
