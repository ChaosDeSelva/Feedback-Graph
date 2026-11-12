import { EXPORT_FORMAT, storedSyncMemory, type Activity, type CloudConfig, type ExportBundle } from '@fb/core';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { CloudDeps } from './cloud.ts';

const TOKEN = `fgc_pat_0123456789abcdef_${'Q'.repeat(43)}`;
const OWNER = 'owner-test-token-01234567890123456789';
const auth = { ownerToken: OWNER };
const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true', 'content-type': 'application/json' };
const cloud: CloudConfig = { url: 'https://cloud.example.com', token: TOKEN, intervalMinutes: 60, projects: [], suggestions: false, claims: false, people: false, machine: null };
const repo = { undoDecision: async () => false, listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;
const bundle = (key: string): ExportBundle => ({
  format: EXPORT_FORMAT, schemaVersion: 1, toolVersion: '0.2.0', exportedAt: 't', projectKey: key, projects: [{ key, remote: `github.com/acme/${key}` }],
  lessons: [{ id: `lesson:${key}`, projectKey: key, title: 'T', rule: 'R', appliesWhen: '', scope: 'project', paths: [], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' }],
  misses: [], facts: [], docs: [], codeFiles: [],
});
const team = { adminApprovalRequired: true, approved: 1, suggested: 2, blocked: false, message: `an admin approves lessons; token ${'ghp_' + 'A'.repeat(36)}` };
const syncOk = { syncId: 's1', org: 'acme', projects: [{ localKey: 'shop', key: 'github.com/acme/shop', remote: 'github.com/acme/shop', namespace: 'team' }], lessons: { team: 1, suggested: 0, skipped: 0 }, misses: 0, facts: { files: 0, unchanged: 0 }, docs: 0 };

afterEach(() => { vi.unstubAllGlobals(); });

function deps(o: Partial<CloudDeps> = {}): CloudDeps & { policyReads: () => number } {
  let policyReads = 0;
  return {
    cloud,
    portability: { exportData: async (q) => bundle(q?.projectKey ?? '') },
    activity: { record: async () => {}, list: async () => [] },
    projects: async () => ['shop'],
    worker: async () => null,
    fetch: (async (url: string) => {
      if (url.endsWith('/sync-policy')) { policyReads++; return Response.json({ teamLessons: team }); }
      return Response.json({ ...syncOk, teamLessons: team });
    }) as unknown as typeof fetch,
    policyReads: () => policyReads,
    ...o,
  };
}

test('the card for one project carries the team policy, redacted, and reads it at most once a minute', async () => {
  const d = deps();
  const app = createApp(repo, { auth, cloud: d });
  const info = await (await app.request('/api/cloud?project=shop')).json();
  expect(info.teamLessons).toMatchObject({ adminApprovalRequired: true, message: expect.stringContaining('[REDACTED]') });
  expect(JSON.stringify(info)).not.toContain('ghp_');
  expect(info.policyError).toBeUndefined();
  await app.request('/api/cloud?project=shop');
  expect(d.policyReads()).toBe(1);
});

test('a policy the cloud refuses, or one of the wrong shape, leaves the card saying the policy is unavailable', async () => {
  for (const policy of [new Response(null, { status: 500 }), Response.json({ teamLessons: { message: 'x' } }), Response.json({})]) {
    const app = createApp(repo, { auth, cloud: deps({ fetch: (async () => policy.clone()) as unknown as typeof fetch }) });
    const info = await (await app.request('/api/cloud?project=shop')).json();
    expect(info.teamLessons).toBeUndefined();
    expect(info.policyError).toMatch(/Team approval policy is unavailable/);
  }
});

test('the policy is never asked of a CLOUD_URL that would expose the token', async () => {
  const d = deps({ cloud: { ...cloud, url: 'http://cloud.example.com' } });
  const info = await (await createApp(repo, { auth, cloud: d }).request('/api/cloud?project=shop')).json();
  expect(d.policyReads()).toBe(0);
  expect(info.policyError).toMatch(/unavailable/);
});

test('without an injected fetch the policy is read with the global fetch', async () => {
  const global = vi.fn(async () => Response.json({ teamLessons: team }));
  vi.stubGlobal('fetch', global);
  const info = await (await createApp(repo, { auth, cloud: { ...deps(), fetch: undefined } }).request('/api/cloud?project=shop')).json();
  expect(global).toHaveBeenCalledWith('https://cloud.example.com/api/v1/sync-policy', expect.objectContaining({ headers: { authorization: `Bearer ${TOKEN}` }, redirect: 'error' }));
  expect(info.teamLessons).toMatchObject({ approved: 1 });
});

test('a project key that cannot be one is refused, and a local-only project is explained as local-only', async () => {
  const app = createApp(repo, { auth, cloud: deps({ cloud: { ...cloud, localOnlyProjects: ['secret'] } }) });
  expect((await app.request('/api/cloud?project=..%2Fx')).status).toBe(400);
  const info = await (await app.request('/api/cloud?project=secret')).json();
  expect(info.preview.projects).toContainEqual({ key: 'secret', counts: null, reason: 'Project is local-only; it will not be sent.' });
});

test('Sync now and the card after it carry the team policy each project reported, once per message', async () => {
  const values = new Map<string, string>();
  const docs = { getCursor: async (k: string) => values.get(k) ?? null, setCursor: async (k: string, v: string) => { values.set(k, v); },
    deleteCursor: async (k: string) => { values.delete(k); }, cursorsWithPrefix: async (p: string) => [...values].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })) };
  // No team policy endpoint here: each sync answer carries its own, and shop3's carries none.
  const fetch = (async (url: string, init: RequestInit) => (url.endsWith('/sync-policy') ? new Response(null, { status: 404 })
    : Response.json({ ...syncOk, ...(!String(init.body).includes('shop3') && { teamLessons: team }) }))) as unknown as typeof globalThis.fetch;
  const app = createApp(repo, { auth, cloud: deps({ memory: storedSyncMemory(docs, cloud), projects: async () => ['shop', 'shop2', 'shop3'], fetch }) });
  const sync = await app.request('/api/cloud/sync', { method: 'POST', headers: owner, body: '{}' });
  expect(sync.status).toBe(200);
  const progress = await (await app.request('/api/cloud/progress')).json();
  expect(progress.lastManual.teamLessons).toHaveLength(1);
  const info = await (await app.request('/api/cloud')).json();
  expect(info.last.teamLessons).toEqual([expect.objectContaining({ adminApprovalRequired: true })]);
});

