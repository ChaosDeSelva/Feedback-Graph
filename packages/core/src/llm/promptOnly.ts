/**
 * Requests that need nothing but their prompt (classification, summaries, one-file fact extraction, the
 * check_before_done judge). An agentic provider (claude-cli, codex-cli) works in a folder: given none it would fall
 * back to the process's own (the worker's or the api's), and codex-cli would copy that into its mirror. So every such
 * request goes through askPromptOnly, which hands it a fresh empty folder and removes it afterwards. Jobs that explore
 * a repository (post-mortems, whole-repo scans) pass that repository as `cwd` instead.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonTask, LlmProvider } from './providers.ts';

/** A request with no folder to read: everything the model needs is in the prompt. */
export type PromptOnlyTask = Omit<JsonTask, 'cwd'>;

/** `fn` in a fresh empty folder, removed afterwards (also when `fn` throws). */
export async function inEmptyFolder<T>(fn: (dir: string) => Promise<T>, prefix = 'fb-prompt-'): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Ask `llm` with the prompt alone: an agentic provider runs in a fresh empty folder, never the process's own. */
export function askPromptOnly(llm: LlmProvider, task: PromptOnlyTask): Promise<unknown> {
  if (!llm.agentic) return llm.json(task);
  return inEmptyFolder((cwd) => llm.json({ ...task, cwd }));
}
