import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

test('API and worker both receive the configured runner endpoint', () => {
  const compose = read('docker-compose.yml');
  for (const service of ['worker', 'api']) {
    const block = compose.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:)`, 'm'))?.[1];
    expect(block).toBeDefined();
    expect(block).toContain('CODEX_RUNNER_URL: ${CODEX_RUNNER_URL:-}');
  }
});

test('API and worker both receive the scan provider allowlist', () => {
  const compose = read('docker-compose.yml');
  for (const service of ['worker', 'api']) {
    const block = compose.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:)`, 'm'))?.[1];
    expect(block).toBeDefined();
    expect(block).toContain('SCAN_PROVIDER_ALLOW: ${SCAN_PROVIDER_ALLOW:-}');
  }
});

test('the manual procfs override contains only its additive option and uses the installer filename', () => {
  const docs = read('docs/operations.md');
  const snippet = docs.match(/```yaml\n# docker-compose\.runner-procfs\.yml\n([\s\S]*?)```/)?.[1];
  expect(snippet?.trim()).toBe('services:\n  codex-runner:\n    security_opt:\n      - systempaths=unconfined');
  expect(docs).not.toContain('docker-compose.codex-procfs.yml');
  expect(read('scripts/setup.sh')).toContain('docker-compose.runner-procfs.yml');
});


test('the small profile budgets fit its container and both Codex login mounts are read-only', () => {
  const small = read('docker-compose.small.yml');
  expect(small).toContain('mem_limit: 1536M');
  expect(small).toContain('NEO4J_server_memory_heap_initial__size: 256M');
  expect(small).toContain('NEO4J_server_memory_heap_max__size: 512M');
  expect(small).toContain('NEO4J_server_memory_pagecache_size: 128M');
  const compose = read('docker-compose.yml');
  expect(compose.match(/CODEX_AUTH_FILE[^\n]+:\/codex\/auth\.json:ro/g)).toHaveLength(2);
});

test('runner-control-init moves the pre-0.7.4 flag, so a flag cleared by hand does not come back on the next start', () => {
  // The init container's own script, run by sh on folders standing in for its two mounts.
  const line = read('docker-compose.yml').match(/^ {2}runner-control-init:\n[\s\S]*?^ {4}command: \['(.*)'\]$/m)?.[1];
  expect(line).toBeDefined();
  const base = mkdtempSync(join(tmpdir(), 'fbinit-'));
  const control = join(base, 'runner-control');
  const legacy = join(base, 'settings');
  mkdirSync(control);
  mkdirSync(legacy);
  const script = line!.replace(/''/g, "'").replace(/\$\$/g, '$').replace(/\/runner-control/g, control).replace(/\/legacy-settings/g, legacy);
  const start = () => execFileSync('sh', ['-eu', '-c', script], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CONTROL_UID: String(process.getuid!()), CONTROL_GID: String(process.getgid!()) } });
  writeFileSync(join(legacy, 'codex-runner-disabled'), 'network: runner reached a protected host or service endpoint\n');
  start();
  expect(readFileSync(join(control, 'codex-runner-disabled'), 'utf8')).toBe('network: runner reached a protected host or service endpoint\n');
  expect(existsSync(join(legacy, 'codex-runner-disabled'))).toBe(false);
  execFileSync('rm', [join(control, 'codex-runner-disabled')]);
  start();
  expect(existsSync(join(control, 'codex-runner-disabled'))).toBe(false);
  // Both present: the new flag keeps every reason from either.
  writeFileSync(join(control, 'codex-runner-disabled'), 'procfs: nested sandbox could not mount proc\n');
  writeFileSync(join(legacy, 'codex-runner-disabled'), 'network: runner reached a protected host or service endpoint\nprocfs: nested sandbox could not mount proc\n');
  start();
  expect(readFileSync(join(control, 'codex-runner-disabled'), 'utf8')).toBe('procfs: nested sandbox could not mount proc\nnetwork: runner reached a protected host or service endpoint\n');
  expect(existsSync(join(legacy, 'codex-runner-disabled'))).toBe(false);
});

test("the test databases (CI and docker-compose.test.yml) enforce the small profile's Neo4j transaction-memory limits", () => {
  const defaults = [...read('docker-compose.small.yml').matchAll(/(NEO4J_d\w+_memory_transaction_\w+): (\w+)/g)].map(([, k, v]) => `${k}: ${v}`);
  expect(defaults).toHaveLength(3);
  for (const file of ['.github/workflows/ci.yml', 'docker-compose.test.yml']) for (const line of defaults) expect(read(file)).toContain(line);
});
