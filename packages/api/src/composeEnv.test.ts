import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test("a shell's COMPOSE_PROJECT_NAME or COMPOSE_FILE never points scripts/fg at another install's containers", async () => {
  const repo = mkdtempSync(join(tmpdir(), 'fg-compose-env-'));
  const bin = join(repo, 'bin');
  const log = join(repo, 'docker-calls');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(root, 'scripts', 'fg'), join(repo, 'scripts', 'fg'));
  copyFileSync(join(root, 'scripts', 'lib', 'env.sh'), join(repo, 'scripts', 'lib', 'env.sh'));
  writeFileSync(join(repo, '.env'), 'FG_INSTANCE=mine\nAPI_PORT=8797\n');
  // No host Node, so fg runs inside this install's api container through docker compose.
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "project=\${COMPOSE_PROJECT_NAME-unset} file=\${COMPOSE_FILE-unset} $*" >> '${log}'\n`);
  for (const f of ['node', 'docker']) chmodSync(join(bin, f), 0o755);
  await promisify(execFile)('bash', [join(repo, 'scripts', 'fg'), 'sessions'], {
    env: { PATH: `${bin}:/usr/bin:/bin`, COMPOSE_PROJECT_NAME: 'another-install', COMPOSE_FILE: 'elsewhere.yml' },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  const exec = calls.find((c) => c.includes(' compose ') && c.includes(' exec '));
  expect(exec).toBeDefined();
  expect(calls.every((c) => c.startsWith('project=unset file=unset '))).toBe(true);
});
