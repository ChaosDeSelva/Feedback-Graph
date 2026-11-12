import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, expect, test } from 'vitest';

// The databases' images declare VOLUMEs (neo4j: /data and /logs; pgvector: its data folder). One the Compose files do
// not mount becomes an anonymous volume, which Compose hands on to a recreated container and `docker compose down -v`
// then leaves behind. The containers are only created, never started.
const source = fileURLToPath(new URL('../../../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'fg-compose-volumes-'));
const project = `fg_volumes_${process.pid}`;
const execFileAsync = promisify(execFile);
const docker = async (args: string[], composeFile: string) =>
  (await execFileAsync('docker', args, { cwd: root, env: { ...process.env, COMPOSE_PROJECT_NAME: project, COMPOSE_FILE: composeFile }, encoding: 'utf8', timeout: 180_000 })).stdout;
for (const file of ['docker-compose.yml', 'docker-compose.test.yml']) cpSync(join(source, file), join(root, file));
writeFileSync(join(root, '.env'), 'NEO4J_PASSWORD=volumes-test-password\nPOSTGRES_PASSWORD=volumestest\n');

afterAll(async () => {
  for (const f of ['docker-compose.yml', 'docker-compose.test.yml']) await docker(['compose', '--profile', 'postgres', 'down', '-v', '--remove-orphans'], f).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** Each created container's volume mounts that are anonymous: the image's VOLUME, mounted by nothing in the file. */
async function anonymousMounts(composeFile: string, services: string[]): Promise<string[]> {
  await docker(['compose', '--profile', 'postgres', 'create', ...services], composeFile);
  const ids = (await docker(['compose', '--profile', 'postgres', 'ps', '-aq'], composeFile)).trim().split('\n').filter(Boolean);
  const found: string[] = [];
  for (const id of ids) {
    const mounts = JSON.parse(await docker(['inspect', '--format', '{{json .Mounts}}', id], composeFile)) as { Type: string; Name?: string; Destination: string }[];
    const name = (await docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}', id], composeFile)).trim();
    for (const m of mounts.filter((x) => x.Type === 'volume')) {
      const labels = (await docker(['volume', 'inspect', '--format', '{{json .Labels}}', m.Name!], composeFile)).trim();
      if (labels.includes('com.docker.volume.anonymous') || !labels.includes(`"com.docker.compose.project":"${project}"`)) found.push(`${name}:${m.Destination}`);
    }
  }
  return found;
}

test('the stack\'s database containers mount every volume their images declare', async () => {
  expect(await anonymousMounts('docker-compose.yml', ['neo4j', 'postgres'])).toEqual([]);
}, 240_000);

test('the throwaway test databases leave no anonymous volume either', async () => {
  expect(await anonymousMounts('docker-compose.test.yml', ['neo4j-test', 'postgres-test'])).toEqual([]);
}, 240_000);
