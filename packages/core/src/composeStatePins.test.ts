import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

// The worker mounts ./state read-write. Docker follows a link at a bind-mount source each time a container starts, so
// every ./state path another container mounts (or the worker mounts a second time, such as the Codex login placeholder)
// must be a mount point inside the worker too: one it cannot rename, remove or replace with a link to a host path.
test('every ./state path mounted from docker-compose.yml is pinned as a mount point in the worker', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  const services = compose.slice(compose.indexOf('\nservices:'));
  const blocks = services.split(/\n {2}(?=[a-z][a-z0-9-]*:\n)/).slice(1);
  const mounts = (block: string) => [...block.matchAll(/^ {6}- (?:\$\{[A-Z_]+:-)?(\.\/state\/[^:}]+)\}?:([^:\n]+)/gm)].map((m) => ({ source: m[1], target: m[2] }));
  const worker = blocks.find((b) => b.startsWith('worker:'))!;
  const pinned = new Set(mounts(worker).map((m) => `${m.source}:${m.target}`));
  const sources = blocks.flatMap((b) => mounts(b).map((m) => m.source));
  expect(sources).toContain('./state/api-settings');
  expect(sources).toContain('./state/runner-control');
  expect(sources).toContain('./state/codex-auth.json');
  for (const source of new Set(sources)) expect(pinned.has(`${source}:${source.slice(1)}`), source).toBe(true);
});

// The project roots the api saves in state/api-settings decide the host folders the next setup mounts: the worker,
// which only reads integrations.json there, must not be able to write them.
test('the worker mounts the api settings read-only', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  const worker = compose.slice(compose.indexOf('\n  worker:\n'), compose.indexOf('\n  runner-control-init:'));
  expect(worker).toMatch(/^ {6}- \.\/state\/api-settings:\/state\/api-settings:ro$/m);
});
