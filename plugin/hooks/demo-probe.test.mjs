import { createApp } from '../../packages/api/src/app.ts';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { prepare, configure, restore } from '../../scripts/demo-probe.mjs';

async function fixture(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'fg-probe-test-'));
  try { await fn(join(parent, 'demo-shop'), parent); }
  finally { await rm(parent, { recursive: true, force: true }); }
}

test('probe preparation is dry by default and creates an independent git fixture only on apply', async () => fixture(async folder => {
  expect((await prepare({ folder })).project).toBe('demo-shop');
  await expect(stat(folder)).rejects.toThrow();
  await prepare({ folder, apply: true });
  expect(execFileSync('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()).toBe(await realpath(folder));
  expect(execFileSync('git', ['-C', folder, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  expect(execFileSync('git', ['-C', folder, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('Initial isolated demo probe');
  expect(await readFile(join(folder, 'CLAUDE.md'), 'utf8')).toContain('src/probes/no-console.ts');
  await writeFile(join(folder, 'src/probes/no-console.ts'), 'edited probe');
  await prepare({ folder, apply: true });
  expect(await readFile(join(folder, 'src/probes/no-console.ts'), 'utf8')).toBe('edited probe');
}));

test('an existing unmarked private project is never overwritten or relabelled', async () => fixture(async folder => {
  await mkdir(folder); await writeFile(join(folder, 'private.txt'), 'keep');
  await expect(prepare({ folder, apply: true })).rejects.toThrow('Refusing to overwrite');
  expect(await readFile(join(folder, 'private.txt'), 'utf8')).toBe('keep');
  await expect(stat(join(folder, '.fg-probe-state.json'))).rejects.toThrow();
}));

test('owner configuration confirms privacy before selection; restore changes only demo membership', async () => fixture(async (folder, parent) => {
  await prepare({ folder, apply: true });
  let tracked = ['real'], projects = ['private'], shares = [];
  const writes = [];
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body); writes.push(path);
      if (path === '/api/cloud/local-only') { projects = body.projects; shares = body.shareDemoProjects; }
      if (path === '/api/settings/projects') tracked = body.tracked;
    }
    return Response.json(path === '/api/settings/projects' ? { tracked, roots: [parent] } : { savedLocalOnlyProjects: projects, localOnlyProjects: projects, shareDemoProjects: shares });
  };
  await configure(folder, { apiURL: 'http://stub.invalid', token: 'private-test-token', fetch: request });
  expect(writes).toEqual(['/api/cloud/local-only', '/api/settings/projects']);
  expect(tracked).toEqual(['real', 'demo-shop']); expect(projects).toEqual(['private', 'demo-shop']);
  tracked.push('new-real'); projects.push('new-private');
  await restore(folder, { token: 'private-test-token', fetch: request });
  expect(tracked).toEqual(['real', 'new-real']); expect(projects).toEqual(['private', 'new-private']);
  expect(await readFile(join(folder, '.fg-probe-state.json'), 'utf8')).not.toContain('private-test-token');
}));

test('partial configuration retries without replacing its original restoration snapshot', async () => fixture(async (folder, parent) => {
  await prepare({ folder, apply: true });
  let failed = false, projects = [], tracked = ['real'];
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if (path === '/api/cloud/local-only') projects = body.projects;
      else if (!failed) { failed = true; return new Response(null, { status: 503 }); }
      else tracked = body.tracked;
    }
    return Response.json(path === '/api/settings/projects' ? { tracked, roots: [parent] } : { savedLocalOnlyProjects: projects, localOnlyProjects: projects, shareDemoProjects: [] });
  };
  await expect(configure(folder, { token: 'test', fetch: request })).rejects.toThrow('503');
  await configure(folder, { token: 'test', fetch: request });
  const state = JSON.parse(await readFile(join(folder, '.fg-probe-state.json'), 'utf8'));
  expect(state.previous.projects).toEqual([]); expect(state.configured).toBe(true);
}));

test('removed tokenless local-owner mode refuses before any owner request', async () => fixture(async folder => {
  await prepare({ folder, apply: true }); let calls = 0;
  const request = async () => { calls++; return Response.json({}); };
  await expect(configure(folder, { apiURL: 'http://127.0.0.1:8787', localOwner: true, fetch: request })).rejects.toThrow('removed');
  await expect(configure(folder, { fetch: request })).rejects.toThrow('requires API_TOKEN');
  expect(calls).toBe(0);
}));

test.each([false])('real HTTP owner configuration works with tokenless=%s', async localOwner => fixture(async (folder, parent) => {
  await prepare({ folder, apply: true });
  let tracked = [], discovered = false;
  const cursors = new Map();
  const app = createApp({ listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] }, {
    auth: localOwner ? {} : { token: 'owner-secret-token-12345678901234567890' },
    settings: { roots: [parent], excluded: [], folders: async () => discovered ? [{ key: 'demo-shop', path: folder }] : [], selection: {
      current: async () => ({ tracked, initialized: true }), candidates: async () => null, aliases: async () => new Map(), keysWithData: async () => [],
      exclusive: async fn => fn(), forgetReads: async () => {}, setTracked: async next => { const before = tracked; tracked = next; return { before, selection: { tracked, initialized: true } }; },
    } },
    cloud: { cloud: null, projects: async () => [], worker: async () => null, portability: {}, activity: { list: async () => [], record: async () => {} }, localOnlyStore: {
      getCursor: async key => cursors.get(key) ?? null, setCursor: async (key, value) => { cursors.set(key, value); },
    } },
  });
  const options = { apiURL: 'http://localhost', localOwner, ...(localOwner ? {} : { token: 'owner-secret-token-12345678901234567890' }), fetch: (url, init) => app.request(url, init) };
  await expect(configure(folder, options)).rejects.toThrow('discovery is pending');
  expect(tracked).toEqual([]); expect(cursors.size).toBe(0);
  discovered = true;
  await configure(folder, options);
  expect(tracked).toEqual(['demo-shop']);
  const cloud = await (await app.request('http://localhost/api/cloud', { headers: localOwner ? {} : { authorization: `Bearer ${options.token}` } })).json();
  expect(cloud.savedLocalOnlyProjects).toContain('demo-shop');
}));
