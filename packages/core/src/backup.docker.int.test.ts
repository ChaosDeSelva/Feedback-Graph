import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, expect, test } from 'vitest';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'fg-backup-roundtrip-'));
const project = `fg_backup_${process.pid}`;
const env = { ...process.env };
delete env.COMPOSE_PROJECT_NAME;
delete env.COMPOSE_FILE;
const execFileAsync = promisify(execFile);
// A hang guard (each command has its own 180 s limit): a round trip starts and stops Neo4j several times, which on a
// host with dozens of other containers and a load average in the hundreds has taken over four minutes.
const ROUNDTRIP_TIMEOUT_MS = 900_000;
const run = async (file: string, args: string[] = []) => {
  const result = await execFileAsync(file, args, { cwd: root, env, encoding: 'utf8', timeout: 180_000 });
  return result.stdout;
};

for (const file of ['docker-compose.yml', 'scripts/backup.sh', 'scripts/restore.sh', 'scripts/doctor.sh', 'scripts/lib/store.sh', 'scripts/lib/env.sh', 'scripts/lib/json.sh', 'scripts/lib/ollama.sh', 'scripts/lib/restore-journal.sh', 'scripts/lib/state-fs.sh']) {
  const to = join(root, file); mkdirSync(dirname(to), { recursive: true }); cpSync(join(source, file), to);
}
mkdirSync(join(root, 'state'), { recursive: true });
writeFileSync(join(root, '.env'), `FG_INSTANCE=${project}\nCOMPOSE_FILE=docker-compose.yml:docker-compose.test.yml\nSTORE=neo4j\nNEO4J_PASSWORD=backup-test-password\nNEO4J_HTTP_PORT=0\nNEO4J_BOLT_PORT=0\n`);
// Models the configured codex-runner on a host where its sandbox health probe fails. It stays running but unhealthy:
// backup/restore must restart the data services without making this unrelated sidecar's health their exit status.
writeFileSync(join(root, 'docker-compose.test.yml'), `services:
  runner-probe:
    image: alpine:3.22
    command: ["sleep", "300"]
    healthcheck: { test: ["CMD", "false"], interval: 1s, timeout: 1s, retries: 1 }
`);

afterAll(async () => {
  try { await run('docker', ['compose', 'down', '-v', '--remove-orphans']); } catch { /* best effort */ }
});

test('stock Neo4j stops cleanly and backup/restore preserves data', async () => {
  await run('docker', ['compose', 'up', '-d', 'runner-probe']);
  await run('docker', ['compose', 'up', '-d', '--wait', 'neo4j']);
  const doctor = await execFileAsync('bash', ['scripts/doctor.sh'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
  expect(doctor.stdout).toMatch(/Neo4j memory: \d+ MiB used \/ \d+ MiB limit/);
  await run('docker', ['compose', 'exec', '-T', 'neo4j', 'cypher-shell', '-u', 'neo4j', '-p', 'backup-test-password', 'CREATE (:BackupProbe {value: 73})']);
  await run('bash', ['scripts/backup.sh']);
  const backup = join(root, 'backups', readdirSync(join(root, 'backups'))[0]);
  expect(readFileSync(join(backup, 'STORE'), 'utf8').trim()).toBe('neo4j');
  expect(readdirSync(backup)).toContain('neo4j.dump');
  expect(statSync(join(backup, 'neo4j.dump')).mode & 0o777).toBe(0o600);
  await run('docker', ['compose', 'exec', '-T', 'neo4j', 'cypher-shell', '-u', 'neo4j', '-p', 'backup-test-password', 'MATCH (n:BackupProbe) DELETE n']);
  await run('bash', ['-c', `FORCE=1 scripts/restore.sh '${backup.replaceAll("'", "'\\''")}'`]);
  expect(await run('docker', ['compose', 'ps', '--status', 'running', '--services'])).toContain('runner-probe');
  const count = await run('docker', ['compose', 'exec', '-T', 'neo4j', 'cypher-shell', '--format', 'plain', '-u', 'neo4j', '-p', 'backup-test-password', 'MATCH (n:BackupProbe) RETURN count(n) AS count']);
  expect(count).toMatch(/\b1\b/);
}, ROUNDTRIP_TIMEOUT_MS);

test('a restore that fails part-way leaves the previous database and state in place, restarts the stack and says what next', async () => {
  const cypher = (q: string) => run('docker', ['compose', 'exec', '-T', 'neo4j', 'cypher-shell', '--format', 'plain', '-u', 'neo4j', '-p', 'backup-test-password', q]);
  await run('docker', ['compose', 'up', '-d', '--wait', 'neo4j']);
  await run('bash', ['scripts/backup.sh']);
  const good = join(root, 'backups', readdirSync(join(root, 'backups')).sort().at(-1)!);
  // Data and state written after that backup: a failed restore must leave exactly these.
  await cypher('CREATE (:AfterBackup {value: 99})');
  writeFileSync(join(root, 'state', 'after-backup'), 'kept');
  // The backup truncated mid-archive, with checksums recomputed so the restore gets as far as loading it.
  const bad = join(root, 'backups', 'truncated');
  mkdirSync(bad, { recursive: true });
  for (const f of ['state.tgz', 'STORE']) cpSync(join(good, f), join(bad, f));
  const dump = readFileSync(join(good, 'neo4j.dump'));
  writeFileSync(join(bad, 'neo4j.dump'), dump.subarray(0, Math.floor(dump.length / 2)));
  await run('bash', ['-c', `cd '${bad}' && shasum -a 256 neo4j.dump state.tgz STORE > SHA256SUMS`]);
  const failed = await execFileAsync('bash', ['-c', `FORCE=1 scripts/restore.sh '${bad}'`], { cwd: root, env, encoding: 'utf8', timeout: 180_000 })
    .then(() => null, (e: { code?: number; stderr?: string }) => e);
  expect(failed?.code).not.toBe(0);
  expect(failed?.stderr).toMatch(/nothing was replaced: the neo4j store and worker state are as they were, and the stack was started again/);
  expect(failed?.stderr).toMatch(/Next: /);
  await run('docker', ['compose', 'up', '-d', '--wait', 'neo4j']);
  expect(await cypher('MATCH (n:AfterBackup) RETURN count(n) AS count')).toMatch(/\b1\b/);
  expect(readFileSync(join(root, 'state', 'after-backup'), 'utf8')).toBe('kept');
  // Nothing of the attempt is left: no loaded copy in the volume, no unpacked state or journal, no container.
  expect(await run('docker', ['compose', 'run', '--rm', '--no-deps', '--entrypoint', 'ls', 'neo4j', '-A', '/data'])).not.toMatch(/\.restore/);
  expect(readdirSync(root).filter(f => f.startsWith('.restore'))).toEqual([]);
  expect(await run('docker', ['ps', '-aq', '--filter', `name=${project}-restore`])).toBe('');
}, ROUNDTRIP_TIMEOUT_MS);
