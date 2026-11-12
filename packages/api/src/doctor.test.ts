import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });

// scripts/doctor.sh, run on a copy with a throwaway HOME and stand-ins for docker, nc and curl, so each check can be made
// to pass or fail without Docker, Ollama or the stack.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

type World = {
  dockerUp?: boolean;
  shellUrl?: string;
  memory?: { used: number; limit: number; swap: number };
  runnerSandbox?: boolean;
  /** What the runner's failed sandbox probe says (a procfs mount error by default). */
  runnerError?: string;
  /** docker compose ps --format '{{.Service}} {{.Ports}}': one line per running container (the api on loopback by default). */
  published?: string[];
  /** Other installs setup.sh registered on this machine: each one's .env. */
  installs?: string[];
  /** ~/.codex/auth.json exists (a Codex login on this machine). */
  codexLogin?: boolean;
  /** state/runner-control/codex-runner-disabled, as a previous doctor run left it. */
  runnerFlag?: string;
  /** Ports something listens on, and which of them this stack publishes. */
  listening?: number[];
  ours?: number[];
  running?: string[];
  ollama?: boolean;
  tags?: string;
  chat?: { code: number; body: string };
  dnsInWorker?: boolean;
  transcripts?: number;
  status?: object | null;
  env?: string;
  /** docker compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}': every container, running or not. */
  states?: string[];
  /** docker compose logs <service>, per service. */
  logs?: Record<string, string>;
  /** Compose projects Docker has containers of, and the folder each was started from (HERE: the folder checked). */
  composed?: { project: string; dir: string }[];
};

const BOTH = '{"models":[{"name":"gemma4:latest"},{"name":"nomic-embed-text:latest"}]}';
const OK_CHAT = { code: 200, body: JSON.stringify({ message: { content: '{"ok": true}' } }) };
const conn = (state: string, detail: string) => ({ state, source: 'env', detail, href: '#settings/integrations' });

