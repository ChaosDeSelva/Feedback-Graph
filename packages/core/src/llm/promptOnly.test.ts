import { readdir, stat } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { askPromptOnly } from './promptOnly.ts';
import type { JsonTask, LlmProvider } from './providers.ts';

const task = { system: 'S', user: 'U', schema: { type: 'object' } };

/** An agentic fake that records the folder it was handed and what was in it. */
function agentic(fail = false) {
  const seen: { cwd?: string; files: string[] }[] = [];
  const llm: LlmProvider = {
    id: 'claude-cli', agentic: true,
    json: async (t: JsonTask) => {
      seen.push({ cwd: t.cwd, files: t.cwd ? await readdir(t.cwd) : [] });
      if (fail) throw new Error('boom');
      return { ok: true };
    },
  };
  return { llm, seen };
}

test('a prompt-only request to an agentic provider runs in a fresh empty folder, never the process folder, removed afterwards', async () => {
  const { llm, seen } = agentic();
  expect(await askPromptOnly(llm, task)).toEqual({ ok: true });
  expect(await askPromptOnly(llm, task)).toEqual({ ok: true });
  expect(seen).toHaveLength(2);
  for (const { cwd, files } of seen) {
    expect(cwd).toBeTruthy();
    expect(cwd).not.toBe(process.cwd());
    expect(files).toEqual([]);
    await expect(stat(cwd!)).rejects.toThrow();
  }
  expect(seen[0].cwd).not.toBe(seen[1].cwd);
});

test('the folder is removed when the provider fails too', async () => {
  const { llm, seen } = agentic(true);
  await expect(askPromptOnly(llm, task)).rejects.toThrow('boom');
  expect(seen[0].cwd).toBeTruthy();
  await expect(stat(seen[0].cwd!)).rejects.toThrow();
});

test('a provider that reads no files gets no folder', async () => {
  let got: JsonTask | null = null;
  const llm: LlmProvider = { id: 'ollama:x', agentic: false, json: async (t) => { got = t; return 1; } };
  await askPromptOnly(llm, task);
  expect(got).toEqual(task);
});
