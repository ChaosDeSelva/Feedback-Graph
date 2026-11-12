import { ProviderUnavailableError, type HumanTurn } from '@fb/core';
import { expect, test } from 'vitest';
import { classifyTurn, describeTurn } from './classify.ts';

const external = {
  source: 'github' as const, kind: 'review_comment' as const, author: 'lead', url: 'u', thread: 'acme/shop#7', title: 'Add checkout', threadUrl: 'u',
  path: 'src/cart.ts', line: 3, diffHunk: null, branch: 'feat', createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: [],
};
const base: HumanTurn = { uuid: 'u1', sessionId: 's', ts: 't', index: 1, text: 'this is wrong', precedingAssistantText: '', precedingToolCalls: [] };

test('a Linear comment is described as on an issue; a reply by a reviewer says so; a kind alone names only the author', () => {
  const linear = describeTurn({ ...base, external: { ...external, source: 'linear' } });
  expect(linear).toContain('a Linear issue with work done by an AI coding agent');
  expect(linear).toContain('WHAT THE COMMENT IS ABOUT:\n(none)');
  expect(linear).not.toContain('comment metadata');

  const reply = describeTurn({ ...base, external: { ...external, threadAuthor: 'dev', isReply: true } });
  expect(reply).toContain('AUTHOR: lead, a reviewer (not the pull request author), replying in a review thread');

  const bot = describeTurn({ ...base, external: { ...external, authorKind: 'bot' } });
  expect(bot).toContain('AUTHOR: lead (a bot)\n');
});

test('a session turn lists the agent\'s calls (file, command, or bare name) and, for a broken instruction, what it did next', () => {
  const d = describeTurn({
    ...base,
    precedingToolCalls: [{ name: 'Edit', ts: 't', filePath: '/a.ts' }, { name: 'Bash', ts: 't', command: 'pnpm test' }, { name: 'TodoWrite', ts: 't' }],
    followingToolCalls: [{ name: 'Bash', ts: 't', command: 'git push' }, { name: 'Write', ts: 't', filePath: '/b.ts' }, { name: 'Task', ts: 't' }],
  });
  expect(d).toContain("AGENT'S LAST MESSAGE:\n(none)");
  expect(d).toContain("AGENT'S TOOL CALLS:\nEdit /a.ts\nBash pnpm test\nTodoWrite");
  expect(d).toContain('(what it did next):\nBash git push\nWrite /b.ts\nTask');
  expect(describeTurn(base)).toContain("AGENT'S TOOL CALLS:\n(none)");
});

test('a connection failure from the provider is unavailability (never charged), even when it is not a ProviderUnavailableError', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  const llm = { id: 'ollama:x', agentic: false, json: async () => { throw refused; } } as never;
  const err = await classifyTurn(base, llm).catch((e) => e);
  expect(err).toBeInstanceOf(ProviderUnavailableError);
  // An unusable answer with no failure callback is still null.
  const bad = { id: 'ollama:x', agentic: false, json: async () => ({ label: 'nope' }) } as never;
  expect(await classifyTurn(base, bad)).toBeNull();
});
