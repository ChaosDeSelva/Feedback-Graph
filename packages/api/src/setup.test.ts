import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// scripts/setup.sh, run on a copy of the files it reads (so it never writes this repo's .env), with a throwaway HOME and
// stand-ins for docker, curl (Ollama not answering) and, to play Linux, uname and id.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function sandbox(o: { linuxUid?: number } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fbsetup-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), home, bin, join(home, 'code'), join(home, 'work')]) mkdirSync(d, { recursive: true });
  for (const f of ['scripts/setup.sh', 'scripts/lib/env.sh', '.env.example']) copyFileSync(join(repoRoot, f), join(repo, f));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('docker', 'exit 0');
  stub('curl', 'exit 7');
  if (o.linuxUid !== undefined) {
    stub('uname', 'echo Linux');
    stub('id', `case "$1" in -u) echo ${o.linuxUid} ;; -g) echo ${o.linuxUid + 1} ;; *) /usr/bin/id "$@" ;; esac`);
  }
  const run = (env: Record<string, string> = {}) =>
    execFileSync('bash', [join(repo, 'scripts', 'setup.sh')], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const env = () => readFileSync(join(repo, '.env'), 'utf8');
  const value = (k: string) => env().match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
  return { repo, home, run, env, value, override: join(repo, 'docker-compose.override.yml') };
}

test('PROJECTS_DIRS=~/code on a first run writes it into .env, and one folder needs no override', () => {
  const s = sandbox();
  const out = s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('PROJECTS_DIRS')).toBe(join(s.home, 'code'));
  expect(s.value('PROJECTS_DIR')).toBe(join(s.home, 'code'));
  expect(s.value('NEO4J_PASSWORD')).toMatch(/^[0-9a-f]{36}$/);
  expect(existsSync(s.override)).toBe(false);
  expect(out).toContain('wrote .env');
  // Re-running reads it back from .env (no environment) and changes nothing.
  const before = s.env();
  expect(s.run()).toContain('.env exists; leaving it alone.');
  expect(s.env()).toBe(before);
  expect(existsSync(s.override)).toBe(false);
});

test('several folders: all of them in .env, and the generated override mounts them', () => {
  const s = sandbox();
  s.run({ PROJECTS_DIRS: '~/code, ~/work' });
  expect(s.value('PROJECTS_DIRS')).toBe(`${join(s.home, 'code')},${join(s.home, 'work')}`);
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`'${join(s.home, 'work')}:/roots/2:ro'`);
});

test('creates the transcript folders Docker would create as root, honouring CLAUDE_PROJECTS_DIR', () => {
  const s = sandbox();
  const elsewhere = join(s.home, 'elsewhere', 'claude-projects');
  s.run({ PROJECTS_DIRS: '~/code', CLAUDE_PROJECTS_DIR: elsewhere });
  expect(existsSync(elsewhere)).toBe(true);
  expect(existsSync(join(s.home, '.claude', 'projects'))).toBe(false);
  expect(existsSync(join(s.home, '.codex', 'sessions'))).toBe(true);
  // Only the sessions folder: no config or login, which is what install-agent.sh takes as Codex being installed.
  expect(existsSync(join(s.home, '.codex', 'config.toml'))).toBe(false);
  expect(existsSync(join(s.home, '.codex', 'auth.json'))).toBe(false);
});

test('Linux with a uid other than 1000: a new .env runs the containers as you; an existing one is told how', () => {
  const s = sandbox({ linuxUid: 1234 });
  const out = s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('HOST_UID')).toBe('1234');
  expect(s.value('HOST_GID')).toBe('1235');
  expect(out).toContain('containers run as uid 1234');

  const old = sandbox({ linuxUid: 1234 });
  writeFileSync(join(old.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIR=${join(old.home, 'code')}\n`);
  const said = old.run();
  expect(said).toContain('HOST_UID=1234');
  expect(said).toContain('HOST_GID=1235');
  expect(old.env()).toBe(`NEO4J_PASSWORD=x\nPROJECTS_DIR=${join(old.home, 'code')}\n`); // never rewritten

  // uid 1000, or not Linux: nothing to set.
  const mac = sandbox();
  mac.run({ PROJECTS_DIRS: '~/code' });
  expect(mac.value('HOST_UID')).toBe('');
});
