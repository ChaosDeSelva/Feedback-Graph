import { readdir, stat } from 'node:fs/promises';
import type { JsonTask, LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { askSummary } from './summarize.ts';

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
