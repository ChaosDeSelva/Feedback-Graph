import { readdir, stat } from 'node:fs/promises';
import type { JsonTask, LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { askSummary, InvalidSummaryError } from './summarize.ts';

const answer = { goal: 'g', done: [], decisions: [], openThreads: [], outcome: 'o', filesTouched: [] };

test('an agentic summary model (claude-cli, codex-cli) runs in an empty scratch folder, never the worker folder, removed afterwards', async () => {
  const seen: { cwd?: string; files: string[] }[] = [];
  const llm: LlmProvider = {
    id: 'codex-cli', agentic: true,
    json: async (t: JsonTask) => { seen.push({ cwd: t.cwd, files: t.cwd ? await readdir(t.cwd) : [] }); return answer; },
  };
  await askSummary(llm, 'the turns');
  expect(seen).toHaveLength(1);
  const { cwd, files } = seen[0];
  // Without a folder the provider falls back to process.cwd(), and the mirror would copy the worker's own files.
  expect(cwd).toBeTruthy();
  expect(cwd).not.toBe(process.cwd());
  expect(files).toEqual([]);
  await expect(stat(cwd!)).rejects.toThrow();
});

test('the scratch folder is removed when the model fails too', async () => {
  let cwd: string | undefined;
  const llm: LlmProvider = { id: 'claude-cli', agentic: true, json: async (t: JsonTask) => { cwd = t.cwd; throw new Error('boom'); } };
  await expect(askSummary(llm, 'x')).rejects.toThrow('boom');
  expect(cwd).toBeTruthy();
  await expect(stat(cwd!)).rejects.toThrow();
});

test('a local model\'s summary in another shape is read: wrapped in a list, snake_case keys, a list for a sentence, a sentence for a list', async () => {
  const answers: unknown[] = [
    [answer],
    [{ goal: 'g', done: ['a'] }, { done: 'b', open_threads: [{ thread: 'c' }], outcome: 'o' }],
    { goal: ['g', 'h'], done: 'one thing', decisions: [], files_touched: ['src/a.ts'], pushback: null, outcome: 'o' },
  ];
  // Every call answers the same shape, so a refused first answer would be refused again and fail.
  const ask = (raw: unknown) => askSummary({ id: 'ollama:gemma', agentic: false, json: async () => raw }, 'the turns');
  expect(await ask(answers[0])).toEqual({ goal: 'g', done: [], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: 'o' });
  expect(await ask(answers[1])).toEqual({ goal: 'g', done: ['a', 'b'], decisions: [], openThreads: ['c'], filesTouched: [], pushback: [], outcome: 'o' });
  expect(await ask(answers[2])).toEqual({ goal: 'g; h', done: ['one thing'], decisions: [], openThreads: [], filesTouched: ['src/a.ts'], pushback: [], outcome: 'o' });
  // Still refused: no goal at all, or not an object.
  await expect(ask([{ done: ['a'] }])).rejects.toThrow(InvalidSummaryError);
  await expect(ask(['just text'])).rejects.toThrow(InvalidSummaryError);
});
