import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';

// Each test runs the real script in a subshell; on a loaded machine that can pass vitest's 5 s default.
vi.setConfig({ testTimeout: 20_000 });

// scripts/doctor.sh, run on a copy with a throwaway HOME and stand-ins for docker, nc and curl, so each check can be made
// to pass or fail without Docker, Ollama or the stack.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

type World = {
  dockerUp?: boolean;
  runnerSandbox?: boolean;
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
  /** Compose projects Docker has containers of, and the folder each was started from (HERE: the folder checked). */
  composed?: { project: string; dir: string }[];
};

const BOTH = '{"models":[{"name":"gemma4:latest"},{"name":"nomic-embed-text:latest"}]}';
const OK_CHAT = { code: 200, body: JSON.stringify({ message: { content: '{"ok": true}' } }) };
const conn = (state: string, detail: string) => ({ state, source: 'env', detail, href: '#settings/integrations' });

function doctor(w: World = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fbdoctor-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), home, bin]) mkdirSync(d, { recursive: true });
  for (const f of ['scripts/doctor.sh', 'scripts/lib/env.sh', 'scripts/lib/ollama.sh']) copyFileSync(join(repoRoot, f), join(repo, f));
  writeFileSync(join(repo, '.env'), w.env ?? 'API_PORT=8787\n');
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
  stub(
    'docker',
    `[ "$1" = info ] && exit ${w.dockerUp === false ? 1 : 0}
case "$*" in
  "ps -a "*)
    p="$(printf '%s\\n' "$@" | sed -n 's/^label=com.docker.compose.project=//p')"
    case "$p" in ${(w.composed ?? []).map((c) => `'${c.project}') echo '${c.dir === 'HERE' ? repo : c.dir}' ;;`).join(' ')} *) ;; esac ;;
  *" ps "*) printf '%s\\n' ${running.map((s) => `'${s}'`).join(' ')} ;;
  *" port "*)
    svc=$(echo "$*" | sed 's/.* port //' | awk '{print $1}'); inner=$(echo "$*" | awk '{print $NF}')
    for p in ${ours.join(' ')}; do
      case "$svc:$inner:$p" in api:8787:8787 | neo4j:7474:7476 | neo4j:7687:7689 | postgres:5432:5434) echo "127.0.0.1:$p"; exit 0 ;; esac
    done; exit 1 ;;
  *"/health"*) exit ${w.runnerSandbox === false ? 1 : 0} ;;
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
  *) exit 7 ;;
esac`,
  );
  const chatArgs = () => {
    try { return readFileSync(join(base, 'chat-args'), 'utf8'); } catch { return ''; }
  };
  try {
    const out = execFileSync('bash', [join(repo, 'scripts', 'doctor.sh')], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { out, code: 0, chatArgs: chatArgs() };
  } catch (e) {
    const x = e as { stdout?: string; status?: number };
    return { out: String(x.stdout ?? ''), code: x.status ?? -1, chatArgs: chatArgs() };
  }
}

test('a healthy install: every check passes, and the exit code is 0', () => {
  const { out, code } = doctor({ status: { connections: { github: conn('connected', 'signed in as acme-bot'), linear: conn('not_connected', 'no key yet') } } });
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
    'SKIP  Linear: not connected (no key yet)',
  ]) expect(out).toContain(line);
});

