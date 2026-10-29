#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, writeFile, lstat, rename, rm, realpath } from 'node:fs/promises';
import { dirname, resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['CLAUDE.md', 'package.json', 'src/db.ts', 'src/http.ts', 'src/server.ts', 'src/routes/customers.ts', 'src/probes/no-console.ts', 'test/customers.test.ts'];
const MARKER = '.fg-probe-state.json';
const readState = async folder => JSON.parse(await readFile(join(folder, MARKER), 'utf8'));
export const defaultFolder = () => join(homedir(), 'Code', 'demo-shop');
export function plan(folder = defaultFolder()) {
  const absolute = resolve(folder);
  if (basename(absolute) !== 'demo-shop') throw Error('Use a dedicated folder named demo-shop outside the Feedback Graph checkout.');
  if (absolute === repo || absolute.startsWith(`${repo}/`)) throw Error('The probe must be outside the Feedback Graph repository so it cannot resolve as the real feedback-graph project.');
  return { folder: absolute, project: 'demo-shop', source: join(repo, 'examples', 'demo-shop'), localOnly: true };
}

/** Copies only known fixture files. CLAUDE.md is fixture content, never instructions executed by this helper. */
export async function prepare({ folder = defaultFolder(), source = join(repo, 'examples', 'demo-shop'), apply = false } = {}) {
  const result = plan(folder);
  if (!apply) return result;
  const existing = await lstat(result.folder).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error('Refusing to modify an existing non-probe path.');
    const state = await readState(result.folder).catch(() => null);
    if (state?.kind !== 'feedback-graph-demo-probe' || state.folder !== result.folder) throw Error('Refusing to overwrite an existing project. Choose a fresh dedicated demo-shop folder.');
    return result;
  }
  await mkdir(dirname(result.folder), { recursive: true });
  const parent = await realpath(dirname(result.folder));
  const root = await realpath(repo);
  if (parent === root || parent.startsWith(`${root}/`)) throw Error('The probe parent resolves inside the Feedback Graph checkout. Choose an independent folder.');
  const stage = await mkdtemp(join(dirname(result.folder), '.fg-demo-stage-'));
  try {
    for (const name of FILES) {
      const input = join(resolve(source), name);
      const stat = await lstat(input);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Fixture file must be an ordinary file: ${name}`);
      await mkdir(dirname(join(stage, name)), { recursive: true });
      await writeFile(join(stage, name), await readFile(input));
    }
    await writeFile(join(stage, MARKER), JSON.stringify({ kind: 'feedback-graph-demo-probe', folder: result.folder }, null, 2), { mode: 0o600 });
    // A standalone git root prevents host agents from resolving this fixture as its enclosing project.
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    await execute('git', ['init', '--quiet', stage], { env: gitEnv });
    await writeFile(join(stage, '.gitignore'), `${MARKER}\nnode_modules/\n`);
    await execute('git', ['-C', stage, '-c', 'core.hooksPath=/dev/null', 'add', '--', ...FILES, '.gitignore'], { env: gitEnv });
    await execute('git', ['-C', stage, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Feedback Graph probe', '-c', 'user.email=probe@example.invalid', 'commit', '--quiet', '--no-verify', '-m', 'Initial isolated demo probe'], { env: gitEnv });
    await rename(stage, result.folder);
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  return result;
}

/** Explicit local-owner mode uses same-origin owner authorization; it never bypasses a configured token. */
function ownerHeaders(base, { token, localOwner = false }) {
  const url = new URL(base);
  if (localOwner) {
    if (token) throw Error('--local-owner is tokenless only; omit the flag when API_TOKEN is available.');
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw Error('--local-owner is permitted only for an explicit loopback HTTP(S) API URL.');
    }
    return { origin: url.origin, 'x-fg-owner': 'true' };
  }
  if (!token) throw Error('Owner preparation requires API_TOKEN or explicit --local-owner for a tokenless loopback install. Do not broaden OPERATOR_ALLOW for this probe.');
  return { authorization: `Bearer ${token}`, origin: url.origin };
}

export async function configure(folder, { apiURL, token, localOwner = false, fetch: request = fetch } = {}) {
  const base = apiURL ?? 'http://127.0.0.1:8787';
  const headers = ownerHeaders(base, { token, localOwner });
  const state = await readState(folder);
  if (state.kind !== 'feedback-graph-demo-probe' || state.folder !== resolve(folder)) throw Error('Not a helper-owned probe folder.');
  const call = async (path, body) => {
    const response = await request(`${base}${path}`, { method: body ? 'PUT' : 'GET', redirect: 'error', headers: { ...headers, ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
    if (!response.ok) throw Error(`Probe preparation failed at ${path}: HTTP ${response.status}. No response body or credential is printed.`);
    return response.json();
  };
  const settings = await call('/api/settings/projects');
  if (!settings.roots?.some(root => folder.startsWith(`${root.replace(/\/+$/, '')}/`))) throw Error('The dedicated folder is outside mounted project roots. Add its parent in owner Settings and run setup to apply mounts first.');
  if (Array.isArray(settings.candidates)) {
    const candidate = settings.candidates.find(item => item.key === 'demo-shop');
    if (!candidate?.exists || candidate.excluded || candidate.aliasOf) throw Error('Demo discovery is pending or the folder is not selectable. Wait for the worker discovery pass, check demo-shop in Settings, then rerun this same --configure command. No configuration was changed.');
  }
  const cloud = await call('/api/cloud');
  state.apiURL = base;
  state.previous ??= { tracked: settings.tracked, projects: cloud.savedLocalOnlyProjects ?? [], shareDemoProjects: cloud.shareDemoProjects ?? [] };
  await writeFile(join(folder, MARKER), JSON.stringify(state, null, 2), { mode: 0o600 });
  await call('/api/cloud/local-only', { projects: [...new Set([...(cloud.savedLocalOnlyProjects ?? []), 'demo-shop'])], shareDemoProjects: (cloud.shareDemoProjects ?? []).filter(key => key !== 'demo-shop') });
  const protectedState = await call('/api/cloud');
  if (!protectedState.localOnlyProjects?.includes('demo-shop')) throw Error('Privacy setting was not confirmed; the probe was not selected.');
  await call('/api/settings/projects', { tracked: [...new Set([...settings.tracked, 'demo-shop'])] });
  state.configured = true;
  await writeFile(join(folder, MARKER), JSON.stringify(state, null, 2), { mode: 0o600 });
  return state;
}

export async function restore(folder, { token, localOwner = false, fetch: request = fetch } = {}) {
  const state = await readState(folder);
  if (state.kind !== 'feedback-graph-demo-probe' || state.folder !== resolve(folder)) throw Error('Not a helper-owned probe folder.');
  if (!state.previous) return;
  const headers = ownerHeaders(state.apiURL, { token, localOwner });
  const call = async (path, body) => {
    const response = await request(`${state.apiURL}${path}`, { method: body ? 'PUT' : 'GET', redirect: 'error', headers: { ...headers, ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
    if (!response.ok) throw Error(`Probe restore failed at ${path}: HTTP ${response.status}.`);
    return response.json();
  };
  // Preserve unrelated changes made while probing; restore only demo-shop membership in these lists.
  const settings = await call('/api/settings/projects'), cloud = await call('/api/cloud');
  const membership = (current, previous) => [...new Set([...current.filter(key => key !== 'demo-shop'), ...(previous.includes('demo-shop') ? ['demo-shop'] : [])])];
  await call('/api/settings/projects', { tracked: membership(settings.tracked, state.previous.tracked) });
  await call('/api/cloud/local-only', { projects: membership(cloud.savedLocalOnlyProjects ?? [], state.previous.projects), shareDemoProjects: membership(cloud.shareDemoProjects ?? [], state.previous.shareDemoProjects) });
  delete state.previous; delete state.configured;
  await writeFile(join(folder, MARKER), JSON.stringify(state, null, 2), { mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'prepare', ...args] = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  try {
    const folder = resolve(value('--folder') ?? defaultFolder());
    if (command === 'restore') {
      if (!args.includes('--apply')) console.log('Dry run: restore only the demo-shop selection/privacy membership saved by prepare; leave files and unrelated settings intact.');
      else { await restore(folder, { token: process.env.API_TOKEN, localOwner: args.includes('--local-owner') }); console.log('Restored demo-shop settings membership. Run fg cleanup for your labelled run; fixture files were retained.'); }
    } else if (command === 'prepare') {
      const result = await prepare({ folder, source: value('--source'), apply: args.includes('--apply') });
      if (args.includes('--configure')) {
        if (!args.includes('--apply')) throw Error('--configure requires --apply; the default makes no API changes.');
        await configure(result.folder, { apiURL: value('--api-url'), token: process.env.API_TOKEN, localOwner: args.includes('--local-owner') });
      }
      console.log(`${args.includes('--apply') ? 'Prepared' : 'Dry run'}: ${result.folder}. Use this as the agent working directory, never examples/demo-shop.`);
      console.log('Register a fresh FG_RUN/FG_SANDBOX=1 session, seed only the demo corpus, test the returned console probe, then fg cleanup --run YOUR_RUN --apply. This command does not launch agents or change lesson decisions.');
    } else throw Error('Usage: node scripts/demo-probe.mjs prepare|restore [--apply] [--configure] [--folder PATH] [--source FIXTURE] [--api-url URL] [--local-owner]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
