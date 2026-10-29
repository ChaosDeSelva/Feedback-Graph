import { expect, test } from 'vitest';
import { EXPORT_FORMAT, Integrations, OPERATOR_VERBS, type CredentialFile, type ExportBundle, type RunOwner, type RunPrincipal } from '@fb/core';
import { createApp, type ApiRepo, type AppOpts } from './app.ts';

const OP = 'o'.repeat(32);
const KEY = 'c2ad856fb97403e18a2e7dc9015b6f438670dcaeb3219a845f0d7c8b6e109234';
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;
class Ledger {
  owners = new Map<string, RunOwner>(); reads = 0;
  private unblock!: () => void;
  private together = new Promise<void>(resolve => { this.unblock = resolve; });
  private readonly race: boolean;
  constructor(race: boolean) { this.race = race; }
  async owner(id: string) {
    const snapshot = this.owners.get(id) ?? null;
    const read = ++this.reads;
    // Both requests finish both owner preflights from the same unclaimed snapshot before either may mutate.
    if (this.race && read >= 3 && read <= 4) { if (read === 4) this.unblock(); await this.together; }
    return snapshot;
  }
  async claim(run: string, principal: RunPrincipal, actor: string | null) {
    let owner = this.owners.get(run);
    if (!owner) { owner = { run, principal, actor, firstSeen: 'now' }; this.owners.set(run, owner); }
    return owner;
  }
}
const json = (body: unknown, key = KEY) => ({ method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${OP}`, 'x-fg-run': 'competing', 'x-fg-run-key': key }, body: JSON.stringify(body) });
const other = KEY.split('').reverse().join('');
function appFor(options: Partial<AppOpts>, race = true) {
  const ledger = new Ledger(race);
  return { ledger, app: createApp(repo, { ...options, runs: ledger as never, auth: { operator: { token: OP, allow: [...OPERATOR_VERBS] } } }) };
}
class Roots {
  writes: string[][] = [];
  async read() { return null; }
  async write(roots: string[]) { this.writes.push(roots); return { roots, updatedAt: 'now' }; }
}
const settings = (roots: Roots): NonNullable<AppOpts['settings']> => ({ roots: [], excluded: [], savedRoots: roots, folders: async () => [], selection: {
  current: async () => ({ tracked: [], initialized: true, updatedAt: 'now' }), candidates: async () => null,
  aliases: async () => new Map(), keysWithData: async () => [], setTracked: async () => { throw new Error('unexpected selection write'); },
  exclusive: async fn => fn(), forgetReads: async () => {},
} });
class Credentials implements CredentialFile {
  data: Awaited<ReturnType<CredentialFile['read']>> = {};
  writes = 0;
  async read() { return this.data; }
  async write(data: typeof this.data) { this.writes++; this.data = data; }
}
class Kv {
  values = new Map<string, string>(); writes = 0;
  async getCursor(key: string) { return this.values.get(key) ?? null; }
  async setCursor(key: string, value: string) { this.writes++; this.values.set(key, value); }
}
function integrations(file: Credentials, kv: Kv) {
  return { integrations: new Integrations(kv, {}, file), projects: async () => [], githubOverride: new Map(), syncMinutes: 10,
    viewer: { github: async () => 'octo', linear: async () => 'team' } };
}

test('competing fresh-run callers authorize before a class-based roots file is changed', async () => {
  const roots = new Roots(); const { app, ledger } = appFor({ settings: settings(roots) });
  const results = await Promise.all([app.request('/api/settings/roots', json({ roots: ['/one'] })), app.request('/api/settings/roots', json({ roots: ['/two'] }, other))]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(roots.writes).toHaveLength(1);
  expect(ledger.owners.size).toBe(1);
});

test('competing credential saves cannot write a losing caller token before claiming ownership', async () => {
  const file = new Credentials(), kv = new Kv(); const { app } = appFor({ integrations: integrations(file, kv) });
  const results = await Promise.all([app.request('/api/settings/integrations/github', json({ token: 'token-one-valid' })), app.request('/api/settings/integrations/github', json({ token: 'token-two-valid' }, other))]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(file.writes).toBe(1);
  expect(kv.writes).toBe(1);
});

test('competing credential removal/check writes authorize before class-based file or KV mutations', async () => {
  for (const action of ['remove', 'check']) {
    const file = new Credentials(), kv = new Kv(); file.data = { github: { token: 'existing-valid-token', savedAt: 'now' } };
    const { app } = appFor({ integrations: integrations(file, kv) });
    const request = (key: string) => ({ ...json({}, key), method: action === 'remove' ? 'DELETE' : 'POST' });
    const path = `/api/settings/integrations/github${action === 'check' ? '/test' : ''}`;
    const results = await Promise.all([app.request(path, request(KEY)), app.request(path, request(other))]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(file.writes).toBe(action === 'remove' ? 1 : 0);
    expect(kv.writes).toBe(1);
  }
});

test('invalid roots and credential bodies do not claim a run or write configuration', async () => {
  const roots = new Roots(), file = new Credentials(), kv = new Kv();
  const { app, ledger } = appFor({ settings: settings(roots), integrations: integrations(file, kv) }, false);
  expect((await app.request('/api/settings/roots', json({ roots: ['/'] }))).status).toBe(400);
  expect((await app.request('/api/settings/integrations/github', json({ token: 'short' }))).status).toBe(400);
  expect(ledger.owners.size).toBe(0);
  expect(roots.writes).toHaveLength(0); expect(file.writes).toBe(0); expect(kv.writes).toBe(0);
});

const bundle: ExportBundle = { format: EXPORT_FORMAT, schemaVersion: 1, toolVersion: 'test', exportedAt: '2026-10-29T00:00:00Z', projectKey: 'shop', projects: [{ key: 'shop', remote: 'github.com/acme/shop' }], lessons: [{ id: 'lesson:shop', projectKey: 'shop', title: 'T', rule: 'R', appliesWhen: '', scope: 'project', paths: [], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' }], misses: [], facts: [], docs: [], codeFiles: [] };
test('manual cloud dispatch rejects a competing caller before any export/upload, and invalid input claims nothing', async () => {
  let exports = 0, uploads = 0;
  const cloud = { cloud: { url: 'https://cloud.example.com', token: 'cloud-token', intervalMinutes: 60, projects: [], suggestions: false, machine: null },
    portability: { exportData: async () => { exports++; return bundle; } }, projects: async () => ['shop'], worker: async () => null,
    activity: { record: async () => {}, list: async () => [] }, fetch: (async (url: string) => {
      if (url.endsWith('/sync-policy')) return new Response(null, { status: 404 });
      uploads++; return Response.json({ syncId: 's', org: 'acme', projects: [], lessons: { team: 0, suggested: 0, skipped: 0 }, misses: 0, facts: { files: 0, unchanged: 0 }, docs: 0 });
    }) as typeof fetch };
  const { app } = appFor({ cloud });
  const results = await Promise.all([app.request('/api/cloud/sync', { ...json({}), method: 'POST' }), app.request('/api/cloud/sync', { ...json({}, other), method: 'POST' })]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(exports).toBe(1); expect(uploads).toBe(1);
  const invalid = appFor({ cloud }, false);
  expect((await invalid.app.request('/api/cloud/sync', { ...json({ unknown: true }), method: 'POST' })).status).toBe(400);
  expect(invalid.ledger.owners.size).toBe(0);
  expect(exports).toBe(1); expect(uploads).toBe(1);
  const sdk = appFor({ cloud }, false);
  const callTool = (force: unknown) => {
    const request = json({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cloud_sync_now', arguments: { force } } });
    return sdk.app.request('/mcp/admin', { ...request, method: 'POST', headers: { ...request.headers, accept: 'application/json, text/event-stream' } });
  };
  const bad = await callTool('invalid');
  expect(bad.status).toBe(200);
  expect((await bad.json()).result.isError).toBe(true);
  expect(sdk.ledger.owners.size).toBe(0);
  expect(exports).toBe(1); expect(uploads).toBe(1);
  const good = await callTool(true);
  expect(good.status).toBe(200);
  expect((await good.json()).result.isError).not.toBe(true);
  expect(sdk.ledger.owners.size).toBe(1);
  expect(exports).toBe(2); expect(uploads).toBe(2);
});
