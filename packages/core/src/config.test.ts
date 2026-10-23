import { expect, test } from 'vitest';
import { ConfigError, loadConfig, redactUrl } from './config.ts';

const base = { NEO4J_PASSWORD: 'pw', PROJECT_ROOTS: '/vibe,/examples', HOST_PROJECT_ROOTS: '/Users/a/Vibe,/Users/a/fb/examples' };

test('defaults fill in everything optional', () => {
  const c = loadConfig(base);
  expect(c.neo4j).toEqual({ url: 'bolt://neo4j:7687', user: 'neo4j', password: 'pw' });
  expect(c.roots).toEqual([{ container: '/vibe', host: '/Users/a/Vibe' }, { container: '/examples', host: '/Users/a/fb/examples' }]);
  expect(c.pollSeconds).toBe(30);
  expect(c.ingestProjects).toEqual([]);
  expect(c.excludeProjects).toEqual([]);
  expect(c.turnRetentionDays).toBeNull();
  expect(c.apiToken).toBeNull();
  expect(c.codexSessionsDir).toBe('/codex-sessions');
});

test('CODEX_SESSIONS_DIR points the worker at another Codex sessions folder', () => {
  expect(loadConfig({ ...base, CODEX_SESSIONS_DIR: '/elsewhere' }).codexSessionsDir).toBe('/elsewhere');
});

test('feedback memories are imported as proposed lessons unless MEMORY_AUTO_APPROVE=true', () => {
  expect(loadConfig(base).memoryAutoApprove).toBe(false);
  expect(loadConfig({ ...base, MEMORY_AUTO_APPROVE: 'true' }).memoryAutoApprove).toBe(true);
  expect(loadConfig({ ...base, MEMORY_AUTO_APPROVE: 'false' }).memoryAutoApprove).toBe(false);
  expect(() => loadConfig({ ...base, MEMORY_AUTO_APPROVE: 'yes please' })).toThrow(/MEMORY_AUTO_APPROVE.*true or false/);
});

test('every problem is reported at once, by name', () => {
  try {
    loadConfig({ PROJECT_ROOTS: '/vibe', POLL_SECONDS: 'soon', CLASSIFY_LLM: 'gpt5', GITHUB_REPOS: 'demo=me/demo' });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const msg = (e as Error).message;
    for (const name of ['NEO4J_PASSWORD', 'HOST_PROJECT_ROOTS', 'POLL_SECONDS', 'CLASSIFY_LLM', 'GITHUB_TOKEN']) expect(msg).toContain(name);
  }
});

test('host and container roots must pair up', () => {
  expect(() => loadConfig({ ...base, HOST_PROJECT_ROOTS: '/Users/a/Vibe' })).toThrow(/HOST_PROJECT_ROOTS.*2/);
});

test('a public host name needs a token, and a token must be long enough to resist guessing', () => {
  expect(() => loadConfig({ ...base, PUBLIC_HOSTS: 'fg.corp.example' })).toThrow(/PUBLIC_HOSTS.*API_TOKEN/);
  expect(() => loadConfig({ ...base, API_TOKEN: 'short' })).toThrow(/API_TOKEN.*24/);
  expect(loadConfig({ ...base, API_TOKEN: 'x'.repeat(32), PUBLIC_HOSTS: 'fg.corp.example' }).publicHosts).toEqual(['fg.corp.example']);
});

test('model specs are checked for a known provider', () => {
  for (const ok of ['ollama:gemma4', 'claude-cli', 'claude-cli:opus', 'codex-cli', 'openai:gpt-5-nano', 'anthropic:claude-haiku-5-5', 'openrouter:x/y', 'groq:llama']) {
    expect(() => loadConfig({ ...base, SCAN_LLM: ok, ALLOW_UNCONFINED_CODEX: '1' })).not.toThrow();
  }
  expect(() => loadConfig({ ...base, SCAN_LLM: 'jev' })).toThrow(/SCAN_LLM.*classification/);
});

test('project lists and retention parse', () => {
  const c = loadConfig({ ...base, INGEST_PROJECTS: ' a, b ,', EXCLUDE_PROJECTS: 'secret-client', TURN_RETENTION_DAYS: '90' });
  expect(c.ingestProjects).toEqual(['a', 'b']);
  expect(c.excludeProjects).toEqual(['secret-client']);
  expect(c.turnRetentionDays).toBe(90);
});

test('the store is Neo4j unless STORE says otherwise', () => {
  const c = loadConfig(base);
  expect(c.store).toBe('neo4j');
  expect(c.postgres).toBeNull();
});

test('STORE=postgres needs DATABASE_URL and not NEO4J_PASSWORD', () => {
  const c = loadConfig({ PROJECT_ROOTS: '/vibe', HOST_PROJECT_ROOTS: '/h', STORE: 'postgres', DATABASE_URL: 'postgres://fg:s3cret@postgres:5432/feedback' });
  expect(c.store).toBe('postgres');
  expect(c.postgres).toEqual({ url: 'postgres://fg:s3cret@postgres:5432/feedback' });
  expect(c.neo4j).toBeNull();
  expect(() => loadConfig({ PROJECT_ROOTS: '/vibe', STORE: 'postgres' })).toThrow(/DATABASE_URL is required when STORE=postgres/);
});

