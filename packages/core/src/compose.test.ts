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

test('docker-compose.yml mounts no project folder: the roots come only from the override setup.sh generates', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  for (const gone of ['${PROJECTS_DIR', '${FEEDBACK_TOOL_DIR', '/examples', ':/vibe', 'PROJECT_ROOTS:', '${HOME}/code']) {
    expect(compose, gone).not.toContain(gone);
  }
  // The api saves the roots chosen in Settings in a folder of its own, never next to the worker's database or logins.
  const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  postgres:'));
  expect(api).toContain('- ./state/settings:/settings');
  expect(api).toContain('ROOTS_FILE: /settings/project-roots.json');
  expect(api).not.toContain('./state:/state');
});
