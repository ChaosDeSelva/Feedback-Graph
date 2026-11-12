import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runHook } from './run.mjs';

// The hooks' requests, answered in-process: the project is tracked, and every MCP call answers `mcp`.
let temp, calls;
function answering(mcp) {
  calls = [];
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (String(url).includes('/api/agent/project')) return new Response(JSON.stringify({ tracked: true, project: 'demo' }));
    return mcp;
  });
}
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), 'fg-run-edges-')); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(temp, { recursive: true, force: true }); });

const run = (event, input, env) => runHook(event, async () => JSON.stringify(input), { env, stateDir: join(temp, 'state') });
const PROMPT = () => ({ prompt: 'Fix the race in src/db/pool.ts please', cwd: temp, session_id: 's1' });

test('with no FEEDBACK_GRAPH_URL the hooks ask the Feedback Graph on localhost:8787', async () => {
  answering(new Response('{}', { status: 500 }));
  await run('prompt', PROMPT(), {});
  expect(calls[0].url).toBe(`http://localhost:8787/api/agent/project?cwd=${encodeURIComponent(temp)}`);
});

test('FG_SANDBOX=1 or true marks every request as a sandbox run; anything else does not', async () => {
  answering(new Response('{}', { status: 500 }));
  for (const v of ['1', 'TRUE']) await run('prompt', PROMPT(), { FEEDBACK_GRAPH_URL: 'http://fg.test', FG_SANDBOX: v });
  await run('prompt', PROMPT(), { FEEDBACK_GRAPH_URL: 'http://fg.test', FG_SANDBOX: 'yes' });
  expect(calls.filter((c) => c.url.includes('/api/agent/project')).map((c) => c.headers['x-fg-sandbox'])).toEqual(['true', 'true', undefined]);
});

test('an MCP call the API refuses adds nothing to the prompt', async () => {
  answering(new Response('nope', { status: 503 }));
  const r = await run('prompt', PROMPT(), { FEEDBACK_GRAPH_URL: 'http://fg.test' });
  expect(r).toEqual({ stdout: '', stderr: '' });
  expect(calls.map((c) => c.url)).toEqual([expect.stringContaining('/api/agent/project'), 'http://fg.test/mcp']);
});

test('a prompt event without a working folder asks nothing', async () => {
  answering(new Response('{}'));
  const r = await run('prompt', { prompt: PROMPT().prompt, session_id: 's1' }, { FEEDBACK_GRAPH_URL: 'http://fg.test' });
  expect(r.stdout).toBe('');
  expect(calls).toEqual([]);
});
