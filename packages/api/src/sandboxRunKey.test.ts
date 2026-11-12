import { expect, test } from 'vitest';
import type { RunOwner } from '@fb/core';
import { createApp, type ApiRepo } from './app.ts';
import { runKey } from './operator.ts';

// An existing sandbox run, reached with the API token: a malformed run key gets the run-key message (its length, never
// the key), as on a run never opened; a well-formed key that is not the run's own gets the sandbox refusal.
const API = 'a'.repeat(32);
const KEY = 'c2ad856fb97403e18a2e7dc9015b6f438670dcaeb3219a845f0d7c8b6e109234';
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, undoDecision: async () => false, stats: async () => [] } as ApiRepo;
const owner: RunOwner = { run: 'run-1', principal: 'agent', actor: runKey(KEY)!, firstSeen: 't0' };
const app = createApp(repo, { auth: { token: API }, runs: { sandbox: async () => true, owner: async () => owner } as never });
const read = async (key: string) => {
  const res = await app.request('/api/lessons?run=run-1', { headers: { authorization: `Bearer ${API}`, 'x-fg-run-key': key } });
  return { status: res.status, error: ((await res.json()) as { error: string }).error };
};

test('a malformed run key on an existing sandbox run is told what a run key must be', async () => {
  for (const key of ['wrongkey0000', 'x'.repeat(31), 'a'.repeat(36)]) {
    const { status, error } = await read(key);
    expect(status).toBe(403);
    expect(error).toContain(`(${key.length} characters); it must be X-FG-Run-Key`);
    expect(error).not.toContain(key);
  }
});

test("a well-formed run key that is not the run's own still gets the sandbox refusal", async () => {
  const { status, error } = await read(KEY.split('').reverse().join(''));
  expect(status).toBe(403);
  expect(error).toMatch(/^sandbox run access requires/);
});

// install-agent registers `X-FG-Run-Key: ${FG_RUN_KEY:-}` with Claude Code, which may send it as written.
test('an empty or unexpanded run key is no key: the refusal asks for FG_RUN_KEY instead of calling it malformed', async () => {
  for (const key of ['', '${FG_RUN_KEY:-}', '${FG_RUN_KEY}']) {
    const { status, error } = await read(key);
    expect(status).toBe(403);
    expect(error).toMatch(/^sandbox run access requires .*FG_RUN_KEY/);
    const cleanup = await app.request('/api/runs/run-1', { method: 'DELETE', headers: { authorization: `Bearer ${API}`, 'content-type': 'application/json', 'x-fg-run-key': key } });
    expect(cleanup.status).toBe(403);
    expect(((await cleanup.json()) as { error: string }).error).not.toMatch(/run key sent is not one this API accepts/);
  }
});
