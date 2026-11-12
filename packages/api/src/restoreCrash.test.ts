import { execFile, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { afterEach, expect, test } from 'vitest';
import { unfinishedRestore } from '../../worker/src/state.ts';

// scripts/restore.sh on a copy, restoring a Neo4j backup with a stand-in docker, killed (kill -9 of its process group,
// as a closed terminal or an OOM kill would) or interrupted at chosen points. What it leaves must be found by the next
// restore, backup and doctor run, and the worker must not start on a store and a state/ from different backups.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const repo = mkdtempSync(join(tmpdir(), 'fg-restore-crash-'));
  dirs.push(repo);
  const bin = join(repo, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), bin, join(repo, 'state')]) mkdirSync(d, { recursive: true });
  for (const f of ['restore.sh', 'backup.sh', 'doctor.sh', 'lib/store.sh', 'lib/env.sh', 'lib/json.sh', 'lib/ollama.sh', 'lib/restore-journal.sh', 'lib/state-fs.sh']) copyFileSync(join(repoRoot, 'scripts', f), join(repo, 'scripts', f));
  writeFileSync(join(repo, '.env'), 'FG_INSTANCE=t\nSTORE=neo4j\nNEO4J_PASSWORD=pw\n');
  const calls = join(repo, 'calls');
  // docker: answers compose config and ps (api, worker and neo4j run until a compose stop), and at the step named by
  // $AT (load or swap) kills the restore's process group ($HOW=kill) or sends the restore a Ctrl-C ($HOW=int).
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
echo "docker $*" >> '${calls}'
# Its process group is the restore's, led by the restore itself (killed first: on macOS a process that signals its own
# group may die before the rest of it is signalled).
act() { g="$(ps -o pgid= -p $$ | tr -d ' ')"; case "$HOW" in kill) kill -9 "$g"; kill -9 -- -"$g" ;; int) kill -INT "$g" ;; esac; }
case "$*" in
  info) exit 1 ;;
  "compose -p t config --format json") echo '{"name":"t","services":{"neo4j":{"image":"neo4j:x"}},"volumes":{"neo4j-data":{"name":"t_neo4j-data"}}}' ;;
  "compose -p t ps --services --status running") [ -e '${repo}/stopped' ] || printf 'api\\nworker\\nneo4j\\n' ;;
  "compose -p t stop"*) touch '${repo}/stopped' ;;
  "compose -p t up"*) rm -f '${repo}/stopped' ;;
  *"--entrypoint df"*) printf 'F 1 0 1000000 0%% /data\\nF 1 0 1000000 0%% /data\\n' ;;
  *"--name t-restore-load"*) cat >/dev/null; [ "\${AT:-}" != load ] || act ;;
  "start t-restore-swap") [ "\${AT:-}" != swap ] || act ;;
  "wait t-restore-swap") echo 0 ;;
  "rm t-restore-swap") [ "\${AT:-}" != swaprm ] || act ;;