test('a bad STORE or DATABASE_URL is reported with every other problem, without the password', () => {
  try {
    loadConfig({ PROJECT_ROOTS: '/vibe', STORE: 'mysql', POLL_SECONDS: 'soon' });
    expect.unreachable();
  } catch (e) {
    const msg = (e as Error).message;
    expect(msg).toMatch(/STORE.*neo4j, postgres/);
    expect(msg).toContain('POLL_SECONDS');
  }
  for (const bad of ['mysql://fg:hunter2pw@db/feedback', 'postgres://fg:hunter2pw@db', 'not a url hunter2pw']) {
    try {
      loadConfig({ PROJECT_ROOTS: '/vibe', STORE: 'postgres', DATABASE_URL: bad, POLL_SECONDS: 'soon' });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('POLL_SECONDS');
      expect(msg).not.toContain('hunter2pw');
    }
  }
});

test('STORE is case-insensitive and ignores NEO4J settings on Postgres', () => {
  const c = loadConfig({ PROJECT_ROOTS: '/vibe', HOST_PROJECT_ROOTS: '/h', STORE: ' Postgres ', DATABASE_URL: 'postgresql://fg@localhost/fg', NEO4J_PASSWORD: 'pw' });
  expect(c.store).toBe('postgres');
  expect(c.neo4j).toBeNull();
});

test('redactUrl hides a connection string password', () => {
  expect(redactUrl('postgres://fg:s3cret@db:5432/feedback')).toBe('postgres://fg:***@db:5432/feedback');
  expect(redactUrl('postgres://fg@db/feedback')).toBe('postgres://fg@db/feedback');
  expect(redactUrl('nonsense s3cret')).toBe('(unparseable URL)');
});

const TOKEN = `fgc_pat_0123456789abcdef_${'A'.repeat(43)}`;

test('cloud sync is off unless CLOUD_URL and CLOUD_TOKEN are both set', () => {
  expect(loadConfig(base).cloud).toBeNull();
  const c = loadConfig({ ...base, CLOUD_URL: 'https://cloud.example.com/', CLOUD_TOKEN: TOKEN });
  expect(c.cloud).toEqual({ url: 'https://cloud.example.com', token: TOKEN, intervalMinutes: null, projects: [], suggestions: false });
  expect(loadConfig({ ...base, CLOUD_URL: 'http://localhost:8788', CLOUD_TOKEN: TOKEN, SYNC_INTERVAL_MINUTES: '60', SYNC_PROJECTS: 'shop, api', SYNC_SUGGESTIONS: ' TRUE ' }).cloud)
    .toEqual({ url: 'http://localhost:8788', token: TOKEN, intervalMinutes: 60, projects: ['shop', 'api'], suggestions: true });
  expect(loadConfig({ ...base, CLOUD_URL: 'https://cloud.example.com', CLOUD_TOKEN: TOKEN, SYNC_SUGGESTIONS: 'false' }).cloud?.suggestions).toBe(false);
  // Off without a cloud is simply off.
  expect(loadConfig({ ...base, SYNC_SUGGESTIONS: 'false' }).cloud).toBeNull();
});

test('cloud settings are checked with everything else, and the token is never echoed', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ CLOUD_URL: 'https://cloud.example.com' }, /CLOUD_TOKEN is required/],
    [{ CLOUD_TOKEN: TOKEN }, /CLOUD_URL is required/],
    [{ CLOUD_URL: 'http://cloud.example.com', CLOUD_TOKEN: TOKEN }, /CLOUD_URL must be https/],
    [{ CLOUD_URL: 'https://me:pw@cloud.example.com', CLOUD_TOKEN: TOKEN }, /CLOUD_URL must not carry a user name or password/],
    [{ CLOUD_URL: 'not a url', CLOUD_TOKEN: TOKEN }, /CLOUD_URL is not a URL/],
    [{ CLOUD_URL: 'https://cloud.example.com', CLOUD_TOKEN: 'fgc_pat_nope' }, /CLOUD_TOKEN is not a Feedback Graph Cloud token/],
    [{ CLOUD_URL: 'https://cloud.example.com', CLOUD_TOKEN: TOKEN, SYNC_INTERVAL_MINUTES: '1' }, /SYNC_INTERVAL_MINUTES must be a number of at least 5/],
    [{ SYNC_INTERVAL_MINUTES: '60' }, /SYNC_INTERVAL_MINUTES needs CLOUD_URL and CLOUD_TOKEN/],
    [{ SYNC_PROJECTS: 'shop' }, /SYNC_PROJECTS needs CLOUD_URL and CLOUD_TOKEN/],
    [{ CLOUD_URL: 'https://cloud.example.com', CLOUD_TOKEN: TOKEN, SYNC_SUGGESTIONS: 'yes' }, /SYNC_SUGGESTIONS must be true or false/],
    [{ SYNC_SUGGESTIONS: 'maybe' }, /SYNC_SUGGESTIONS must be true or false/],
    [{ SYNC_SUGGESTIONS: 'true' }, /SYNC_SUGGESTIONS needs CLOUD_URL and CLOUD_TOKEN/],
  ];
  for (const [env, re] of cases) {
    try {
      loadConfig({ ...base, ...env, POLL_SECONDS: 'soon' });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(re);
      expect(msg).toContain('POLL_SECONDS');
      expect(msg).not.toContain('A'.repeat(43));
    }
  }
});

