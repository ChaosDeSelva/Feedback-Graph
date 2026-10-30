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

test('the project name is FG_INSTANCE, defaulting to the name every earlier install has (so their volumes keep their names)', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  expect(compose).toMatch(/^name: \$\{FG_INSTANCE:-feedback-graph\}$/m);
  // Only the project name prefixes containers and volumes: nothing pins its own name across installs.
  expect(compose).not.toMatch(/^\s+container_name:/m);
  expect(compose).not.toMatch(/^\s+name: /m);
});

test('docker-compose.yml mounts no project folder: the roots come only from the override setup.sh generates', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  for (const gone of ['${PROJECTS_DIR', '${FEEDBACK_TOOL_DIR', '/examples', ':/vibe', 'PROJECT_ROOTS:', '${HOME}/code']) {
    expect(compose, gone).not.toContain(gone);
  }
  // The api saves the roots chosen in Settings in a folder of its own, never next to the worker's database or logins.
  const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  postgres:'));
  expect(api).toContain('- ./state/api-settings:/api-settings');
  expect(api).toContain('- ./state/settings/redaction-archive:/redaction-archive');
  expect(api).not.toContain('- ./state/settings:/settings');
  expect(api).toContain('ROOTS_FILE: /api-settings/project-roots.json');
  expect(api).not.toContain('./state:/state');
});

test('the api and the worker run with no Linux capabilities and cannot gain privileges', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  const service = (name: string, next: string) => compose.slice(compose.indexOf(`\n  ${name}:`), compose.indexOf(`\n  ${next}:`));
  for (const s of [service('worker', 'codex-runner'), service('api', 'postgres')]) {
    expect(s).toContain('cap_drop: [ALL]');
    expect(s).toContain('- no-new-privileges:true');
  }
});

test('the api and the worker run on a read-only file system, with memory for /tmp (and the worker for $HOME)', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  const service = (name: string, next: string) => compose.slice(compose.indexOf(`\n  ${name}:`), compose.indexOf(`\n  ${next}:`));
  const worker = service('worker', 'codex-runner');
  const api = service('api', 'postgres');
  for (const s of [worker, api]) {
    expect(s).toContain('read_only: true');
    expect(s).toMatch(/tmpfs:\n\s+- \/tmp\n/);
  }
  // The agent CLIs keep their settings in HOME: the image's (Dockerfile ENV HOME), so the worker can still write it.
  const home = /ENV .*HOME=(\S+)/.exec(readFileSync(join(repo, 'Dockerfile'), 'utf8'))![1];
  expect(worker).toContain(`- ${home}\n`);
  // What the worker writes besides: its volumes.
  for (const v of ['./state:/state', 'codex-home:/codex', 'codex-scratch:/scratch']) expect(worker).toContain(v);
});

test('neo4j keeps only the capabilities its entrypoint needs and cannot gain privileges', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  const neo4j = compose.slice(compose.indexOf('\n  neo4j:'), compose.indexOf('\n  worker:'));
  expect(neo4j).toContain('cap_drop: [ALL]');
  expect(neo4j).toContain('cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]');
  expect(neo4j).toContain('- no-new-privileges:true');
});

test('docker-compose.yml comments do not contradict the settings they describe', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  // CLOUD_URL allows plain http to this machine and to the host as the containers see it; SCAN_MAX_FILES scales.
  expect(compose).not.toContain('plain http only to localhost');
  expect(compose).not.toMatch(/400 files, 80000 bytes/);
});

test('the bundled ollama publishes on OLLAMA_PORT (11435 by default), so a second install can move it', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  const ollama = compose.slice(compose.indexOf('\n  ollama:'), compose.indexOf('\nvolumes:'));
  expect(ollama).toContain('- "127.0.0.1:${OLLAMA_PORT:-11435}:11434"');
  expect(readFileSync(join(repo, '.env.example'), 'utf8')).toMatch(/^OLLAMA_PORT=$/m);
});

test('external container images use immutable manifest digests in production and verification', () => {
  for (const file of ['Dockerfile', 'docker-compose.yml', 'docker-compose.test.yml', '.github/workflows/ci.yml']) {
    const source = readFileSync(join(repo, file), 'utf8');
    const images = [...source.matchAll(/(?:^FROM |^\s+image:\s*)([^\s]+)/gm)].map(m => m[1]);
    for (const image of images.filter(x => x.includes(':'))) expect(image, `${file}: ${image}`).toMatch(/@sha256:[0-9a-f]{64}$/);
  }
});


test('archive volume initialization creates its private directory before chown so Docker cannot overwrite fresh HOST_UID ownership by copy-up', () => {
  const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
  const init = compose.slice(compose.indexOf('  archive-key-init:'), compose.indexOf('  worker:'));
  expect(init.indexOf('mkdir -p /redaction-key/private')).toBeGreaterThan(0);
  expect(init.indexOf('mkdir -p /redaction-key/private')).toBeLessThan(init.indexOf('chown -hR'));
  expect(init).toContain('[ ! -L /redaction-key/private ] || exit 1');
});
