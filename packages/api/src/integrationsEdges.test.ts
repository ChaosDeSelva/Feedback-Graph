import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFile, Integrations } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { connectionsStatus, type IntegrationsDeps } from './integrations.ts';

const repo = { undoDecision: async () => false, listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;
const OWNER = 'owner-test-token-01234567890123456789';
const LINEAR = 'lin_api_' + 'k'.repeat(20);
const kv = () => { const m = new Map<string, string>(); return { getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) }; };

test('a Linear team listing that fails answers 502 with why, and never echoes the token', async () => {
  const integrations = new Integrations(kv(), {}, credentialFile(join(mkdtempSync(join(tmpdir(), 'fg-int-edge-')), 'integrations.json')));
  const d: IntegrationsDeps = {
    integrations, projects: async () => [], githubOverride: new Map(), syncMinutes: 10,
    viewer: { github: async () => 'octo', linear: async () => 'Pat (Acme)' },
    teams: async (apiKey) => { throw new Error(`401 Unauthorized for key ${apiKey}`); },
  };
  const app = createApp(repo, { auth: { ownerToken: OWNER }, integrations: d });
  const put = await app.request('/api/settings/integrations/linear', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' }, body: JSON.stringify({ token: LINEAR }) });
  expect(put.status).toBe(200);
  const res = await app.request('/api/settings/integrations/linear/teams');
  expect(res.status).toBe(502);
  const { error } = (await res.json()) as { error: string };
  expect(error).toMatch(/^could not list Linear teams: 401 Unauthorized for key /);
  expect(error).not.toContain(LINEAR);
});

test('/api/status connections: a GitHub and Linear state that cannot be read is an error on each, the others still report', async () => {
  const broken = { getCursor: async () => { throw new Error('database unavailable'); }, setCursor: async () => {} };
  const c = await connectionsStatus({ integrations: new Integrations(broken, {}), worker: null, ollama: { url: 'http://ollama:11434', ok: true, reason: null }, cloud: null });
  expect(c.github).toMatchObject({ state: 'error', detail: expect.stringMatching(/^Could not read the GitHub state: .*database unavailable/) });
  expect(c.linear).toMatchObject({ state: 'error', detail: expect.stringMatching(/^Could not read the Linear state: .*database unavailable/) });
  expect(c.ollama.state).toBe('connected');
  expect(c.cloud.state).not.toBe('error');
});