esac
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  // mv: with AT=state, the restore is killed right after the live state/ is set aside, before the new one is moved in;
  // with AT=stateint, a Ctrl-C reaches it (and this mv) as the state swap starts.
  writeFileSync(join(bin, 'mv'), `#!/bin/bash
case "\${AT:-}:$*" in stateint:*owner-session-revocations.json) kill -INT -- -"$(ps -o pgid= -p $$ | tr -d ' ')" ;; esac
/bin/mv "$@" || exit
if [ "\${AT:-}" = state ] && [ "$*" = "state state.previous" ]; then g="$(ps -o pgid= -p $$ | tr -d ' ')"; kill -9 "$g"; kill -9 -- -"$g"; fi
`);
  chmodSync(join(bin, 'mv'), 0o755);
  // tar: with AT=unpack, the restore is killed while it unpacks the worker state.
  writeFileSync(join(bin, 'tar'), `#!/bin/bash
if [ "\${AT:-}" = unpack ] && [ "$1" = -xzf ]; then g="$(ps -o pgid= -p $$ | tr -d ' ')"; kill -9 "$g"; kill -9 -- -"$g"; fi
exec /usr/bin/tar "$@"
`);
  chmodSync(join(bin, 'tar'), 0o755);
  for (const tool of ['curl', 'nc']) { writeFileSync(join(bin, tool), '#!/bin/sh\nexit 7\n'); chmodSync(join(bin, tool), 0o755); }
  const env = { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`, HOME: repo, FORCE: '1' };
  // The backup: its state/ says so.
  writeFileSync(join(repo, 'state', 'which'), 'backup\n');
  const backup = join(repo, 'backups', 'b1');
  mkdirSync(backup, { recursive: true });
  const ready = (async () => {
    await run('tar', ['-czf', join(backup, 'state.tgz'), 'state'], { cwd: repo });
    writeFileSync(join(backup, 'neo4j.dump'), 'dump');
    writeFileSync(join(backup, 'STORE'), 'neo4j\n');
    await run('sh', ['-c', 'shasum -a 256 neo4j.dump state.tgz STORE > SHA256SUMS'], { cwd: backup });
    writeFileSync(join(repo, 'state', 'which'), 'live\n');
  })();
  /** restore.sh in its own process group; resolves with its exit status and stderr. */
  const restore = async (args: string[], extra: Record<string, string> = {}) => {
    await ready;
    return new Promise<{ code: number | null; signal: string | null; out: string; err: string }>((resolve) => {
      const p = spawn('bash', [join(repo, 'scripts', 'restore.sh'), ...args], { cwd: repo, detached: true, env: { ...env, ...extra } });
      p.stdin.end();
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code, signal) => resolve({ code, signal, out, err }));
    });
  };
  const script = (name: string) => run('bash', [join(repo, 'scripts', name)], { cwd: repo, env }).then((r) => ({ code: 0, out: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }));
  const which = () => readFileSync(join(repo, 'state', 'which'), 'utf8').trim();
  const ran = () => readFileSync(calls, 'utf8');
  return { repo, backup, ready, restore, script, which, ran, marker: join(repo, 'state', '.restore-incomplete'), journal: join(repo, '.restore', 'journal') };
}

test('a restore killed while the database is swapped is reported everywhere, keeps the worker from starting, and the next restore finishes it', async () => {
  const s = sandbox();
  const killed = await s.restore(['backups/b1'], { AT: 'swap', HOW: 'kill' });
  expect(killed.signal).toBe('SIGKILL');
  // The database may be the backup's; state/ is still the previous one, marked.
  expect(s.which()).toBe('live');
  expect(existsSync(s.marker)).toBe(true);
  expect(await unfinishedRestore(join(s.repo, 'state', 'worker.sqlite'))).toBe('a restore from backups/b1 did not finish: run ./scripts/restore.sh backups/b1');
  const backup = await s.script('backup.sh');
  expect(backup.code).not.toBe(0);
  expect(backup.out).toContain('a restore from backups/b1 was interrupted while replacing the neo4j store and the worker state');
  expect(backup.out).toContain('Next: finish it with ./scripts/restore.sh backups/b1');
  const doctor = await s.script('doctor.sh');
  expect(doctor.out).toContain('FAIL  restore: a restore from backups/b1 was interrupted while replacing');
  const abandon = await s.restore(['--abandon']);
  expect(abandon.code).toBe(1);
  expect(abandon.err).toContain('--abandon cannot undo that');
  // Run again, it finishes: both are the backup's, nothing is left, and what the killed one stopped runs again.
  const again = await s.restore(['backups/b1']);
  expect(again.err).toBe('');
  expect(again.code).toBe(0);
  expect(again.out).toContain('interrupted while replacing');
  expect(s.which()).toBe('backup');
  expect(existsSync(s.marker)).toBe(false);
  expect(existsSync(join(s.repo, '.restore'))).toBe(false);
  expect(s.ran()).toMatch(/compose -p t up -d --no-deps api worker neo4j\n/);
  expect(await unfinishedRestore(join(s.repo, 'state', 'worker.sqlite'))).toBeNull();
  // Every container it ran belongs to the project and mounts the image's /logs: none leaves an anonymous volume.
  const runs = s.ran().split('\n').filter((l) => l.startsWith('docker run'));
  expect(runs.length).toBeGreaterThan(0);
  for (const r of runs.concat(s.ran().split('\n').filter((l) => l.startsWith('docker create')))) expect(r).toMatch(/--label com\.docker\.compose\.project=t .*-v t_neo4j-data:\/data --mount type=tmpfs,dst=\/logs/);
}, SCRIPT_TEST_TIMEOUT_MS);

test('a restore killed while loading replaced nothing: it is reported, and --abandon cleans up and starts the stack again', async () => {
  const s = sandbox();
  expect((await s.restore(['backups/b1'], { AT: 'load', HOW: 'kill' })).signal).toBe('SIGKILL');
  expect(s.which()).toBe('live');
  expect(existsSync(s.marker)).toBe(false);
  const backup = await s.script('backup.sh');
  expect(backup.code).not.toBe(0);
  expect(backup.out).toContain('was interrupted before anything was replaced');
  expect((await s.script('doctor.sh')).out).toContain('WARN  restore: a restore from backups/b1 was interrupted before anything was replaced');
  const abandon = await s.restore(['--abandon']);
  expect(abandon.code).toBe(0);
  expect(abandon.out).toContain('the store and the worker state are as they were, and the stack was started again');
  expect(s.ran()).toMatch(/compose -p t up -d --no-deps api worker neo4j\n/);
  expect(existsSync(join(s.repo, '.restore'))).toBe(false);
  expect(s.which()).toBe('live');
}, SCRIPT_TEST_TIMEOUT_MS);

test('a restore killed while unpacking stopped nothing: it says the stack is as it was, and a backup goes ahead', async () => {
  const s = sandbox();
  expect((await s.restore(['backups/b1'], { AT: 'unpack', HOW: 'kill' })).signal).toBe('SIGKILL');
  expect(s.ran()).not.toMatch(/compose -p t stop/);
  const untouched = 'a restore from backups/b1 was interrupted while unpacking the backup, before it stopped or replaced anything: the neo4j store, the worker state and the stack are as they were';
  expect((await s.script('doctor.sh')).out).toContain(`WARN  restore: ${untouched}`);
  const backup = await s.script('backup.sh');
  expect(backup.code).toBe(0);
  expect(backup.out).toContain(untouched);
  expect(backup.out).toContain('backup written to backups/');
  expect(s.which()).toBe('live');
  // Run again, it restores and says what the interrupted one left.
  const again = await s.restore(['backups/b1']);
  expect(again.code).toBe(0);
  expect(again.out).toContain(untouched);
  expect(s.which()).toBe('backup');
  expect(existsSync(join(s.repo, '.restore'))).toBe(false);
  // The same step, but after an earlier restore that stopped services and was interrupted: those stay stopped.
  mkdirSync(join(s.repo, '.restore'));
  writeFileSync(s.journal, 'pid=999999\nstarted=x\nsrc=backups/b1\nstore=neo4j\nrunning=api worker\nstep=unpacking\n');
  const refused = await s.script('backup.sh');
  expect(refused.code).toBe(1);
  expect(refused.out).toContain('was interrupted before anything was replaced: the neo4j store and the worker state are as they were, but the stack was left stopped');
}, SCRIPT_TEST_TIMEOUT_MS);

test('Ctrl-C during the swap lets it finish and says the restore is done but the stack was not started, not that it is unhealthy', async () => {
  const s = sandbox();
  const r = await s.restore(['backups/b1'], { AT: 'swap', HOW: 'int' });
  expect(r.code).toBe(130);
  expect(r.err).toContain('restore interrupted after the neo4j store and worker state were restored from backups/b1; the stack was not started again');
  expect(r.err).not.toContain('did not come back healthy');
  expect(s.which()).toBe('backup');
  expect(existsSync(s.marker)).toBe(false);
  expect(existsSync(join(s.repo, '.restore'))).toBe(false);
}, SCRIPT_TEST_TIMEOUT_MS);

test('Ctrl-C as the worker state is swapped in, or as the swap container is removed, lets that finish, then stops', async () => {
  for (const at of ['stateint', 'swaprm']) {
    const s = sandbox();
    const r = await s.restore(['backups/b1'], { AT: at, HOW: 'int' });
    expect(r.code, at).toBe(130);
    expect(r.err, at).toContain('restore interrupted after the neo4j store and worker state were restored from backups/b1; the stack was not started again');
    expect(s.which(), at).toBe('backup');
    expect(existsSync(s.marker), at).toBe(false);
    expect(existsSync(join(s.repo, '.restore')), at).toBe(false);
    expect(existsSync(join(s.repo, 'state.previous')), at).toBe(false);
    expect(s.ran(), at).not.toMatch(/compose -p t up/);
  }
}, SCRIPT_TEST_TIMEOUT_MS);

test('Ctrl-C while loading stops there: nothing is replaced and the stack starts again', async () => {
  const s = sandbox();
  const r = await s.restore(['backups/b1'], { AT: 'load', HOW: 'int' });
  expect(r.code).toBe(130);
  expect(r.err).toContain('restore interrupted; nothing was replaced');
  expect(s.which()).toBe('live');
  expect(s.ran()).toMatch(/compose -p t up -d --no-deps api worker neo4j\n/);
  expect(existsSync(join(s.repo, '.restore'))).toBe(false);
}, SCRIPT_TEST_TIMEOUT_MS);

test('a restore killed between setting the live state/ aside and moving the restored one in is finished by the next one', async () => {
  const s = sandbox();
  expect((await s.restore(['backups/b1'], { AT: 'state', HOW: 'kill' })).signal).toBe('SIGKILL');
  expect(existsSync(join(s.repo, 'state'))).toBe(false);
  expect((await s.script('backup.sh')).out).toContain('interrupted while replacing');
  const again = await s.restore(['backups/b1']);
  expect(again.err).toBe('');
  expect(again.code).toBe(0);
  expect(s.which()).toBe('backup');
  expect(existsSync(join(s.repo, 'state.previous'))).toBe(false);
  expect(existsSync(s.marker)).toBe(false);
}, SCRIPT_TEST_TIMEOUT_MS);

test('a backup whose state.tgz holds a link or a path outside state/ is refused before anything is written through it', async () => {
  const s = sandbox();
  await s.ready;
  const host = join(s.repo, 'host-file');
  writeFileSync(host, 'untouched\n');
  const craft = join(s.repo, 'craft');
  const variants: [string, string][] = [
    ['symlink', `mkdir -p state/api-settings && ln -s '${host}' state/api-settings/owner-session-revocations.json && tar -czf t.tgz state`],
    ['hard link', `mkdir -p state/runner-control && echo x > state/a && ln state/a state/runner-control/codex-runner-disabled && tar -czf t.tgz state`],
    ['../ path', `mkdir -p state && echo x > state/a && if tar --version | grep -q GNU; then tar -czf t.tgz --transform 's,^state/a,state/../../a,' state; else tar -czf t.tgz -s ',^state/a,state/../../a,' state; fi`],
  ];
  for (const [what, make] of variants) {
    rmSync(craft, { recursive: true, force: true });
    mkdirSync(craft);
    await run('bash', ['-c', make], { cwd: craft });
    copyFileSync(join(craft, 't.tgz'), join(s.backup, 'state.tgz'));
    await run('sh', ['-c', 'shasum -a 256 neo4j.dump state.tgz STORE > SHA256SUMS'], { cwd: s.backup });
    const r = await s.restore(['backups/b1']);
    expect(r.code, what).toBe(1);
    expect(r.err, what).toContain('holds links or paths outside state/; not restoring');
    expect(r.err, what).toContain('nothing was replaced');
    expect(readFileSync(host, 'utf8'), what).toBe('untouched\n');
    expect(s.which(), what).toBe('live');
    expect(existsSync(join(s.repo, '.restore')), what).toBe(false);
  }
}, SCRIPT_TEST_TIMEOUT_MS);