test('a last sync known only from an Activity entry with missing details reads as a scheduled sync with nothing sent', async () => {
  const entry = { id: 'a1', ts: 't', kind: 'cloud_synced', actor: 'worker', projectKey: null, subject: 's', why: 'w', details: {}, targets: [] } as unknown as Activity;
  const info = await (await createApp(repo, { auth, cloud: deps({ activity: { record: async () => {}, list: async () => [entry] } }) }).request('/api/cloud')).json();
  expect(info.last).toEqual({ at: 't', ok: false, trigger: 'schedule', error: null, sent: null, projects: [], failed: [] });
});

test('local-only settings: unavailable without a place to keep them, and a malformed list is refused', async () => {
  const put = (body: unknown) => ({ method: 'PUT', headers: owner, body: JSON.stringify(body) });
  const without = createApp(repo, { auth, cloud: deps() });
  expect((await without.request('/api/cloud/local-only', put({ projects: [] }))).status).toBe(503);
  const store = { getCursor: async () => null, setCursor: async () => {} };
  const app = createApp(repo, { auth, cloud: deps({ localOnlyStore: store }) });
  expect((await app.request('/api/cloud/local-only', put({ projects: [''] }))).status).toBe(400);
  expect((await app.request('/api/cloud/local-only', put({ projects: [], extra: 1 }))).status).toBe(400);
});