async function doctor(w: World = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fbdoctor-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), home, bin]) mkdirSync(d, { recursive: true });
  for (const f of ['scripts/doctor.sh', 'scripts/lib/env.sh', 'scripts/lib/ollama.sh', 'scripts/lib/restore-journal.sh', 'scripts/lib/state-fs.sh']) copyFileSync(join(repoRoot, f), join(repo, f));
  writeFileSync(join(repo, '.env'), w.env ?? 'API_PORT=8787\n');
  if (w.codexLogin) {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  }
  (w.installs ?? []).forEach((env, i) => {
    const dir = join(base, `install-${i}`);
    mkdirSync(dir);
    writeFileSync(join(dir, '.env'), env);
    mkdirSync(join(home, '.local', 'state', 'feedback-graph', 'installs'), { recursive: true });
    writeFileSync(join(home, '.local', 'state', 'feedback-graph', 'installs', String(i)), `${dir}\n`);
  });
  if (w.runnerFlag !== undefined) {
    mkdirSync(join(repo, 'state', 'runner-control'), { recursive: true });
    writeFileSync(join(repo, 'state', 'runner-control', 'codex-runner-disabled'), w.runnerFlag);
  }
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const listening = w.listening ?? [8787, 7476, 7689];
  const ours = w.ours ?? listening;
  const running = w.running ?? ['neo4j', 'worker', 'api'];
  stub('uname', 'echo Darwin');
  stub('nc', `case " ${listening.join(' ')} " in *" $3 "*) exit 0 ;; *) exit 1 ;; esac`);
  writeFileSync(join(base, 'chat'), `${(w.chat ?? OK_CHAT).body}\n${(w.chat ?? OK_CHAT).code}`);
  writeFileSync(join(base, 'status'), w.status === null ? '' : JSON.stringify(w.status ?? {}));
  for (const [svc, text] of Object.entries(w.logs ?? {})) writeFileSync(join(base, `logs-${svc}`), text);
  stub(
    'docker',
    `[ "$1" = info ] && exit ${w.dockerUp === false ? 1 : 0}
case "$*" in
  "ps -a "*)
    p="$(printf '%s\\n' "$@" | sed -n 's/^label=com.docker.compose.project=//p')"
    case "$p" in ${(w.composed ?? []).map((c) => `'${c.project}') echo '${c.dir === 'HERE' ? repo : c.dir}' ;;`).join(' ')} *) ;; esac ;;
  *" ps -a --format "*) printf '%s\\n' ${(w.states ?? running.map((r) => `${r} running 0`)).map((l) => `'${l}'`).join(' ')} ;;
  *" logs "*) svc=$(echo "$*" | awk '{print $NF}'); [ -f '${base}/logs-'"$svc" ] && cat '${base}/logs-'"$svc" ;;
  *" ps --format "*) printf '%s\\n' ${(w.published ?? ['api 127.0.0.1:8787->8787/tcp']).map((l) => `'${l}'`).join(' ')} ;;
  *" ps "*) printf '%s\\n' ${running.map((s) => `'${s}'`).join(' ')} ;;
  *" port "*)
    svc=$(echo "$*" | sed 's/.* port //' | awk '{print $1}'); inner=$(echo "$*" | awk '{print $NF}')
    for p in ${ours.join(' ')}; do
      case "$svc:$inner:$p" in api:8787:8787 | neo4j:7474:7476 | neo4j:7687:7689 | postgres:5432:5434) echo "127.0.0.1:$p"; exit 0 ;; esac
    done; exit 1 ;;
  *"memory.current"*) ${w.memory ? `printf 'memory.current=${w.memory.used}\\nmemory.max=${w.memory.limit}\\nmemory.swap.current=${w.memory.swap}\\n'` : "true"} ;;
  *FG_ISOLATION_TARGETS=*) printf '%s\\n' "$*" | sed -n 's/.*FG_ISOLATION_TARGETS=\\([^ ]*\\).*/\\1/p' >> '${join(base, 'isolation-targets')}'; exit 0 ;;
  *"/health"*) echo "${w.runnerSandbox === false ? (w.runnerError ?? "Can't mount proc /proc: Operation not permitted") : "ok"}"; exit ${w.runnerSandbox === false ? 1 : 0} ;;
  *"dns"*) exit ${w.dnsInWorker === false ? 1 : 0} ;;
  *"OLLAMA_URL"*) exit ${w.ollama === false ? 1 : 0} ;;
  *"/transcripts"*) echo ${w.transcripts ?? 3} ;;
  *"/codex-sessions"*) echo 0 ;;
  *"auth.json"*) exit 1 ;;
esac
exit 0`,
  );
  stub(
    'curl',
    `case "$*" in
  *api/tags*) ${w.ollama === false ? 'exit 7' : `printf '%s' '${w.tags ?? BOTH}'`} ;;
  *api/chat*) printf '%s\n' "$*" >> '${join(base, 'chat-args')}'; cat '${join(base, 'chat')}' ;;
  *api/status*) [ -s '${join(base, 'status')}' ] || exit 7; cat '${join(base, 'status')}' ;;
  */mcp*) printf '%s\n' "$*" >> '${join(base, 'mcp-args')}'; exit 0 ;;
  *) exit 7 ;;
esac`,
  );
  const chatArgs = () => {
    try { return readFileSync(join(base, 'chat-args'), 'utf8'); } catch { return ''; }
  };
  const mcpArgs = () => {
    try { return readFileSync(join(base, 'mcp-args'), 'utf8'); } catch { return ''; }
  };
  const r = await execResult('bash', [join(repo, 'scripts', 'doctor.sh')], { env: { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`, HOME: home, ...(w.shellUrl ? { FEEDBACK_GRAPH_URL: w.shellUrl } : {}) } });
  return { out: r.stdout, code: r.status ?? -1, chatArgs: chatArgs(), mcpArgs: mcpArgs(), targets: existsSync(join(base, 'isolation-targets')) ? readFileSync(join(base, 'isolation-targets'), 'utf8').trim().split(',') : [], runnerDisabled: existsSync(join(repo, 'state/runner-control/codex-runner-disabled')) };
}

test('a healthy install: every check passes, and the exit code is 0', async () => {
  const { out, code } = await doctor({ status: { worker: { lastBeat: new Date().toISOString() }, connections: { github: conn('connected', 'signed in as acme-bot'), linear: conn('not_connected', 'no key yet') } } });
  expect(code).toBe(0);
  expect(out).not.toContain('FAIL');
  for (const line of [
    'PASS  docker: the daemon answers',
    'PASS  port 8787 (api): used by this Feedback Graph',
    'PASS  port 7476 (neo4j): used by this Feedback Graph',
    'PASS  ollama: answers at http://localhost:11434',
    'PASS  ollama: models pulled (gemma4 nomic-embed-text)',
    'PASS  ollama structured output: a schema-constrained call to gemma4 answered with JSON',
    'PASS  host.docker.internal: resolves inside the worker',
    'PASS  ollama from the worker: answers at http://host.docker.internal:11434',
    'PASS  Claude Code transcripts: mounted and readable in the worker (3 entries',
    'WARN  Codex sessions: mounted but empty',
    'PASS  GitHub: signed in as acme-bot',
    'PASS  worker heartbeat: ',
    'SKIP  Linear: not connected (no key yet)',
  ]) expect(out).toContain(line);
});

test('each broken piece is a FAIL line saying how to fix it, and the exit code is 1', async () => {
  const { out, code } = await doctor({
    listening: [8787],
    ours: [],
    tags: '{"models":[{"name":"gemma4:latest"}]}',
    chat: { code: 501, body: JSON.stringify({ error: 'structured output is unavailable' }) },
    dnsInWorker: false,
    status: { connections: { github: conn('error', 'GitHub refused the token (401): create a new one'), linear: conn('not_connected', 'no key yet') } },
  });
  expect(code).toBe(1);
  expect(out).toContain('FAIL  port 8787 (api): used by something else');
  expect(out).toContain('PASS  port 7476 (neo4j): free');
  expect(out).toContain('FAIL  ollama: not pulled: nomic-embed-text');
  expect(out).toContain('FAIL  ollama structured output: refused by this Ollama: {"error":"structured output is unavailable"}');
  expect(out).toContain('official Ollama app');
  expect(out).toContain('FAIL  host.docker.internal: does not resolve inside the worker');
  expect(out).toContain('FAIL  GitHub: GitHub refused the token (401)');
});

test('another folder\'s containers under this folder\'s Compose name: a loud FAIL naming that folder and FG_INSTANCE', async () => {
  const other = await doctor({ composed: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph' }] });
  expect(other.code).toBe(1);
  expect(other.out).toMatch(/FAIL {2}install: the containers named feedback-graph were started from \/srv\/acme\/feedback-graph, not this folder/);
  expect(other.out).toMatch(/docker compose here would take over/);
  expect(other.out).toMatch(/FG_INSTANCE=/);
  // FG_INSTANCE in .env is the name looked up.
  const named = await doctor({ env: 'API_PORT=8787\nFG_INSTANCE=feedback-graph-repo\n', composed: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph' }] });
  expect(named.out).toContain('PASS  install: no other folder runs as feedback-graph-repo');
  const own = await doctor({ composed: [{ project: 'feedback-graph', dir: 'HERE' }] });
  expect(own.code).toBe(0);
  expect(own.out).toContain('PASS  install: feedback-graph runs from this folder');
});

test('Docker down, Ollama down and the api not answering: failures and skips, never a crash', async () => {
  const { out, code } = await doctor({ dockerUp: false, ollama: false, status: null, running: [] });
  expect(code).toBe(1);
  expect(out).toContain('FAIL  docker: installed, but the daemon does not answer');
  expect(out).toContain('FAIL  ollama: does not answer at http://localhost:11434');
  expect(out).toContain('SKIP  containers: Docker does not answer');
  expect(out).toContain('SKIP  GitHub, Linear: the api does not answer');
});

test('the bundled ollama profile is checked on its own host port: OLLAMA_PORT, 11435 when unset', async () => {
  expect((await doctor({ env: 'API_PORT=8787\nOLLAMA_URL=http://ollama:11434\n' })).out).toContain('PASS  ollama: answers at http://localhost:11435');
  expect((await doctor({ env: 'API_PORT=8787\nOLLAMA_URL=http://ollama:11434\nOLLAMA_PORT=11445\n' })).out).toContain('PASS  ollama: answers at http://localhost:11445');
});

test('never prints a secret from .env', async () => {
  const secret = 'q'.repeat(40);
  const { out } = await doctor({
    env: `API_PORT=8787\nAPI_TOKEN=${secret}\nGITHUB_TOKEN=${secret}\nLINEAR_API_KEY=${secret}\nNEO4J_PASSWORD=${secret}\n`,
    status: { connections: { github: conn('connected', 'signed in as acme-bot'), linear: conn('connected', 'signed in as Acme') } },
  });
  expect(out).not.toContain(secret);
  expect(out).toContain('PASS  Linear: signed in as Acme');
});

test('the token MCP probe requests the streamable HTTP response types', async () => {
  const checked = await doctor({ env: `API_PORT=8787\nAPI_TOKEN=${'a'.repeat(32)}\nFG_OWNER_TOKEN=${'b'.repeat(32)}\n`, status: {} });
  expect(checked.code).toBe(0);
  expect(checked.out).toContain('PASS  MCP credential');
  expect(checked.mcpArgs).toContain('Accept: application/json, text/event-stream');
});

test('the classifier on another provider skips the structured-output probe', async () => {
  const { out } = await doctor({ env: 'CLASSIFY_LLM=claude-cli\n', chat: { code: 501, body: '{}' }, status: {} });
  expect(out).toContain('SKIP  ollama structured output: the classifier runs on claude-cli');
});

test('the probe asks for no thinking and the context the workers use, as the real classifier does', async () => {
  const { chatArgs } = await doctor({ env: 'OLLAMA_NUM_CTX=8192\n', status: {} });
  expect(chatArgs).toContain('"think":false');
  expect(chatArgs).toContain('"num_ctx":8192');
  expect((await doctor({ status: {} })).chatArgs).toContain('"num_ctx":16384');
});

test('an answer that is all thinking and no content is a FAIL that says what to do', async () => {
  const thinking = { code: 200, body: JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'Thinking Process: the user wants' } }) };
  const { out, code } = await doctor({ chat: thinking, status: {} });
  expect(code).toBe(1);
  expect(out).toContain('FAIL  ollama structured output: gemma4 answered only in its thinking, with no content');
  expect(out).toMatch(/think:false/);
});


test('configured runner health requires its actual sandbox probe to succeed', async () => {
  const env = 'API_PORT=8787\nCODEX_RUNNER_URL=http://codex-runner:8790\n';
  const failed = await doctor({ env, runnerSandbox: false, running: ['neo4j', 'worker', 'api', 'codex-runner'] });
  expect(failed.code).toBe(1);
  expect(failed.out).toContain('FAIL  Codex runner: sandbox cannot start');
  expect(failed.out).toContain('setup.sh --runner-procfs-compat');
  expect(failed.out).toContain('explicit opt-in removes Docker system-path protection');
  expect(failed.out).toContain("Can't mount proc /proc: Operation not permitted");
  expect(failed.runnerDisabled).toBe(true);
  const healthy = await doctor({ env, runnerSandbox: true, running: ['neo4j', 'worker', 'api', 'codex-runner'] });
  expect(healthy.code).toBe(0);
  expect(healthy.out).toContain('PASS  Codex runner: its nested sandbox starts successfully');
  expect(healthy.runnerDisabled).toBe(false);
});


test('a Codex login that is not mounted is flagged when any job runs on codex-cli, the learning loop\'s included', async () => {
  for (const job of ['CLASSIFY_LLM', 'POSTMORTEM_LLM', 'SCAN_LLM', 'DOCS_LLM', 'CHAT_LLM', 'SUMMARY_LLM', 'LOOP_LLM']) {
    const checked = await doctor({ env: `API_PORT=8787\n${job}=codex-cli\n`, codexLogin: true });
    expect(checked.out, job).toContain('auth.json exists but is not mounted');
  }
  const unused = await doctor({ codexLogin: true });
  expect(unused.out).not.toContain('auth.json exists but is not mounted');
});

test('doctor warns about a shell URL targeting another install and unrestricted operators', async () => {
  const checked = await doctor({ env: 'API_PORT=8797\nOPERATOR_ALLOW=all\n', shellUrl: 'http://localhost:8787' });
  expect(checked.out).toContain('FEEDBACK_GRAPH_URL overrides this install (http://localhost:8797)');
  expect(checked.out).toContain('OPERATOR_ALLOW=all');
});

test('--no-transcripts empty mounts are intentional skips, not warnings about wrong folders', async () => {
  const checked = await doctor({
    env: 'API_PORT=8787\nCLAUDE_PROJECTS_DIR=/install/.host/empty-claude\nCODEX_SESSIONS_DIR=/install/.host/empty-codex\n',
    transcripts: 0,
  });
  expect(checked.out).toContain('SKIP  Claude Code transcripts: intentionally empty (--no-transcripts');
  expect(checked.out).toContain('SKIP  Codex sessions: intentionally empty (--no-transcripts');
  expect(checked.out).not.toContain('folder is set wrong');
  expect(checked.out).not.toContain('FAIL');
});

test('empty transcript folders left in state/ by an older --no-transcripts fail: the worker could swap them for a link', async () => {
  const checked = await doctor({
    env: 'API_PORT=8787\nCLAUDE_PROJECTS_DIR=/install/state/empty-claude\nCODEX_SESSIONS_DIR=/install/state/empty-codex\n',
    transcripts: 0,
  });
  expect(checked.out).toContain('FAIL  transcripts: /install/state/empty-claude is in state/, which the worker can change; run ./scripts/setup.sh');
  expect(checked.out).toContain('FAIL  transcripts: /install/state/empty-codex is in state/');
});

test('doctor reports actual cgroup memory, swap and low headroom', async () => {
  const checked = await doctor({ memory: { used: 950 * 1048576, limit: 1024 * 1048576, swap: 16 * 1048576 } });
  expect(checked.out).toContain('WARN  Neo4j memory: 950 MiB used / 1024 MiB limit; 74 MiB headroom; 16 MiB swap');
});

test('a few KiB of swap with plenty of headroom passes and is shown in KiB', async () => {
  const checked = await doctor({ memory: { used: 1018 * 1048576, limit: 3072 * 1048576, swap: 76 * 1024 } });
  expect(checked.out).toContain('PASS  Neo4j memory: 1018 MiB used / 3072 MiB limit; 2054 MiB headroom; 76 KiB swap');
});

test('a code-map rebuild running now passes; an interrupted or failed one fails', async () => {
  const map = { projectKey: 'demo', builtAt: '2026-11-01T00:00:00Z', ageDays: 4 };
  expect((await doctor({ status: { codeMaps: [{ ...map, rebuilding: true }] } })).out).toContain('PASS  Code maps: no failed or interrupted rebuilds reported');
  expect((await doctor({ status: { codeMaps: [{ ...map, rebuilding: true }, { ...map, projectKey: 'other', interrupted: true }] } })).out).toContain('FAIL  Code maps: 1 project(s) have a failed or interrupted rebuild');
});

test('a tokenless install is reported as read-only for owner actions, with the command that enables them', async () => {
  const { out } = await doctor({ status: {} });
  expect(out).toContain('WARN  Owner sign-in: no owner token, so the UI is read-only for owner actions');
  expect(out).toContain('./scripts/setup.sh --yes --enable-auth');
  expect(out).not.toContain('another local process can act as owner');
  expect(out).toMatch(/any container on this Docker host \(OrbStack and Docker Desktop route them through the gateway\) can read the API/);
});

test('a persisted network flag lists every reason and never points at --runner-procfs-compat as the way to clear it', async () => {
  const env = 'API_PORT=8787\nCODEX_RUNNER_URL=http://codex-runner:8790\n';
  const both = await doctor({ env, runnerFlag: 'procfs: nested sandbox could not mount proc\nnetwork: runner reached a protected host or service endpoint\n' });
  expect(both.out).toContain('Reason: procfs: nested sandbox could not mount proc');
  expect(both.out).toContain('Reason: network: runner reached a protected host or service endpoint');
  expect(both.out).toContain('--runner-procfs-compat does not clear this');
  expect(both.out).not.toContain('Clear it only by rerunning setup.sh --runner-procfs-compat');
  const procfs = await doctor({ env, runnerFlag: 'procfs: nested sandbox could not mount proc\n' });
  expect(procfs.out).toContain('Clear it only by rerunning setup.sh --runner-procfs-compat');
  // A sandbox failure that is not the procfs mount does not suggest the procfs exception either.
  const other = await doctor({ env, runnerSandbox: false, runnerError: 'bwrap: setting up uid map: Permission denied', running: ['neo4j', 'worker', 'api', 'codex-runner'] });
  expect(other.out).toContain('FAIL  Codex runner: sandbox cannot start');
  expect(other.out).not.toContain('review setup.sh --runner-procfs-compat');
});

test('the bind check reads what the running containers publish, not only API_BIND', async () => {
  const extra = ['api 127.0.0.1:8787->8787/tcp, 0.0.0.0:8808->8787/tcp', 'neo4j 127.0.0.1:7476->7474/tcp, 0.0.0.0:7689->7687/tcp'];
  const open = await doctor({ env: 'API_PORT=8787\nAPI_BIND=127.0.0.1\n', published: extra });
  expect(open.code).toBe(1);
  expect(open.out).toContain('FAIL  API bind: the running api is published on 0.0.0.0:8808, beyond loopback, with no API token');
  expect(open.out).toContain('WARN  port 0.0.0.0:7689 (neo4j): published beyond loopback');
  const tokened = await doctor({ env: `API_PORT=8787\nAPI_TOKEN=${'a'.repeat(32)}\nFG_OWNER_TOKEN=${'b'.repeat(32)}\n`, published: extra, status: {} });
  expect(tokened.out).toContain('WARN  API bind: the running api is published on 0.0.0.0:8808, beyond loopback');
  const loopback = await doctor({ published: ['api 127.0.0.1:8787->8787/tcp, [::1]:8787->8787/tcp'] });
  expect(loopback.out).toContain('PASS  API bind: the running api is published on loopback only');
  // Not running: the configured address is all there is to check.
  const stopped = await doctor({ env: 'API_PORT=8787\nAPI_BIND=0.0.0.0\n', published: [] });
  expect(stopped.out).toContain('FAIL  API bind: 0.0.0.0 would expose a tokenless API that anything reaching it can read; set API_BIND=127.0.0.1 or run ./scripts/setup.sh --yes --enable-auth');
  expect(stopped.out).not.toMatch(/owner-compatible|create API_TOKEN and FG_OWNER_TOKEN/);
});

test("the runner's network probe tries every install on this machine, not only this one's ports", async () => {
  const env = 'API_PORT=8797\nNEO4J_HTTP_PORT=7486\nCODEX_RUNNER_URL=http://codex-runner:8790\n';
  const checked = await doctor({ env, running: ['neo4j', 'worker', 'api', 'codex-runner'], installs: ['API_PORT=8807\nPOSTGRES_PORT=5454\n'] });
  expect(checked.out).toContain('PASS  Codex runner: live network probe');
  // This install's own api, the default install's 8787 and the other registered install's ports.
  for (const t of ['host.docker.internal:8797', 'host.docker.internal:8787', 'host.docker.internal:7476', 'host.docker.internal:8807', 'host.docker.internal:5454']) expect(checked.targets).toContain(t);
});

test('a code-map rebuild reported while the worker is not running is not passed: that write was cut short', async () => {
  const map = { projectKey: 'demo', builtAt: '2026-11-01T00:00:00Z', ageDays: 4 };
  const out = (await doctor({ running: ['neo4j', 'api'], status: { codeMaps: [{ ...map, rebuilding: true }] } })).out;
  expect(out).toContain('SKIP  containers: the worker is not running');
  expect(out).toContain('FAIL  Code maps: 1 project(s) have a failed or interrupted rebuild (the worker is not running)');
  expect(out).not.toContain('PASS  Code maps');
  expect((await doctor({ running: ['neo4j', 'api'], status: {} })).out).toContain('SKIP  Code maps: none reported failed, but the worker is not running');
});

test('an api and a worker crash-looping on a bad .env fail with the fatal line they logged, not a skip and "No failures"', async () => {
  const fatal = `${JSON.stringify({ ts: 't', msg: 'started' })}\n${JSON.stringify({ ts: 't', msg: 'fatal', error: 'config: LOOP_HOLDOUT must be a share from 0 to 0.5 (got "0.7")' })}\n`;
  const r = await doctor({ running: ['neo4j'], states: ['neo4j running 0', 'api restarting 0', 'worker restarting 0'], logs: { api: fatal, worker: fatal }, status: null });
  expect(r.code).toBe(1);
  expect(r.out).toContain('FAIL  api: restarting after each crash: config: LOOP_HOLDOUT must be a share from 0 to 0.5 (got "0.7")');
  expect(r.out).toContain('FAIL  worker: restarting after each crash: config: LOOP_HOLDOUT must be a share from 0 to 0.5 (got "0.7")');
  expect(r.out).not.toContain('No failures');
});

test('a killed, stopped or paused api or worker fails, saying how to start it again, as fg status calls it stale', async () => {
  const killed = await doctor({ running: ['neo4j', 'api'], states: ['neo4j running 0', 'api running 0', 'worker exited 137'], status: {} });
  expect(killed.code).toBe(1);
  expect(killed.out).toMatch(/^FAIL {2}worker: exited with code 137$/m);
  const stopped = await doctor({ running: ['neo4j', 'api'], states: ['neo4j running 0', 'api running 0', 'worker exited 0'], status: {} });
  expect(stopped.code).toBe(1);
  expect(stopped.out).toMatch(/^FAIL {2}worker: stopped\n {6}docker compose up -d worker$/m);
  expect(stopped.out).not.toContain('No failures');
  const paused = await doctor({ running: ['neo4j', 'worker'], states: ['neo4j running 0', 'api paused 0', 'worker running 0'], status: {} });
  expect(paused.code).toBe(1);
  expect(paused.out).toMatch(/^FAIL {2}api: paused, so it does nothing\n {6}docker compose unpause api$/m);
});

test("a running worker whose heartbeat is older than three beats fails; one that has not beaten yet is a warning", async () => {
  const late = await doctor({ status: { worker: { lastBeat: new Date(Date.now() - 300_000).toISOString() } } });
  expect(late.code).toBe(1);
  expect(late.out).toMatch(/^FAIL {2}worker heartbeat: none for 3\d\ds \(it beats every 30s\)/m);
  expect((await doctor({ status: { worker: null } })).out).toContain('WARN  worker heartbeat: none reported yet');
});

test('a scan failed after a day parked on its model fails the check with the reason; one parked now is a warning', async () => {
  const gaveUp = { projectKey: 'tiny-app', at: '2026-11-12T00:00:00Z', error: 'gave up after more than 24 hours parked on codex-cli (since 2026-11-11T00:00:00Z): cannot reach the codex runner.' };
  const parked = { projectKey: 'side-tool', provider: 'codex-cli', since: '2026-11-12T08:00:00Z', error: 'scan parked on codex-cli: cannot reach the codex runner.' };
  const failed = await doctor({ status: { scans: { parked: [parked], gaveUp: [gaveUp] } } });
  expect(failed.out).toContain(`FAIL  Scan: tiny-app: ${gaveUp.error}`);
  expect(failed.out).toContain('WARN  Scan: side-tool parked on codex-cli since 2026-11-12T08:00:00Z: a scan parked for 24 hours is failed');
  expect(failed.code).toBe(1);
  expect((await doctor({ status: { scans: { parked: [], gaveUp: [] } } })).out).toContain('PASS  Scans: none parked on an unavailable model');
});
