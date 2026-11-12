import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { exec, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';

// setup.sh's lock functions (take_lock, drop_lock and their EXIT trap), cut from the script as it is, run by small bash
// holders that log when they hold the lock.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = readFileSync(join(repoRoot, 'scripts', 'setup.sh'), 'utf8');
const lockCode = script.slice(script.indexOf('# Locks are directories'), script.indexOf("trap 'exit 130' INT TERM"));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'fg-setup-lock-'));
  dirs.push(base);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(base, 'lock.sh'), lockCode);
  // A holder: takes the lock, logs IN, holds it for HOLD seconds (or until the file RELEASE exists), logs OUT, drops it.
  writeFileSync(join(base, 'holder.sh'), `set -euo pipefail
. '${join(base, 'lock.sh')}'
take_lock "$1" "for the test"
echo "IN $2" >> '${join(base, 'log')}'
if [ -n "\${RELEASE:-}" ]; then until [ -e "\$RELEASE" ]; do sleep 0.05; done; else sleep "\${HOLD:-0.3}"; fi
echo "OUT $2" >> '${join(base, 'log')}'
drop_lock "$1"
`);
  // cat, but the first call made with SLOW_CAT set creates that directory and returns only once SLOW_CAT_GO exists:
  // that holder reads the owner, then is held while another one acts on the same reading.
  writeFileSync(join(bin, 'cat'), `#!/bin/sh
if [ -n "\${SLOW_CAT:-}" ] && mkdir "\$SLOW_CAT" 2>/dev/null; then /bin/cat "$@"; s=$?; until [ -e "\$SLOW_CAT_GO" ]; do sleep 0.05; done; exit $s; fi
exec /bin/cat "$@"
`);
  chmodSync(join(bin, 'cat'), 0o755);
  // mkdir, but with SLOW_MKDIR set, one that makes a directory named like the lock then creates SLOW_MKDIR and returns
  // only once SLOW_MKDIR_GO exists.
  writeFileSync(join(bin, 'mkdir'), `#!/bin/sh
/bin/mkdir "$@" || exit
case "\${SLOW_MKDIR:-}:$*" in ?*:*.setup.lock*) : >"\$SLOW_MKDIR"; until [ -e "\$SLOW_MKDIR_GO" ]; do /bin/sleep 0.05; done ;; esac
`);
  chmodSync(join(bin, 'mkdir'), 0o755);
  // sleep, but with SLEEPS set, take_lock's one-second wait between looks at the lock returns at once, counted in that
  // file; the PAUSE_AT-th returns only once PAUSE_GO exists.
  writeFileSync(join(bin, 'sleep'), `#!/bin/sh
[ -n "\${SLEEPS:-}" ] && [ "$1" = 1 ] || exec /bin/sleep "$@"
n=$(($(/bin/cat "\$SLEEPS" 2>/dev/null || echo 0) + 1)); echo "$n" >"\$SLEEPS"
[ "$n" != "\${PAUSE_AT:-}" ] || until [ -e "\$PAUSE_GO" ]; do /bin/sleep 0.05; done
`);
  chmodSync(join(bin, 'sleep'), 0o755);
  const lock = join(base, 'state', '.setup.lock');
  mkdirSync(join(base, 'state'));
  /** A holder run; `said()` is its stderr so far. */
  const holder = (name: string, env: Record<string, string> = {}) => {
    let stderr = '';
    const run = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const p = spawn('bash', [join(base, 'holder.sh'), lock, name], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env } });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code, stderr }));
    });
    return Object.assign(run, { said: () => stderr });
  };
  const logged = () => (existsSync(join(base, 'log')) ? readFileSync(join(base, 'log'), 'utf8') : '');
  /** Waits, on real timers, until check() holds. */
  const until = async (check: () => boolean) => { while (!check()) await sleep(20); };
  /** The most holders at once, from the IN/OUT log. */
  const most = () => {
    let n = 0, max = 0;
    for (const line of readFileSync(join(base, 'log'), 'utf8').trim().split('\n')) { n += line.startsWith('IN') ? 1 : -1; max = Math.max(max, n); }
    return max;
  };
  /** A lock left by a setup that is gone: its pid ran once and exited. */
  const deadOwner = async () => {
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${(await exec('bash', ['-c', '(exit 0) & echo $!'])).trim()}\n`);
  };
  return { base, lock, holder, most, deadOwner, logged, until };
}

test('of two setups that find the same dead owner, the one that acts second cannot take the lock the first now holds', async () => {
  const s = sandbox();
  await s.deadOwner();
  // a reads the dead owner and is held; b takes the lock over meanwhile; only then does a act on what it read.
  const go = join(s.base, 'go');
  const a = s.holder('a', { SLOW_CAT: join(s.base, 'slow'), SLOW_CAT_GO: go, HOLD: '0.3' });
  await s.until(() => existsSync(join(s.base, 'slow')));
  const b = s.holder('b', { RELEASE: join(s.base, 'release-b') });
  await s.until(() => s.logged().includes('IN b'));
  writeFileSync(go, '');
  // b holds the lock until a has acted on the stale reading: a waits for it, or (the bug) takes the lock beside it.
  await s.until(() => a.said().includes('waiting for another Feedback Graph setup') || s.logged().includes('IN a'));
  writeFileSync(join(s.base, 'release-b'), '');
  expect((await Promise.all([a, b])).map((r) => r.code)).toEqual([0, 0]);
  expect(s.logged().trim().split('\n')).toEqual(['IN b', 'OUT b', 'IN a', 'OUT a']);
  expect(s.most()).toBe(1);
  expect(existsSync(s.lock)).toBe(false);
}, SCRIPT_TEST_TIMEOUT_MS);

test('25 setups started together on a dead owner\'s lock hold it one at a time', async () => {
  const s = sandbox();
  await s.deadOwner();
  const runs = await Promise.all(Array.from({ length: 25 }, (_, i) => s.holder(String(i), { HOLD: '0.05' })));
  expect(runs.map((r) => r.code)).toEqual(Array(25).fill(0));
  expect(readFileSync(join(s.base, 'log'), 'utf8').match(/^IN/gm)).toHaveLength(25);
  expect(s.most()).toBe(1);
  expect(existsSync(s.lock)).toBe(false);
}, SCRIPT_TEST_TIMEOUT_MS);

test('a lock whose pid now belongs to another process (after a crash or a reboot) is taken over at once', async () => {
  const s = sandbox();
  mkdirSync(s.lock);
  // This test's own pid: alive, but not started when the lock says its owner was.
  writeFileSync(join(s.lock, 'pid'), `${process.pid} Thu Jan  1 00:00:00 1970\n`);
  const a = await s.holder('a', { HOLD: '0' });
  expect(a.code).toBe(0);
  // At once: it never waited a round for the owner the lock names.
  expect(a.stderr).not.toContain('waiting for another Feedback Graph setup');
  expect(s.most()).toBe(1);
}, SCRIPT_TEST_TIMEOUT_MS);

test('a setup waiting for a live one says where the lock is, so a stuck one can be removed by hand', async () => {
  const s = sandbox();
  // first holds the lock until second has said it waits.
  const release = join(s.base, 'release');
  const first = s.holder('first', { RELEASE: release });
  await s.until(() => s.logged().includes('IN first'));
  const waiting = s.holder('second', { HOLD: '0' });
  await s.until(() => waiting.said().includes('waiting for another Feedback Graph setup'));
  writeFileSync(release, '');
  const second = await waiting;
  await first;
  expect(second.stderr).toContain(`waiting for another Feedback Graph setup (pid `);
  expect(second.stderr).toContain(`remove ${s.lock}`);
  expect(s.most()).toBe(1);
}, SCRIPT_TEST_TIMEOUT_MS);

test('the lock never exists without its owner\'s pid, so a waiter can never take it for one its creator died before writing', async () => {
  const s = sandbox();
  const made = join(s.base, 'made'), go = join(s.base, 'made-go');
  // a is held right after it makes a directory for the lock: the lock as a waiter would see it then.
  const a = s.holder('a', { SLOW_MKDIR: made, SLOW_MKDIR_GO: go, HOLD: '0' });
  await s.until(() => existsSync(made));
  // Not there yet, or there with its owner's pid and start time.
  expect(existsSync(s.lock) ? readFileSync(join(s.lock, 'pid'), 'utf8') : 'not there').toMatch(/^(not there|\d+ \S.*\n)$/);
  writeFileSync(go, '');
  expect((await a).code).toBe(0);
  expect(existsSync(s.lock)).toBe(false);
}, SCRIPT_TEST_TIMEOUT_MS);

test('a waiter claims only a lock that stayed without a pid for 30 looks, never one that showed up without its pid since', async () => {
  // A lock with no pid (as a setup from before 0.7.6 killed before it wrote one leaves, or a live lock while a waiter
  // takes its pid file over), looked at 29 times, then replaced by another such directory.
  const s = sandbox();
  mkdirSync(s.lock);
  const sleeps = join(s.base, 'sleeps'), go = join(s.base, 'go');
  const waiter = s.holder('w', { HOLD: '0', SLEEPS: sleeps, PAUSE_AT: '29', PAUSE_GO: go });
  await s.until(() => existsSync(sleeps) && readFileSync(sleeps, 'utf8').trim() === '29');
  renameSync(s.lock, `${s.lock}.old`);
  mkdirSync(s.lock);
  writeFileSync(go, '');
  expect((await waiter).code).toBe(0);
  // Counted afresh for the new directory: 29 looks at the old one, then 30 at the new one before claiming it.
  expect(readFileSync(sleeps, 'utf8').trim()).toBe('58');
  expect(s.most()).toBe(1);
}, SCRIPT_TEST_TIMEOUT_MS);
