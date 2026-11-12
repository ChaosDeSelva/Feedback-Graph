import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HumanTurn, PostMortemInput } from '@fb/core';
import { expect, test } from 'vitest';
import { buildPrompt, loadStandingContext, markAvailability, runPostMortem } from './postmortem.ts';

const turn = (i: number, text: string, extra: Partial<HumanTurn> = {}): HumanTurn => ({
  uuid: `t${i}`, sessionId: 's1', ts: `2026-10-01T10:0${i}:00Z`, index: i, text, precedingAssistantText: '', precedingToolCalls: [], ...extra,
});
const ext = {
  source: 'linear' as const, kind: 'linear_comment' as const, author: 'pm', url: 'u', thread: 'ENG-42', title: 'Cents', threadUrl: 'u', path: 'api/price.ts', line: null,
  diffHunk: null, branch: null, createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: [],
};
const base: PostMortemInput = {
  feedbackId: 'c1', projectKey: 'demo', repoPath: '/vibe/demo', cwd: '', sessionId: 'linear:ENG-42', note: null, source: 'linear',
  feedback: { ...turn(1, 'prices must be integer cents'), external: ext }, turns: [],
};

test('a Linear comment on a file with no line, worked out against a Codex session on its branch, with odd tool calls and a long message', () => {
  const work = [turn(0, 'x'.repeat(3000), { precedingToolCalls: [{ name: 'Bash', ts: 't', command: 'pnpm test' }, { name: 'TodoWrite', ts: 't' }] })];
  const p = buildPrompt({ ...base, work: { sessionId: 'w1', source: 'codex', cwd: '/w', turns: work, matchedBy: 'branch' } }, [], { agentic: false, facts: [] });
  expect(p).toContain('File: api/price.ts\n');
  expect(p).toContain("Session w1 (Codex), matched because it ran on the issue's branch. ");
  expect(p).toContain('  - Bash pnpm test\n  - TodoWrite\n');
  expect(p).toContain(`${'x'.repeat(100)}`);
  expect(p).not.toContain('x'.repeat(2500));
});

test('a memory note written after the feedback is not standing context it could have had', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbpm-mem-'));
  const repo = join(root, 'demo');
  const mem = join(root, 'mem');
  await mkdir(repo);
  await mkdir(mem);
  await writeFile(join(mem, 'old.md'), 'old note');
  await writeFile(join(mem, 'new.md'), 'new note');
  await utimes(join(mem, 'old.md'), new Date('2026-09-01'), new Date('2026-09-01'));
  const docs = await loadStandingContext({ repoPath: repo, stopAt: root, memoryDir: mem, before: '2026-10-01T00:00:00Z' });
  expect(docs.map((d) => d.ref)).toEqual([join(mem, 'old.md')]);
});

test('a cited file given by a longer path than the standing context holds is matched to it', () => {
  const items = markAvailability([{ kind: 'code', ref: '/Users/you/Vibe/demo/AGENTS.md', excerpt: '', why: 'w' }], { ...base, source: 'claude' }, [{ kind: 'agents_md', ref: 'demo/AGENTS.md', text: 't', loaded: true }]);
  expect(items[0]).toMatchObject({ kind: 'agents_md', wasAvailable: true });
});

test('examples that cannot be read and a cause the standing context contradicts are both logged, and the post-mortem goes on', async () => {
  const logs: string[] = [];
  const r = await runPostMortem({ ...base, source: 'claude', feedback: turn(1, 'you used npm'), turns: [turn(1, 'you used npm')] }, {
    standing: async () => [{ kind: 'claude_md', ref: '/vibe/demo/CLAUDE.md', text: 'Use pnpm', loaded: true }],
    facts: async () => [],
    examples: async () => { throw new Error('store down'); },
    log: (m) => logs.push(m),
    llm: { id: 'fake', agentic: false, json: async () => ({
      taskTitle: 'Members', missed: 'used npm', cause: 'context_missing', causeExplanation: 'The agent did not load CLAUDE.md.', outcome: 'addressed',
      lesson: { title: 'Use pnpm here', rule: 'Run pnpm, not npm, in package.json scripts', appliesWhen: 'installing packages', scope: 'project', paths: [] },
      contextItems: [],
    }) } as never,
  });
  expect(r.cause).toBe('context_available_ignored');
  expect(logs).toEqual(expect.arrayContaining(['lesson examples unavailable; the post-mortem runs without them', 'post-mortem cause contradicted the standing context; corrected']));
});
