import { matchTriggers, type HumanTurn, type PostMortemInput } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { runPostMortem, type Touched } from './postmortem.ts';

// A fictional repository where the derivation before 0.8.3 served a file lessons unrelated to it: a folder glob taken
// from a file the post-mortem cited, `**/*.sql` from an "applies when", `Dockerfile/**` on a file, and a review comment
// on no file given the folders of the PR's other files.
const REPO = [
  'services/ledger/handlers/transfer.go', 'services/ledger/handlers/refund.go', 'services/ledger/store/accounts.sql', 'services/ledger/store/queries.go',
  'deploy/images/Dockerfile', 'web/src/exporter.ts', 'web/src/format.ts',
];

const turn = (text: string, extra: Partial<HumanTurn> = {}): HumanTurn => ({ uuid: 'manual:1', sessionId: 'manual:1', ts: '2026-10-01T10:00:00Z', index: 1, text, precedingAssistantText: 'done', precedingToolCalls: [], ...extra });
const input = (text: string, extra: Partial<HumanTurn> = {}, over: Partial<PostMortemInput> = {}): PostMortemInput => ({
  feedbackId: 'manual:1', projectKey: 'ledger', repoPath: '/roots/1/ledger', cwd: '/roots/1/ledger', sessionId: 'manual:1', note: null, feedback: turn(text, extra), turns: [], ...over,
});
type Answer = { rule: string; appliesWhen?: string; paths: string[]; cited?: string[] };
const run = (i: PostMortemInput, a: Answer, touched: Touched = { edited: [], fixed: [] }) => runPostMortem(i, {
  standing: async () => [], facts: async () => [], repoFiles: async () => REPO, touched: async () => touched,
  exists: async (_i, p) => REPO.some((f) => f === p || f.startsWith(`${p}/`)),
  llm: { id: 'fake', agentic: false, json: async () => ({
    taskTitle: 'Ledger', missed: 'm', cause: 'implementation_error', causeExplanation: 'x', outcome: 'addressed',
    lesson: { title: 'Lesson', rule: a.rule, appliesWhen: a.appliesWhen ?? 'changing the exporter', scope: 'project', paths: a.paths },
    contextItems: (a.cited ?? []).map((ref) => ({ kind: 'code', ref, excerpt: 'func Transfer(ctx context.Context) error {', why: 'w' })),
  }) },
});
const fires = (t: Parameters<typeof matchTriggers>[0], file: string) => matchTriggers(t, { files: [file] })?.trigger ?? null;

describe('a lesson\'s triggers come from the lesson, not from what its post-mortem looked at', () => {
  test('a Go file gets no lesson through the folder of a file the post-mortem only cited', async () => {
    const r = await run(input('the exporter in web/src/exporter.ts drops the last page'), { rule: 'Flush the final page in exportRows before closing the writer', paths: ['web/src/exporter.ts'], cited: ['services/ledger/handlers/transfer.go'] });
    expect(r.lesson.triggers).toEqual({ paths: ['web/src/*.ts'], patterns: [], symbols: ['exportRows'] });
    expect(fires(r.lesson.triggers, 'services/ledger/handlers/refund.go')).toBeNull();
  });

  test('a SQL lesson about one query reaches its folder, not every .sql file; a rule about every SQL file is broad and flagged', async () => {
    const one = await run(input('the account lookup leaks a cursor'), { rule: 'Close the cursor before returning from the account lookup', appliesWhen: 'changing a SQL query', paths: ['services/ledger/store/accounts.sql'] }, { edited: [], fixed: ['services/ledger/store/accounts.sql'] });
    expect(one.lesson.triggers?.paths).toEqual(['services/ledger/store/*.sql']);
    expect(fires(one.lesson.triggers, 'billing/reports/totals.sql')).toBeNull();
    expect(one.lessonChecks?.map((c) => c.name)).not.toContain('broad-trigger');
    const every = await run(input('this migration cannot be rolled back'), { rule: 'Every SQL migration must have a down step', paths: ['services/ledger/store/accounts.sql'] });
    expect(every.lesson.triggers?.paths).toEqual(['services/ledger/store/*.sql', '**/*.sql', '**/migrations/**']);
    expect(every.lessonChecks?.find((c) => c.name === 'broad-trigger')?.why).toMatch(/\*\*\/\*\.sql, \*\*\/migrations\/\*\* fires on every such file/);
  });

  test('a Dockerfile is a file: its trigger is that file, never Dockerfile/**', async () => {
    const r = await run(input('pin the base image in deploy/images/Dockerfile'), { rule: 'Pin the base image of the ledger image by digest', paths: ['deploy/images/Dockerfile'] });
    expect(r.lesson.triggers?.paths).toEqual(['deploy/images/Dockerfile']);
  });

  test('a review comment on no file gets no folder of the PR\'s other files', async () => {
    const ext = {
      source: 'github' as const, kind: 'review' as const, author: 'lead', url: 'https://github.test/o/r/pull/9#review-1', thread: 'o/r#9', title: 'Refunds',
      threadUrl: 'https://github.test/o/r/pull/9', path: null, line: null, diffHunk: null, branch: 'feat/refunds', createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: ['s1'],
    };
    const work = { sessionId: 's1', source: 'claude' as const, cwd: '/roots/1/ledger', turns: [], matchedBy: 'branch' as const };
    const r = await run(
      input('Refund amounts should be validated before they are queued', { external: ext, sessionId: 'github:o/r#9' }, { source: 'github', work, sessionId: 'github:o/r#9' }),
      { rule: 'Validate a refund amount in validateRefund before queueing it', paths: ['services/ledger/handlers/refund.go'] },
      { edited: ['services/ledger/handlers/refund.go', 'services/ledger/store/queries.go'], fixed: ['services/ledger/handlers/refund.go'] },
    );
    expect(r.lesson.triggers).toEqual({ paths: [], patterns: [], symbols: ['validateRefund'] });
  });
});
