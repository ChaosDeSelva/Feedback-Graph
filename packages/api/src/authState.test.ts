import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { apiAuthConfigured, apiAuthStateFile, AUTH_STATE_FILE_NAME, AUTH_STATE_STALE_MS, loadConfig, readAuthState, writeAuthState } from '@fb/core';
import { afterAll, expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { authStateBeat } from './service.ts';
import { fakeLoop } from './testing/loop.ts';

const base = { NEO4J_PASSWORD: 'pw', PROJECT_ROOTS: '/vibe', HOST_PROJECT_ROOTS: '/Users/a/Vibe' };
const repo = {} as ApiRepo;
const dir = mkdtempSync(join(tmpdir(), 'fg-auth-state-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = 'a'.repeat(24);
const cases: Record<string, Record<string, string>> = {
  none: {},
  'API_TOKEN of spaces': { API_TOKEN: '   ' },
  'FG_OWNER_TOKEN of a tab': { FG_OWNER_TOKEN: '\t' },
  'both blank': { API_TOKEN: ' ', FG_OWNER_TOKEN: '  ' },
  'API_TOKEN padded': { API_TOKEN: `  ${TOKEN}  ` },
  'FG_OWNER_TOKEN': { FG_OWNER_TOKEN: 'o'.repeat(24) },
};

test.each(Object.entries(cases))('the worker caps the loop exactly when the API is tokenless: %s', async (name, env) => {
  // The API as service.ts builds it: its auth from the config's (trimmed) tokens, and the answer it writes at start.
  const api = loadConfig({ ...base, ...env });
  const app = createApp(repo, { loop: fakeLoop().deps, auth: { token: api.apiToken ?? undefined, ownerToken: api.ownerToken ?? undefined } });
  const state = await (await app.request('/api/loop', { headers: api.apiToken ? { authorization: `Bearer ${api.apiToken}` } : {} })).json();
  const apiTokenless = state.capped === 'tokenless';
  const file = join(dir, `${name.replace(/\W/g, '_')}-${AUTH_STATE_FILE_NAME}`);
  await writeAuthState(file, apiAuthConfigured(api));

  // The worker gets no token, only where to read the API's answer (compose's AUTH_STATE_FILE).
  const worker = loadConfig({ ...base, AUTH_STATE_FILE: file });
  const workerTokenless = !(worker.authConfigured || await readAuthState(worker.authStateFile!));
  expect(workerTokenless).toBe(apiTokenless);
  expect(apiTokenless).toBe(!Object.values(env).some((v) => v.trim()));
});

test('before the API has written it the worker reads no token; a rewrite replaces the answer whole', async () => {
  const file = join(dir, 'later.json');
  expect(await readAuthState(file)).toBe(false);
  await writeAuthState(file, true);
  expect(await readAuthState(file)).toBe(true);
  await writeAuthState(file, false);
  expect(await readAuthState(file)).toBe(false);
  writeFileSync(file, '{"configured":"yes"}');
  expect(await readAuthState(file)).toBe(false);
});

// Sweep 6, N2: a tokened install's answer outlived it. The tokens were blanked and the API failed at start, so the file
// still said configured while the worker auto-applied decisions nobody could pause or roll back.
test('an API start that fails leaves the file saying no token, whatever an earlier start wrote', async () => {
  const settings = join(dir, 'failed-start', 'api-settings');
  mkdirSync(settings, { recursive: true });
  const file = join(settings, AUTH_STATE_FILE_NAME);
  await writeAuthState(file, true);
  expect(await readAuthState(file)).toBe(true);
  // API_BIND beyond loopback without a token: loadConfig refuses, before the store or anything else is opened.
  const env = { PATH: process.env.PATH, ...base, API_BIND: '0.0.0.0', ROOTS_FILE: join(settings, 'project-roots.json') };
  expect(apiAuthStateFile(env)).toBe(file);
  const main = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
  await expect(promisify(execFile)(process.execPath, [main], { env, timeout: 30_000 })).rejects.toMatchObject({ code: 1 });
  expect(await readAuthState(file)).toBe(false);
});

test('the worker reads no token once the API stops renewing its answer, or when it is from before the renewals', async () => {
  const file = join(dir, 'beat.json');
  const now = Date.parse('2026-11-11T12:00:00Z');
  await writeAuthState(file, true, now);
  expect(await readAuthState(file, now + AUTH_STATE_STALE_MS - 1)).toBe(true);
  expect(await readAuthState(file, now + AUTH_STATE_STALE_MS)).toBe(false);
  writeFileSync(file, '{"configured":true}');
  expect(await readAuthState(file)).toBe(false);
});

test('a listening API vouches for its token only while its store answers', async () => {
  const file = join(dir, 'store.json');
  const logged: string[] = [];
  const beat = (configured: boolean, ping: () => Promise<boolean>) => authStateBeat({ file, configured, ping, log: (msg) => logged.push(msg) })();
  await beat(true, async () => true);
  expect(await readAuthState(file)).toBe(true);
  await beat(true, async () => false);
  expect(await readAuthState(file)).toBe(false);
  await beat(true, async () => { throw new Error('store down'); });
  expect(await readAuthState(file)).toBe(false);
  await beat(false, async () => true);
  expect(await readAuthState(file)).toBe(false);
  expect(logged).toEqual([]);
});
