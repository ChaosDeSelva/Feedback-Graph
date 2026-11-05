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
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, COMPOSE_FILE: 'docker-compose.yml:docker-compose.test.yml' };
const execFileAsync = promisify(execFile);
const run = async (file: string, args: string[] = []) => {
  const result = await execFileAsync(file, args, { cwd: root, env, encoding: 'utf8', timeout: 180_000 });
  return result.stdout;
};

for (const file of ['docker-compose.yml', 'scripts/backup.sh', 'scripts/restore.sh', 'scripts/doctor.sh', 'scripts/lib/store.sh', 'scripts/lib/env.sh', 'scripts/lib/json.sh', 'scripts/lib/ollama.sh']) {
  const to = join(root, file); mkdirSync(dirname(to), { recursive: true }); cpSync(join(source, file), to);
}
mkdirSync(join(root, 'state'), { recursive: true });
writeFileSync(join(root, '.env'), 'STORE=neo4j\nNEO4J_PASSWORD=backup-test-password\nNEO4J_HTTP_PORT=0\nNEO4J_BOLT_PORT=0\n');
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
}, 240_000);
