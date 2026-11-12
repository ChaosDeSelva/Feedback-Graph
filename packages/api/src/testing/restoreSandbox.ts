import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execResult } from '@fb/core/testing/exec';
import { afterEach } from 'vitest';

// scripts/restore.sh and backup.sh on a copy, with a stand-in docker for a Neo4j install named t (each test's copy is
// removed after it).
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

export function sandbox() {
  const repo = mkdtempSync(join(tmpdir(), 'fg-restore-guards-'));
  dirs.push(repo);
  const bin = join(repo, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), bin, join(repo, 'state')]) mkdirSync(d, { recursive: true });
  for (const f of ['restore.sh', 'backup.sh', 'doctor.sh', 'fg', 'lib/store.sh', 'lib/env.sh', 'lib/json.sh', 'lib/ollama.sh', 'lib/restore-journal.sh', 'lib/state-fs.sh']) copyFileSync(join(repoRoot, 'scripts', f), join(repo, 'scripts', f));
  writeFileSync(join(repo, '.env'), 'FG_INSTANCE=t\nSTORE=neo4j\nNEO4J_PASSWORD=pw\n');
  const calls = join(repo, 'calls');
  // docker: $STARTED_IN is the folder Docker says t's service containers were started from, and $LEFTOVER (when set) that
  // of a newer one-off container (a killed backup's); df in the volume says $FREE_KB. $DOCKER_INFO set: the daemon answers.
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
echo "docker $*" >> '${calls}'
case "$*" in
  info) [ -n "\${DOCKER_INFO:-}" ] || exit 1 ;;
  "ps -a "*) { [ -z "\${LEFTOVER+x}" ] || printf 'True\\t%s\\n' "$LEFTOVER"; [ -z "\${STARTED_IN:-}" ] || printf 'False\\t%s\\n' "$STARTED_IN"; } |
    case "$*" in *oneoff=False*) awk -F'\\t' '$1 == "False"' ;; *) cat ;; esac | cut -f2 ;;
  "compose -p t config --format json") echo '{"name":"t","services":{"neo4j":{"image":"neo4j:x"}},"volumes":{"neo4j-data":{"name":"t_neo4j-data"}}}' ;;
  "compose -p t ps --services --status running") [ -e '${repo}/stopped' ] || printf 'api\\nworker\\nneo4j\\n' ;;
  "compose -p t stop"*) touch '${repo}/stopped' ;;
  "compose -p t up"*) rm -f '${repo}/stopped' ;;
  *"--entrypoint df"*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 9 0 %s 0%% /data\\n' "\${FREE_KB:-1000000}" ;;
  *"--name t-restore-load"*) cat >/dev/null ;;
  "wait t-restore-swap") echo 0 ;;
esac
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  for (const tool of ['curl', 'nc']) { writeFileSync(join(bin, tool), '#!/bin/sh\nexit 7\n'); chmodSync(join(bin, tool), 0o755); }
  const env = { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`, HOME: repo, FORCE: '1' };
  const backup = join(repo, 'backups', 'b1');
  mkdirSync(backup, { recursive: true });
  /** backups/b1 holding state.tgz made from state/ as `fill` leaves it, and a dump of `dumpBytes`; state/ is then live. */
  const make = async (fill: (state: string) => void = () => {}, dumpBytes = 4) => {
    const staging = join(repo, 'staging');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(staging, 'state'), { recursive: true });
    writeFileSync(join(staging, 'state', 'which'), 'backup\n');
    fill(join(staging, 'state'));
    await exec('tar', ['-czf', join(backup, 'state.tgz'), 'state'], { cwd: staging });
    rmSync(staging, { recursive: true, force: true });
    writeFileSync(join(backup, 'neo4j.dump'), Buffer.alloc(dumpBytes, 1));
    writeFileSync(join(backup, 'STORE'), 'neo4j\n');
    await exec('sh', ['-c', 'shasum -a 256 neo4j.dump state.tgz STORE > SHA256SUMS'], { cwd: backup });
    writeFileSync(join(repo, 'state', 'which'), 'live\n');
  };
  const script = async (name: string, args: string[] = [], extra: Record<string, string> = {}) => {
    const r = await execResult('bash', [join(repo, 'scripts', name), ...args], { cwd: repo, env: { ...env, ...extra } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const restore = (extra: Record<string, string> = {}) => script('restore.sh', ['backups/b1'], extra);
  const which = () => readFileSync(join(repo, 'state', 'which'), 'utf8').trim();
  const ran = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
  const journal = join(repo, '.restore', 'journal');
  const writeJournal = (text: string) => { mkdirSync(join(repo, '.restore'), { recursive: true }); writeFileSync(journal, text); };
  return { repo, bin, backup, make, script, restore, which, ran, journal, writeJournal };
}
