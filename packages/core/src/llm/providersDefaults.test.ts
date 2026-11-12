import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { makeProvider, purgeAgentMirrors } from './providers.ts';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const task = { system: 'S', user: 'U', schema };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test.each([
  ['openai:gpt-x', { OPENAI_API_KEY: 'k' }, 'https://api.openai.com/v1/chat/completions', { choices: [{ message: { content: '{"answer":"o"}' } }] }, { answer: 'o' }],
  ['anthropic:claude-x', { ANTHROPIC_API_KEY: 'k' }, 'https://api.anthropic.com/v1/messages', { content: [{ type: 'tool_use', input: { answer: 'a' } }] }, { answer: 'a' }],
  ['jev', { TYPESAFE_API_KEY: 'k' }, 'https://api.typesafe.ai/v1/systemone', { answers: { verdict: { choice: 'yes' } } }, { verdict: 'yes' }],
])('%s calls its API with the global fetch when given none', async (spec, env, url, body, answer) => {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (u: string) => { seen.push(u); return Response.json(body); });
  const t = spec === 'jev' ? { ...task, schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['yes', 'no'] } } } } : task;
  expect(await makeProvider(spec, env).json(t)).toEqual(answer);
  expect(seen).toEqual([url]);
});

/** A folder on PATH holding `name`, a shell script standing in for that CLI. */
function onPath(name: string, script: string) {
  const bin = mkdtempSync(join(tmpdir(), 'fb-bin-'));
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
}

test('claude-cli runs the claude on PATH when given no runner', async () => {
  onPath('claude', `cat >/dev/null; echo '{"structured_output":{"answer":"from claude"}}'`);
  expect(await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }).json(task)).toEqual({ answer: 'from claude' });
});

test('codex-cli in the worker runs the codex on PATH when given no runner', async () => {
  // codex writes its answer to the file after -o
  onPath('codex', `cat >/dev/null; while [ "$1" != "-o" ]; do shift; done; echo '{"answer":"from codex"}' > "$2"`);
  expect(await makeProvider('codex-cli', { ALLOW_UNCONFINED_CODEX: '1' }).json(task)).toEqual({ answer: 'from codex' });
});

test('codex-cli on a runner with no scratch folder set mirrors into /scratch, where the worker mounts the shared volume', async () => {
  const fetchImpl = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  const p = makeProvider('codex-cli', { CODEX_RUNNER_URL: 'http://runner' }, { fetchImpl });
  await expect(p.mirror!(mkdtempSync(join(tmpdir(), 'fb-repo-')))).rejects.toThrow(/'\/scratch\/fb-mirror-/);
});

test('start-up housekeeping without a runner volume (outside Docker) passes', async () => {
  await expect(purgeAgentMirrors({})).resolves.toBeUndefined();
});
