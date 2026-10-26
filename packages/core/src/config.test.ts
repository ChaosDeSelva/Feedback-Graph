import { expect, test } from 'vitest';
import { ConfigError, loadConfig, OPERATOR_VERBS, redactUrl } from './config.ts';

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

test('Ollama generation limits and timeout default sanely, can be tuned, and bad values are named', () => {
  expect(loadConfig(base).ollama).toMatchObject({ numPredict: null, numCtx: 16384, repeatPenalty: 1.1, timeoutSeconds: null });
  expect(loadConfig({ ...base, OLLAMA_NUM_PREDICT: '4096', OLLAMA_NUM_CTX: '32768', OLLAMA_REPEAT_PENALTY: '1.2', OLLAMA_TIMEOUT_SECONDS: '300' }).ollama)
    .toMatchObject({ numPredict: 4096, numCtx: 32768, repeatPenalty: 1.2, timeoutSeconds: 300 });
  expect(() => loadConfig({ ...base, OLLAMA_NUM_CTX: '100' })).toThrow(/OLLAMA_NUM_CTX must be a number of at least 512/);
  expect(() => loadConfig({ ...base, OLLAMA_NUM_PREDICT: 'lots' })).toThrow(/OLLAMA_NUM_PREDICT must be a number of at least 1/);
  expect(() => loadConfig({ ...base, OLLAMA_REPEAT_PENALTY: '0' })).toThrow(/OLLAMA_REPEAT_PENALTY must be a number of at least 0\.01/);
  expect(() => loadConfig({ ...base, OLLAMA_TIMEOUT_SECONDS: '0' })).toThrow(/OLLAMA_TIMEOUT_SECONDS must be a number of at least 1/);
});

