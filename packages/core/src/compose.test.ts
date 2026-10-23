import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Every setting .env.example documents must reach docker compose: a key compose never interpolates is ignored
// without a word, however the docs describe it.
const repo = join(import.meta.dirname, '../../..');
/** Read by docker compose itself or by scripts/setup.sh, not passed to a service. */
const NOT_INTERPOLATED = new Set(['COMPOSE_PROFILES', 'PROJECTS_DIRS']);

test('every key in .env.example is used by docker-compose.yml', () => {
  const keys = [...readFileSync(join(repo, '.env.example'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  const missing = keys.filter((k) => !NOT_INTERPOLATED.has(k) && !compose.includes(`\${${k}`));
  expect(missing).toEqual([]);
});
