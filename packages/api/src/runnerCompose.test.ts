import { readFileSync } from 'node:fs';
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

test('the manual procfs override contains only its additive option and uses the installer filename', () => {
  const docs = read('docs/operations.md');
  const snippet = docs.match(/```yaml\n# docker-compose\.runner-procfs\.yml\n([\s\S]*?)```/)?.[1];
  expect(snippet?.trim()).toBe('services:\n  codex-runner:\n    security_opt:\n      - systempaths=unconfined');
  expect(docs).not.toContain('docker-compose.codex-procfs.yml');
  expect(read('scripts/setup.sh')).toContain('docker-compose.runner-procfs.yml');
});


test('the small profile budgets fit its container and both Codex login mounts are read-only', () => {
  const small = read('docker-compose.small.yml');
  expect(small).toContain('mem_limit: 1G');
  expect(small).toContain('NEO4J_server_memory_heap_max__size: 512M');
  expect(small).toContain('NEO4J_server_memory_pagecache_size: 128M');
  const compose = read('docker-compose.yml');
  expect(compose.match(/CODEX_AUTH_FILE[^\n]+:\/codex\/auth\.json:ro/g)).toHaveLength(2);
});
