import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { expect, test, vi } from 'vitest';

// The scripts on a copy, with stand-ins that record every docker (and curl) call: which Compose project each one
// addresses, and whether one reaches another folder's install at all.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function world(files: string[]) {
  const base = mkdtempSync(join(tmpdir(), 'fgguards-'));
  const repo = join(base, 'repo');
  const bin = join(base, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), bin, join(base, 'home')]) mkdirSync(d, { recursive: true });
  for (const f of files) copyFileSync(join(repoRoot, f), join(repo, f));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const log = (name: string) => (existsSync(join(base, name)) ? readFileSync(join(base, name), 'utf8') : '');
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    execResult('bash', [join(repo, script), ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(base, 'home'), ...env } });
  return { base, repo, bin, stub, log, run };
}
const composeCalls = (calls: string) => calls.split('\n').filter((c) => c.startsWith('compose '));

test("doctor, after finding another folder's containers under this name, never runs docker compose or calls that install's api", async () => {
  const w = world(['scripts/doctor.sh', 'scripts/lib/env.sh', 'scripts/lib/ollama.sh', 'scripts/lib/restore-journal.sh', 'scripts/lib/state-fs.sh']);
  writeFileSync(join(w.repo, '.env'), `API_PORT=8787\nAPI_TOKEN=${'a'.repeat(32)}\nFG_OWNER_TOKEN=${'b'.repeat(32)}\nCODEX_RUNNER_URL=http://codex-runner:8790\n`);
  w.stub('docker', `echo "$*" >> '${join(w.base, 'docker')}'
case "$*" in info*) exit 0 ;; "ps -a "*) echo /srv/live/feedback-graph ;; *" ps "*) printf 'neo4j\\nworker\\napi\\ncodex-runner\\n' ;; esac
exit 0`);
  w.stub('curl', `echo "$*" >> '${join(w.base, 'curl')}'\nexit 7`);
  w.stub('nc', 'exit 1');
  w.stub('uname', 'echo Darwin');
  const r = await w.run('scripts/doctor.sh', [], { PATH: `${w.bin}:/usr/bin:/bin:${dirname(process.execPath)}` });
  expect(r.stdout).toContain('FAIL  install: the containers named feedback-graph were started from /srv/live/feedback-graph');
  expect(r.stdout.match(/^SKIP {2}containers, api and agent endpoint: not checked/gm)).toHaveLength(1);
  expect(composeCalls(w.log('docker'))).toEqual([]);
  expect(w.log('curl')).not.toMatch(/localhost:8787/);
});

test('fg addresses the Compose project and env file it read, even when FEEDBACK_GRAPH_ENV names another file', async () => {
  const w = world(['scripts/fg', 'scripts/lib/env.sh', 'scripts/lib/state-fs.sh']);
  const alt = join(w.base, 'alt.env');
  writeFileSync(alt, 'FG_INSTANCE=fg-alt\nAPI_PORT=8797\n');
  // No Node here, so fg runs the CLI in the api container.
  w.stub('node', 'exit 1');
  w.stub('docker', `echo "$*" >> '${join(w.base, 'docker')}'\nexit 0`);
  await w.run('scripts/fg', ['status'], { FEEDBACK_GRAPH_ENV: alt });
  const calls = composeCalls(w.log('docker'));
  expect(calls.some((c) => / exec -T .* api node src\/cli\.ts status$/.test(c))).toBe(true);
  for (const c of calls) expect(c).toContain(`-p fg-alt --env-file ${alt}`);
});

test('fg --help prints whatever FEEDBACK_GRAPH_URL points at, since it sends nothing', async () => {
  const w = world([]);
  const env = join(w.base, 'install.env');
  writeFileSync(env, `API_PORT=8797\nAPI_TOKEN=${'a'.repeat(32)}\n`);
  w.stub('docker', 'exit 0');
  const r = await execResult('bash', [join(repoRoot, 'scripts', 'fg'), '--help'], {
    env: { PATH: `${w.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(w.base, 'home'), FEEDBACK_GRAPH_ENV: env, FEEDBACK_GRAPH_URL: 'http://localhost:9999' },
  });
  expect(r.stderr).not.toContain('refusing to send');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('fg status');
});

test('backup names this checkout\'s Compose project in every docker compose call', async () => {
  const w = world(['scripts/backup.sh', 'scripts/lib/store.sh', 'scripts/lib/env.sh', 'scripts/lib/json.sh', 'scripts/lib/restore-journal.sh', 'scripts/lib/state-fs.sh']);
  writeFileSync(join(w.repo, '.env'), 'FG_INSTANCE=fg-mine\nSTORE=postgres\nDATABASE_URL=postgres://fg@db.example/fg\n');
  mkdirSync(join(w.repo, 'state'));
  w.stub('docker', `echo "$*" >> '${join(w.base, 'docker')}'
case "$*" in *" config --format json") echo '{"name":"fg-mine"}' ;; "network inspect"*) exit 1 ;; run*) echo dump ;; esac
exit 0`);
  const r = await w.run('scripts/backup.sh', [], { PATH: `${w.bin}:/usr/bin:/bin:${dirname(process.execPath)}` });
  expect(r.stdout).toContain('backup written');
  const calls = composeCalls(w.log('docker'));
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) expect(c).toMatch(/^compose -p fg-mine /);
});

test("a named install keeps its own Codex guidance up to date, and the default install leaves it alone", async () => {
  const w = world([]);
  const home = join(w.base, 'home');
  w.stub('codex', 'exit 0');
  const agentsMd = join(home, '.codex', 'AGENTS.md');
  // This checkout's env file names the install (FG_INSTANCE) the environment gives each run.
  const install = (env: Record<string, string>) => {
    writeFileSync(join(w.base, 'install.env'), env.FG_INSTANCE ? `FG_INSTANCE=${env.FG_INSTANCE}\n` : '');
    return execResult('bash', [join(repoRoot, 'scripts', 'install-agent.sh'), 'codex'], {
      env: { PATH: `${w.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FEEDBACK_GRAPH_ENV: join(w.base, 'install.env'), ...env },
    });
  };
  const named = { FG_INSTANCE: 'feedback-graph-repo', API_PORT: '8797' };
  expect((await install(named)).stdout).toContain('Codex: added the Feedback Graph guidance');
  const written = readFileSync(agentsMd, 'utf8');
  // A release changes the guidance: the install that wrote the block updates it.
  writeFileSync(agentsMd, written.replace(/(<!-- BEGIN feedback-graph[^\n]*\n)[\s\S]*(<!-- END feedback-graph -->)/, '$1older guidance\n$2'));
  expect((await install(named)).stdout).toContain('Codex: updated the Feedback Graph guidance');
  expect(readFileSync(agentsMd, 'utf8')).toBe(written);
  const other = await install({});
  expect(other.stdout).toContain('belongs to the install registered as feedback-graph-repo; left as it is');
  expect(readFileSync(agentsMd, 'utf8')).toBe(written);
});