test('plain http is allowed for a cloud on this machine only', () => {
  for (const url of ['http://localhost:8788', 'http://127.0.0.1:9000', 'http://[::1]:8788']) {
    expect(loadConfig({ ...base, CLOUD_URL: url, CLOUD_TOKEN: TOKEN }).cloud?.url).toBe(url);
  }
  expect(() => loadConfig({ ...base, CLOUD_URL: 'http://host.docker.internal:8788', CLOUD_TOKEN: TOKEN })).toThrow(/https/);
});

test('redactUrl hides a password passed as a query parameter too (pg reads ?password=)', () => {
  expect(redactUrl('postgres://fg@db:5432/fg?password=hunter2')).toBe('postgres://fg@db:5432/fg?password=***');
  expect(redactUrl('postgres://fg@db/fg?sslmode=require&sslpassword=k3y&PASSWORD=x')).toBe('postgres://fg@db/fg?sslmode=require&sslpassword=***&PASSWORD=***');
  expect(redactUrl('postgres://fg:a@db/fg?application_name=fg')).toBe('postgres://fg:***@db/fg?application_name=fg');
});

test('a misspelled DATABASE_URL scheme is reported without a query-string password', () => {
  expect(() => loadConfig({ ...base, STORE: 'postgres', DATABASE_URL: 'postgress://fg@db/fg?password=hunter2' })).toThrow(/password=\*\*\*/);
  try {
    loadConfig({ ...base, STORE: 'postgres', DATABASE_URL: 'postgress://fg@db/fg?password=hunter2' });
  } catch (e) {
    expect((e as Error).message).not.toContain('hunter2');
  }
});

test('the API refuses to listen beyond this machine without a token', () => {
  expect(loadConfig(base).apiBind).toBe('127.0.0.1');
  for (const bind of ['0.0.0.0', '::', '192.168.1.20', 'fg.lan']) {
    expect(() => loadConfig({ ...base, API_BIND: bind })).toThrow(/API_BIND.*API_TOKEN/);
    expect(loadConfig({ ...base, API_BIND: bind, API_TOKEN: 'x'.repeat(32) }).apiBind).toBe(bind);
  }
  for (const bind of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]']) expect(loadConfig({ ...base, API_BIND: bind }).apiBind).toBe(bind);
  // Inside a container the server listens on every interface; API_BIND (where compose publishes it) is the exposure.
  expect(loadConfig({ ...base, API_LISTEN: '0.0.0.0' })).toMatchObject({ apiBind: '127.0.0.1', apiListen: '0.0.0.0' });
  expect(loadConfig({ ...base, API_BIND: '127.0.0.1' }).apiListen).toBe('127.0.0.1');
});

test('codex-cli for a worker job needs the owner to accept that it is not confined', () => {
  for (const k of ['POSTMORTEM_LLM', 'SCAN_LLM', 'CLASSIFY_LLM']) {
    expect(() => loadConfig({ ...base, [k]: 'codex-cli:gpt-5' })).toThrow(new RegExp(`${k}.*ALLOW_UNCONFINED_CODEX=1`));
    expect(() => loadConfig({ ...base, [k]: 'codex-cli', ALLOW_UNCONFINED_CODEX: '1' })).not.toThrow();
  }
  // The api never runs a CLI provider (it falls back to the local model), so CHECK_LLM is not refused.
  expect(() => loadConfig({ ...base, CHECK_LLM: 'codex-cli' })).not.toThrow();
});

test('STORE=postgres with the bundled service and an empty POSTGRES_PASSWORD is refused with the fix named', () => {
  // docker-compose.yml builds this URL from POSTGRES_PASSWORD; left empty, the password part is empty.
  expect(() => loadConfig({ PROJECT_ROOTS: '/vibe', STORE: 'postgres', DATABASE_URL: 'postgres://fg:@postgres:5432/feedback' })).toThrow(/POSTGRES_PASSWORD is empty/);
  // Your own server may authenticate another way: no password is not an error there.
  expect(loadConfig({ PROJECT_ROOTS: '/vibe', HOST_PROJECT_ROOTS: '/h', STORE: 'postgres', DATABASE_URL: 'postgres://fg@db.internal:5432/feedback' }).postgres).not.toBeNull();
});
