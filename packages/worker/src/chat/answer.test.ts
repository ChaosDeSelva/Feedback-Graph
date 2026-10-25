import { stat } from 'node:fs/promises';
import { ModelOutputError, STRICT_JSON, type ChatJob, type ChatSource, type ChatTurn, type JsonTask, type LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { answerTurn, CHAT_JSON_SCHEMA, CHAT_MAX_TOKENS, CHAT_TIMEOUT_MS, mcpFooter, OLLAMA_CHAT_CONTEXT } from './answer.ts';

const turn = (seq: number, role: ChatTurn['role'], text: string, o: Partial<ChatTurn> = {}): ChatTurn => ({
  id: `t${seq}`, conversationId: 'chat-1', seq, role, text, status: 'done', error: null, answer: null, sources: [], provider: null, createdAt: 't', startedAt: null, finishedAt: null, ...o,
});
const sources: ChatSource[] = [
  { id: 'S1', kind: 'lesson', ref: 'lesson:a', title: 'Reuse the shared Modal' },
  { id: 'S2', kind: 'code', ref: 'src/ui/Modal.tsx:10-42', title: 'Modal' },
  { id: 'S3', kind: 'code', ref: 'src/ui/ConfirmModal.tsx:5-30', title: 'ConfirmModal' },
  { id: 'S4', kind: 'fact', ref: 'src/App.tsx', title: 'App registers views' },
];
function job(): ChatJob {
  const turns = [
    turn(1, 'user', 'where do modals live?'),
    turn(2, 'assistant', 'In src/ui [S1].'),
    turn(3, 'user', 'how do I add a new modal?'),
    turn(4, 'assistant', '', { status: 'pending', sources }),
  ];
  return {
    conversation: { id: 'chat-1', projectKey: 'demo-shop', title: 'modals', provider: 'claude', createdAt: 't', updatedAt: 't', pending: true, turns },
    turn: turns[3], question: turns[2], context: '# Context pack\n[S2] `src/ui/Modal.tsx:10-42` function Modal',
  };
}
const good = {
  answer: 'There is one shared modal [S2]; ConfirmModal wraps it [S3].',
  examples: [
    { path: 'src/ui/ConfirmModal.tsx', lines: '5-30', why: 'wraps Modal', usages: ['src/App.tsx'] },
    { path: 'src/made/up.tsx', lines: null, why: 'invented', usages: [] },
  ],
  prompt: 'Goal: add a ShareModal.\nFiles to read first: src/ui/Modal.tsx',
};

test('the answer is asked prompt-only (an agentic model gets an empty folder) with the pack, the conversation and the question', async () => {
  const seen: JsonTask[] = [];
  const llm: LlmProvider = { id: 'claude-cli', agentic: true, json: async (t) => { seen.push(t); expect((await stat(t.cwd!)).isDirectory()).toBe(true); return good; } };
  await answerTurn(job(), llm);
  const [t] = seen;
  expect(t.cwd).toBeTruthy();
  expect(t.cwd).not.toBe(process.cwd());
  await expect(stat(t.cwd!)).rejects.toThrow();
  expect(t.schema).toBe(CHAT_JSON_SCHEMA);
  expect(t.timeoutMs).toBe(CHAT_TIMEOUT_MS);
  // An answer, examples and a whole agent prompt: a longer budget than a classification.
  expect(t.maxTokens).toBe(6144);
  expect(CHAT_MAX_TOKENS).toBe(6144);
  expect(t.system).toMatch(/codebase guide/i);
  expect(t.system).toMatch(/\[S#\]/);
  expect(t.system).toMatch(/does not cover/);
  expect(t.user).toContain('[S2] `src/ui/Modal.tsx:10-42` function Modal');
  expect(t.user).toContain('where do modals live?');
  expect(t.user).toContain('In src/ui [S1].');
  expect(t.user.trimEnd()).toMatch(/how do I add a new modal\?$/);
});

test('code, not the model, appends the sources and the MCP steps to the prompt, naming the top files from the pack', async () => {
  const llm: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async () => good };
  const a = await answerTurn(job(), llm);
  expect(a.answer).toBe(good.answer);
  expect(a.prompt.startsWith(good.prompt)).toBe(true);
  expect(a.prompt).toContain('[S2] code src/ui/Modal.tsx:10-42: Modal');
  // The examples the model picked come first, but only files the pack holds are named.
  expect(a.prompt).toContain('`get_module_context` on `src/ui/ConfirmModal.tsx`, `src/ui/Modal.tsx`, `src/App.tsx` before editing');
  expect(a.prompt).toContain('`impact` on `src/ui/ConfirmModal.tsx`, `src/ui/Modal.tsx`, `src/App.tsx` before changing shared code');
  expect(a.prompt).toMatch(/`get_task_context` at the start/);
  expect(a.prompt).toMatch(/`check_before_done` before saying done/);
  expect(a.prompt).not.toContain('src/made/up.tsx`');
});

test('the footer still names the MCP steps when the pack has no files', () => {
  const f = mcpFooter([{ id: 'S1', kind: 'lesson', ref: 'lesson:a', title: 'A lesson' }], []);
  expect(f).toContain('`get_module_context` on the files you will edit');
  expect(f).toContain('[S1] lesson lesson:a: A lesson');
  expect(mcpFooter([], [])).not.toContain('## Sources');
});

test('an answer that does not match the schema is asked again once, more strictly, then fails with the end of what came back', async () => {
  const systems: string[] = [];
  const llm: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async (t) => { systems.push(t.system); return { answer: 'no prompt here' }; } };
  await expect(answerTurn(job(), llm)).rejects.toBeInstanceOf(ModelOutputError);
  expect(systems).toHaveLength(2);
  expect(systems[1]).toContain(STRICT_JSON);
  let n = 0;
  const second: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async () => (++n === 1 ? 'prose' : good) };
  expect((await answerTurn(job(), second)).answer).toBe(good.answer);
});

test('an example whose lines are not a line range keeps its file and loses the lines', async () => {
  const odd = { ...good, examples: [{ path: 'src/ui/Modal.tsx', lines: 'export function Modal(', why: 'w', usages: [] }, { path: 'src/ui/Modal.tsx', lines: ' 10-42 ', why: 'w', usages: [] }] };
  const llm: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async () => odd };
  const a = await answerTurn(job(), llm);
  expect(a.examples.map((e) => e.lines)).toEqual([null, '10-42']);
});

test('a local Ollama model gets the pack cut to fit its context window; a CLI model gets all of it', async () => {
  const long = 'x'.repeat(OLLAMA_CHAT_CONTEXT + 5000);
  const seen: JsonTask[] = [];
  const llm = (id: string): LlmProvider => ({ id, agentic: false, json: async (t) => { seen.push(t); return good; } });
  await answerTurn({ ...job(), context: long }, llm('ollama:gemma4'));
  await answerTurn({ ...job(), context: long }, llm('anthropic:claude'));
  expect(seen[0].user).toContain('(the rest of the context pack was cut to fit the local model)');
  expect(seen[0].user.length).toBeLessThan(OLLAMA_CHAT_CONTEXT + 3000);
  expect(seen[1].user).toContain(long);
});