test('each broken piece is a FAIL line saying how to fix it, and the exit code is 1', () => {
  const { out, code } = doctor({
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

test('another folder\'s containers under this folder\'s Compose name: a loud FAIL naming that folder and FG_INSTANCE', () => {
  const other = doctor({ composed: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph' }] });
  expect(other.code).toBe(1);
  expect(other.out).toMatch(/FAIL {2}install: the containers named feedback-graph were started from \/srv\/acme\/feedback-graph, not this folder/);
  expect(other.out).toMatch(/docker compose here would take over/);
  expect(other.out).toMatch(/FG_INSTANCE=/);
  // FG_INSTANCE in .env is the name looked up.
  const named = doctor({ env: 'API_PORT=8787\nFG_INSTANCE=feedback-graph-repo\n', composed: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph' }] });
  expect(named.out).toContain('PASS  install: no other folder runs as feedback-graph-repo');
  const own = doctor({ composed: [{ project: 'feedback-graph', dir: 'HERE' }] });
  expect(own.code).toBe(0);
  expect(own.out).toContain('PASS  install: feedback-graph runs from this folder');
});

test('Docker down, Ollama down and the api not answering: failures and skips, never a crash', () => {
  const { out, code } = doctor({ dockerUp: false, ollama: false, status: null, running: [] });
  expect(code).toBe(1);
  expect(out).toContain('FAIL  docker: installed, but the daemon does not answer');
  expect(out).toContain('FAIL  ollama: does not answer at http://localhost:11434');
  expect(out).toContain('SKIP  containers: Docker does not answer');
  expect(out).toContain('SKIP  GitHub, Linear: the api does not answer');
});

test('the bundled ollama profile is checked on its own host port: OLLAMA_PORT, 11435 when unset', () => {
  expect(doctor({ env: 'API_PORT=8787\nOLLAMA_URL=http://ollama:11434\n' }).out).toContain('PASS  ollama: answers at http://localhost:11435');
  expect(doctor({ env: 'API_PORT=8787\nOLLAMA_URL=http://ollama:11434\nOLLAMA_PORT=11445\n' }).out).toContain('PASS  ollama: answers at http://localhost:11445');
});

test('never prints a secret from .env', () => {
  const secret = 'q'.repeat(40);
  const { out } = doctor({
    env: `API_PORT=8787\nAPI_TOKEN=${secret}\nGITHUB_TOKEN=${secret}\nLINEAR_API_KEY=${secret}\nNEO4J_PASSWORD=${secret}\n`,
    status: { connections: { github: conn('connected', 'signed in as acme-bot'), linear: conn('connected', 'signed in as Acme') } },
  });
  expect(out).not.toContain(secret);
  expect(out).toContain('PASS  Linear: signed in as Acme');
});

test('the classifier on another provider skips the structured-output probe', () => {
  const { out } = doctor({ env: 'CLASSIFY_LLM=claude-cli\n', chat: { code: 501, body: '{}' }, status: {} });
  expect(out).toContain('SKIP  ollama structured output: the classifier runs on claude-cli');
});

test('the probe asks for no thinking and the context the workers use, as the real classifier does', () => {
  const { chatArgs } = doctor({ env: 'OLLAMA_NUM_CTX=8192\n', status: {} });
  expect(chatArgs).toContain('"think":false');
  expect(chatArgs).toContain('"num_ctx":8192');
  expect(doctor({ status: {} }).chatArgs).toContain('"num_ctx":16384');
});

test('an answer that is all thinking and no content is a FAIL that says what to do', () => {
  const thinking = { code: 200, body: JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'Thinking Process: the user wants' } }) };
  const { out, code } = doctor({ chat: thinking, status: {} });
  expect(code).toBe(1);
  expect(out).toContain('FAIL  ollama structured output: gemma4 answered only in its thinking, with no content');
  expect(out).toMatch(/think:false/);
});


test('configured runner health requires its actual sandbox probe to succeed', () => {
  const env = 'API_PORT=8787\nCODEX_RUNNER_URL=http://codex-runner:8790\n';
  const failed = doctor({ env, runnerSandbox: false });
  expect(failed.code).toBe(1);
  expect(failed.out).toContain('FAIL  Codex runner: sandbox cannot start');
  const healthy = doctor({ env, runnerSandbox: true });
  expect(healthy.code).toBe(0);
  expect(healthy.out).toContain('PASS  Codex runner: its nested sandbox starts successfully');
});
