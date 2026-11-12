import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { configure, prepare, restore } from '../../scripts/demo-probe.mjs';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
afterEach(() => { vi.unstubAllEnvs(); });

async function fixture(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'fg-probe-edges-'));
  try { await fn(join(parent, 'demo-shop'), parent); }
  finally { await rm(parent, { recursive: true, force: true }); }
}

test('a probe folder whose parent is a link into the Feedback Graph checkout is refused before anything is written', async () => fixture(async (_folder, parent) => {
  await symlink(join(checkout, 'scripts', 'lib'), join(parent, 'link'));
  const before = await readdir(join(checkout, 'scripts', 'lib'));
  await expect(prepare({ folder: join(parent, 'link', 'demo-shop'), apply: true })).rejects.toThrow('resolves inside the Feedback Graph checkout');
  expect(await readdir(join(checkout, 'scripts', 'lib'))).toEqual(before);
}));

test('the command line path never guesses an install: no --api-url and no FEEDBACK_GRAPH_URL is refused', async () => fixture(async folder => {
  await prepare({ folder, apply: true });
  vi.stubEnv('FEEDBACK_GRAPH_URL', undefined);
  await expect(configure(folder, { token: 'owner-token' })).rejects.toThrow('needs --api-url');
}));

test('restore refuses the removed local-owner mode before any request', async () => fixture(async (folder, parent) => {
  await prepare({ folder, apply: true });
  const answer = (path) => Response.json(path === '/api/settings/projects' ? { tracked: [], roots: [parent] } : { localOnlyProjects: ['demo-shop'] });
  await configure(folder, { apiURL: 'http://stub.invalid', token: 't', fetch: async (url) => answer(new URL(url).pathname) });
  let calls = 0;
  await expect(restore(folder, { localOwner: true, fetch: async () => { calls++; return Response.json({}); } })).rejects.toThrow('removed');
  expect(calls).toBe(0);
}));

test('an API that leaves out the saved local-only and share lists is read as empty lists, on configure and restore', async () => fixture(async (folder, parent) => {
  await prepare({ folder, apply: true });
  const writes = [];
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'PUT') writes.push([path, JSON.parse(options.body)]);
    return Response.json(path === '/api/settings/projects' ? { tracked: ['real'], roots: [parent] } : { localOnlyProjects: ['demo-shop'] });
  };
  await configure(folder, { apiURL: 'http://stub.invalid', token: 't', fetch: request });
  expect(JSON.parse(await readFile(join(folder, '.fg-probe-state.json'), 'utf8')).previous).toEqual({ tracked: ['real'], projects: [], shareDemoProjects: [] });
  expect(writes[0]).toEqual(['/api/cloud/local-only', { projects: ['demo-shop'], shareDemoProjects: [] }]);
  writes.length = 0;
  await restore(folder, { token: 't', fetch: request });
  expect(writes).toEqual([
    ['/api/settings/projects', { tracked: ['real'] }],
    ['/api/cloud/local-only', { projects: [], shareDemoProjects: [] }],
  ]);
}));