test('SCAN_MAX_FILES unset scales with the repo (null); set, it is a fixed cap; SCAN_CONCURRENCY defaults to 2', () => {
  expect(loadConfig(base).scanMaxFiles).toBeNull();
  expect(loadConfig({ ...base, SCAN_MAX_FILES: '4000' }).scanMaxFiles).toBe(4000);
  expect(() => loadConfig({ ...base, SCAN_MAX_FILES: 'lots' })).toThrow(/SCAN_MAX_FILES/);
  expect(loadConfig(base).scanConcurrency).toBe(2);
  expect(loadConfig({ ...base, SCAN_CONCURRENCY: '4' }).scanConcurrency).toBe(4);
  expect(() => loadConfig({ ...base, SCAN_CONCURRENCY: '0' })).toThrow(/SCAN_CONCURRENCY/);
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

test('session summaries default to the local model, can be tuned, and can be turned off', () => {
  expect(loadConfig(base).summary).toEqual({ enabled: true, llm: null, quietMinutes: 10, maxDeltaTurns: 40, idleMinutes: 30, backfillPerCycle: 3 });
  const c = loadConfig({ ...base, SUMMARY_LLM: 'anthropic:claude-haiku', SUMMARY_QUIET_MINUTES: '5', SUMMARY_MAX_DELTA_TURNS: '20', SESSION_IDLE_MINUTES: '60', SUMMARY_BACKFILL_PER_CYCLE: '0' });
  expect(c.summary).toEqual({ enabled: true, llm: 'anthropic:claude-haiku', quietMinutes: 5, maxDeltaTurns: 20, idleMinutes: 60, backfillPerCycle: 0 });
  expect(loadConfig({ ...base, SUMMARY_LLM: 'off' }).summary).toMatchObject({ enabled: false, llm: null });
  expect(() => loadConfig({ ...base, SUMMARY_LLM: 'gpt' })).toThrow(/SUMMARY_LLM: unknown provider/);
  expect(() => loadConfig({ ...base, SUMMARY_QUIET_MINUTES: '45' })).toThrow(/SESSION_IDLE_MINUTES \(30\) must be at least SUMMARY_QUIET_MINUTES \(45\)/);
  expect(() => loadConfig({ ...base, SUMMARY_LLM: 'codex-cli' })).toThrow(/SUMMARY_LLM.*ALLOW_UNCONFINED_CODEX=1/);
});

test('every problem is reported at once, by name', () => {
  try {
    loadConfig({ PROJECT_ROOTS: '/vibe', POLL_SECONDS: 'soon', CLASSIFY_LLM: 'gpt5', GITHUB_REPOS: 'demo' });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const msg = (e as Error).message;
    for (const name of ['NEO4J_PASSWORD', 'HOST_PROJECT_ROOTS', 'POLL_SECONDS', 'CLASSIFY_LLM', 'GITHUB_REPOS']) expect(msg).toContain(name);
  }
});

test('no project roots is a valid setup: nothing is mounted until you add a folder in Settings', () => {
  const c = loadConfig({ NEO4J_PASSWORD: 'pw' });
  expect(c.roots).toEqual([]);
  expect(loadConfig({ NEO4J_PASSWORD: 'pw', PROJECT_ROOTS: '', HOST_PROJECT_ROOTS: '' }).roots).toEqual([]);
  expect(c.rootsFile).toBeNull();
  expect(c.hostHome).toBeNull();
});

test('ROOTS_FILE is where Settings saves the roots, HOST_HOME is never suggested as one', () => {
  const c = loadConfig({ ...base, ROOTS_FILE: '/settings/project-roots.json', HOST_HOME: '/Users/a' });
  expect(c.rootsFile).toBe('/settings/project-roots.json');
  expect(c.hostHome).toBe('/Users/a');
});

test('GitHub and Linear tokens can come from Settings: GITHUB_REPOS needs no GITHUB_TOKEN; sync paces have defaults', () => {
  const c = loadConfig({ ...base, GITHUB_REPOS: 'demo=me/demo' });
  expect([...c.github.repos]).toEqual([['demo', 'me/demo']]);
  expect(c.github.syncHours).toBe(6);
  expect(c.integrationSyncMinutes).toBe(10);
  expect(loadConfig({ ...base, INTEGRATION_SYNC_MINUTES: '30' }).integrationSyncMinutes).toBe(30);
});

test('GITHUB_BOT_LOGINS and GITHUB_AGENT_LOGINS are comma lists, lower-cased, empty by default', () => {
  expect(loadConfig(base).github).toMatchObject({ botLogins: [], agentLogins: [] });
  const c = loadConfig({ ...base, GITHUB_BOT_LOGINS: 'Docs-Check, acme-ci', GITHUB_AGENT_LOGINS: 'review-agent' });
  expect(c.github.botLogins).toEqual(['docs-check', 'acme-ci']);
  expect(c.github.agentLogins).toEqual(['review-agent']);
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

test('CLOUD_MACHINE names this machine to the cloud (a label for provenance); a bad one is refused, never echoed whole', () => {
  const on = { ...base, CLOUD_URL: 'https://cloud.example.com', CLOUD_TOKEN: TOKEN };
  expect(loadConfig({ ...on, CLOUD_MACHINE: ' work-laptop ' }).cloud!.machine).toBe('work-laptop');
  expect(loadConfig({ ...on, CLOUD_MACHINE: '' }).cloud!.machine).toBeNull();
  expect(() => loadConfig({ ...on, CLOUD_MACHINE: 'bad name\nx' })).toThrow(/CLOUD_MACHINE/);
  expect(() => loadConfig({ ...on, CLOUD_MACHINE: 'x'.repeat(65) })).toThrow(/CLOUD_MACHINE/);
});

test('cloud sync is off unless CLOUD_URL and CLOUD_TOKEN are both set', () => {
  expect(loadConfig(base).cloud).toBeNull();
  const c = loadConfig({ ...base, CLOUD_URL: 'https://cloud.example.com/', CLOUD_TOKEN: TOKEN });
  expect(c.cloud).toEqual({ url: 'https://cloud.example.com', token: TOKEN, intervalMinutes: null, projects: [], suggestions: false, machine: null });
  expect(loadConfig({ ...base, CLOUD_URL: 'http://localhost:8788', CLOUD_TOKEN: TOKEN, SYNC_INTERVAL_MINUTES: '60', SYNC_PROJECTS: 'shop, api', SYNC_SUGGESTIONS: ' TRUE ' }).cloud)
    .toEqual({ url: 'http://localhost:8788', token: TOKEN, intervalMinutes: 60, projects: ['shop', 'api'], suggestions: true, machine: null });
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

test('plain http is allowed for a cloud on this machine only: loopback, or the host as the containers see it', () => {
  // host.docker.internal: inside the api and worker containers, localhost is the container itself.
  for (const url of ['http://localhost:8788', 'http://127.0.0.1:9000', 'http://[::1]:8788', 'http://host.docker.internal:8788', 'http://HOST.docker.internal:8788']) {
    expect(loadConfig({ ...base, CLOUD_URL: url, CLOUD_TOKEN: TOKEN }).cloud?.url).toBe(url);
  }
  for (const url of ['http://host.docker.internal.example.com:8788', 'http://docker.internal:8788', 'http://cloud.example.com']) {
    expect(() => loadConfig({ ...base, CLOUD_URL: url, CLOUD_TOKEN: TOKEN })).toThrow(/https.*localhost or host\.docker\.internal/);
  }
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

test('an operator token lets agents make owner decisions; unset, there is none, and it must be long enough', () => {
  expect(loadConfig(base).operator).toBeNull();
  expect(loadConfig({ ...base, FG_OPERATOR_TOKEN: '   ' }).operator).toBeNull();
  expect(() => loadConfig({ ...base, FG_OPERATOR_TOKEN: 'short' })).toThrow(/FG_OPERATOR_TOKEN.*24/);
  const op = loadConfig({ ...base, FG_OPERATOR_TOKEN: 'o'.repeat(32) }).operator!;
  expect(op.token).toBe('o'.repeat(32));
  // By default not deciding lessons (what agents learn stays the owner's call), nor anything that deletes data, changes
  // what is mounted, imports lessons from a file, or touches integration keys.
  const off = ['lesson_decide', 'delete_project', 'docs_delete', 'settings', 'import', 'integrations', 'chat', 'chat_delete', 'select_projects', 'links_delete'];
  // Which folders are read is the owner's opt-in; removing a link the owner decided is the owner's too.
  expect(op.allow).not.toContain('select_projects');
  expect(op.allow).not.toContain('links_delete');
  expect(op.allow).toContain('links');
  // Asking in Ask spends the owner's Claude or Codex subscription: off unless OPERATOR_ALLOW names it.
  expect(op.allow).not.toContain('chat');
  expect(loadConfig({ ...base, FG_OPERATOR_TOKEN: 'o'.repeat(32), OPERATOR_ALLOW: 'scan,chat' }).operator!.allow).toContain('chat');
  expect(op.allow).toEqual(OPERATOR_VERBS.filter((v) => !off.includes(v)));
  // Cleaning up after a test run deletes only what that run wrote: on by default.
  expect(op.allow).toContain('run_cleanup');
});

test('OPERATOR_ALLOW narrows (or widens) what the operator token may do, and names only known verbs', () => {
  const t = 'o'.repeat(32);
  expect(loadConfig({ ...base, FG_OPERATOR_TOKEN: t, OPERATOR_ALLOW: 'scan, inbox_decide' }).operator!.allow).toEqual(['scan', 'inbox_decide']);
  expect(loadConfig({ ...base, FG_OPERATOR_TOKEN: t, OPERATOR_ALLOW: 'all' }).operator!.allow).toEqual([...OPERATOR_VERBS]);
  expect(loadConfig({ ...base, FG_OPERATOR_TOKEN: t, OPERATOR_ALLOW: 'scan,lesson_decide' }).operator!.allow).toContain('lesson_decide');
  expect(() => loadConfig({ ...base, FG_OPERATOR_TOKEN: t, OPERATOR_ALLOW: 'scan,approve_everything' })).toThrow(/OPERATOR_ALLOW.*approve_everything/);
  // The operator token and the API token are different secrets.
  expect(() => loadConfig({ ...base, FG_OPERATOR_TOKEN: t, API_TOKEN: t })).toThrow(/FG_OPERATOR_TOKEN.*API_TOKEN/);
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

test('CHAT_LLM sets the default model of Ask conversations; unset, the worker picks one from the logins it has', () => {
  expect(loadConfig(base).llm.chat).toBeNull();
  expect(loadConfig({ ...base, CHAT_LLM: 'claude-cli:opus' }).llm.chat).toBe('claude-cli:opus');
  expect(loadConfig({ ...base, CHAT_LLM: 'ollama:gemma4' }).llm.chat).toBe('ollama:gemma4');
  expect(() => loadConfig({ ...base, CHAT_LLM: 'gpt5' })).toThrow(/CHAT_LLM: unknown provider/);
  expect(() => loadConfig({ ...base, CHAT_LLM: 'jev' })).toThrow(/CHAT_LLM: jev is a classification model/);
});

test('codex-cli for a worker job needs the owner to accept that it is not confined', () => {
  for (const k of ['POSTMORTEM_LLM', 'SCAN_LLM', 'CLASSIFY_LLM', 'SUMMARY_LLM', 'CHAT_LLM']) {
    expect(() => loadConfig({ ...base, [k]: 'codex-cli:gpt-5' })).toThrow(new RegExp(`${k}.*ALLOW_UNCONFINED_CODEX=1`));
    expect(() => loadConfig({ ...base, [k]: 'codex-cli', ALLOW_UNCONFINED_CODEX: '1' })).not.toThrow();
  }
});

test('codex-cli needs no acknowledgement when it runs in the codex-runner sidecar', () => {
  for (const k of ['POSTMORTEM_LLM', 'SCAN_LLM', 'CLASSIFY_LLM', 'SUMMARY_LLM']) {
    expect(() => loadConfig({ ...base, [k]: 'codex-cli', CODEX_RUNNER_URL: 'http://codex-runner:8790' })).not.toThrow();
  }
  expect(() => loadConfig({ ...base, CODEX_RUNNER_URL: 'codex-runner:8790' })).toThrow(/CODEX_RUNNER_URL must be http/);
  expect(() => loadConfig({ ...base, CODEX_RUNNER_URL: 'not a url' })).toThrow(/CODEX_RUNNER_URL is not a URL/);
  expect(() => loadConfig({ ...base, CODEX_RUNNER_URL: 'http://u:p@codex-runner:8790' })).toThrow(/user name or password/);
});

test('CHECK_LLM refuses the CLI providers: the api judges check_before_done and has no agent CLIs', () => {
  for (const v of ['claude-cli', 'claude-cli:opus', 'codex-cli', 'codex-cli:gpt-5']) {
    expect(() => loadConfig({ ...base, CHECK_LLM: v, ALLOW_UNCONFINED_CODEX: '1', CODEX_RUNNER_URL: 'http://codex-runner:8790' })).toThrow(/CHECK_LLM: claude-cli and codex-cli run in the worker/);
  }
  for (const v of ['ollama:gemma4', 'anthropic:claude-haiku-5-5', 'openai:gpt-5-nano']) expect(loadConfig({ ...base, CHECK_LLM: v }).llm.check).toBe(v);
});

test('STORE=postgres with the bundled service and an empty POSTGRES_PASSWORD is refused with the fix named', () => {
  // docker-compose.yml builds this URL from POSTGRES_PASSWORD; left empty, the password part is empty.
  expect(() => loadConfig({ PROJECT_ROOTS: '/vibe', STORE: 'postgres', DATABASE_URL: 'postgres://fg:@postgres:5432/feedback' })).toThrow(/POSTGRES_PASSWORD is empty/);
  // Your own server may authenticate another way: no password is not an error there.
  expect(loadConfig({ PROJECT_ROOTS: '/vibe', HOST_PROJECT_ROOTS: '/h', STORE: 'postgres', DATABASE_URL: 'postgres://fg@db.internal:5432/feedback' }).postgres).not.toBeNull();
});
