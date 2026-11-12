import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { cli, configure, plan, prepare, restore } from '../../scripts/demo-probe.mjs';

const repo = resolve(import.meta.dirname, '../..');
async function fixture(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'fg-probe-cli-'));
  try { await fn(join(parent, 'demo-shop'), parent); }
  finally { await rm(parent, { recursive: true, force: true }); }
}
const run = async (args, o = {}) => {
  const out = [], err = [];
  const code = await cli(args, { env: {}, log: m => out.push(m), error: m => err.push(m), ...o });
  return { code, out, err };
};
/** The owner API's settings and cloud routes, as configure and restore use them. */
function ownerApi({ roots, candidates, confirm = true, fail } = {}) {
  const db = { tracked: ['real'], saved: ['private'], share: ['demo-shop'] };
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    if (fail === path) return new Response('secret body', { status: 500 });
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if (path === '/api/settings/projects') db.tracked = body.tracked;
      else { db.saved = body.projects; db.share = body.shareDemoProjects; }
    }
    return Response.json(path === '/api/settings/projects'
      ? { tracked: db.tracked, roots, ...(candidates && { candidates }) }
      : { savedLocalOnlyProjects: db.saved, localOnlyProjects: confirm ? db.saved : [], shareDemoProjects: db.share });
  };
  return { db, request };
}

test('the CLI is dry by default: prepare and restore change nothing without --apply', async () => fixture(async folder => {
  const prepared = await run(['prepare', '--folder', folder]);
  expect(prepared).toMatchObject({ code: 0, err: [] });
  expect(prepared.out[0]).toBe(`Dry run: ${folder}. Use this as the agent working directory, never examples/demo-shop.`);
  await expect(stat(folder)).rejects.toThrow();
  expect((await run(['restore', '--folder', folder])).out[0]).toMatch(/^Dry run: restore only/);
  expect((await run(['prepare', '--folder', folder, '--configure'])).err).toEqual(['--configure requires --apply; the default makes no API changes.']);
}));

test('the CLI prepares, configures and restores a probe against the owner API with FG_OWNER_TOKEN', async () => fixture(async (folder, parent) => {
  const api = ownerApi({ roots: [parent], candidates: [{ key: 'demo-shop', exists: true }] });
  const env = { FG_OWNER_TOKEN: 'owner-token' };
  const r = await run(['prepare', '--apply', '--configure', '--folder', folder, '--api-url', 'http://owner.invalid'], { env, fetch: api.request });
  expect(r).toMatchObject({ code: 0, err: [] });
  expect(r.out[0]).toBe(`Prepared: ${folder}. Use this as the agent working directory, never examples/demo-shop.`);
  expect(api.db).toEqual({ tracked: ['real', 'demo-shop'], saved: ['private', 'demo-shop'], share: [] });
  expect(await run(['restore', '--apply', '--folder', folder], { env, fetch: api.request })).toMatchObject({ code: 0, out: [expect.stringMatching(/^Restored demo-shop/)] });
  expect(api.db).toEqual({ tracked: ['real'], saved: ['private'], share: ['demo-shop'] });
  // Restoring twice is a no-op: the snapshot is gone.
  expect((await run(['restore', '--apply', '--folder', folder], { env, fetch: async () => { throw Error('no request expected'); } })).code).toBe(0);
}));

test('an unknown command prints usage and exits 1', async () => {
  expect(await run(['launch'])).toEqual({ code: 1, out: [], err: [expect.stringMatching(/^Usage: node scripts\/demo-probe.mjs prepare\|restore/)] });
});

test('the probe folder must be named demo-shop and lie outside the Feedback Graph checkout', async () => {
  expect(() => plan('/tmp/other-name')).toThrow('folder named demo-shop');
  expect(() => plan(join(repo, 'examples', 'demo-shop'))).toThrow('outside the Feedback Graph repository');
  expect((await run(['prepare', '--folder', '/tmp/not-a-probe'])).code).toBe(1);
});

test('prepare refuses a file in the probe\'s place, and a fixture with a symlink leaves no staging folder', async () => fixture(async (folder, parent) => {
  await writeFile(folder, 'a file');
  await expect(prepare({ folder, apply: true })).rejects.toThrow('non-probe path');
  await rm(folder);
  const source = join(parent, 'fixture');
  await cp(join(repo, 'examples', 'demo-shop'), source, { recursive: true });
  await rm(join(source, 'src/db.ts'));
  await symlink('/etc/hosts', join(source, 'src/db.ts'));
  await expect(prepare({ folder, source, apply: true })).rejects.toThrow('Fixture file must be an ordinary file: src/db.ts');
  expect((await readdir(parent)).sort()).toEqual(['fixture']);
}));

test('configure refuses a folder it did not prepare, one outside the mounted roots, a pending discovery and an unconfirmed privacy setting', async () => fixture(async (folder, parent) => {
  const options = (api) => ({ apiURL: 'http://owner.invalid', token: 't', fetch: api.request });
  await mkdir(folder);
  await writeFile(join(folder, '.fg-probe-state.json'), JSON.stringify({ kind: 'something-else', folder }));
  await expect(configure(folder, options(ownerApi({ roots: [parent] })))).rejects.toThrow('Not a helper-owned probe folder.');
  await rm(folder, { recursive: true });
  await prepare({ folder, apply: true });
  await expect(configure(folder, options(ownerApi({ roots: ['/elsewhere'] })))).rejects.toThrow('outside mounted project roots');
  await expect(configure(folder, options(ownerApi({ roots: [parent], candidates: [{ key: 'demo-shop', exists: true, aliasOf: 'shop' }] })))).rejects.toThrow('Demo discovery is pending');
  const unconfirmed = ownerApi({ roots: [`${parent}/`], confirm: false });
  await expect(configure(folder, options(unconfirmed))).rejects.toThrow('Privacy setting was not confirmed; the probe was not selected.');
  expect(unconfirmed.db.tracked).toEqual(['real']);
  await expect(configure(folder, { token: 't', fetch: ownerApi({ roots: [parent] }).request, apiURL: 'not a url' })).rejects.toThrow();
}));

test('restore refuses a folder it did not prepare and reports a failed request by path and status only', async () => fixture(async (folder, parent) => {
  await prepare({ folder, apply: true });
  const api = ownerApi({ roots: [parent] });
  await configure(folder, { apiURL: 'http://owner.invalid', token: 't', fetch: api.request });
  const failing = ownerApi({ roots: [parent], fail: '/api/cloud' });
  const error = await restore(folder, { token: 't', fetch: failing.request }).catch(e => e);
  expect(error.message).toBe('Probe restore failed at /api/cloud: HTTP 500.');
  await expect(restore(folder, { token: undefined, fetch: api.request })).rejects.toThrow('requires FG_OWNER_TOKEN');
  const state = JSON.parse(await readFile(join(folder, '.fg-probe-state.json'), 'utf8'));
  await writeFile(join(folder, '.fg-probe-state.json'), JSON.stringify({ ...state, folder: '/somewhere/else/demo-shop' }));
  await expect(restore(folder, { token: 't', fetch: api.request })).rejects.toThrow('Not a helper-owned probe folder.');
}));
