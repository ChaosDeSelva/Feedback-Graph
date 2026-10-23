import { spawn } from 'node:child_process';
import { PRIVATE_DIRS, SECRET_GLOBS } from '../secrets.ts';
import { mirrorForAgent } from './mirror.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ollamaChatJson } from '../ollama.ts';

/** One structured-output request. `cwd` lets agentic providers read the repo themselves. */
export type JsonTask = { system: string; user: string; schema: object; cwd?: string; timeoutMs?: number };

export interface LlmProvider {
  /** The spec string it was built from, e.g. `ollama:gemma4`. */
  id: string;
  /** True when the provider can explore `cwd` with read-only tools (Claude Code, Codex). */
  agentic: boolean;
  json(task: JsonTask): Promise<unknown>;
}

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
  o: { cwd: string; stdin: string; env: NodeJS.ProcessEnv; timeoutMs: number; killGraceMs?: number },
) => Promise<ExecResult>;

export type ProviderEnv = Record<string, string | undefined>;
export type ProviderOpts = { fetchImpl?: typeof fetch; exec?: Exec };

const DEFAULT_TIMEOUT = 15 * 60_000;

/** Process groups of running CLI agents, so shutdown can stop them (they are detached and would outlive the worker). */
const running = new Set<number>();
export function killRunningCommands() {
  for (const pid of running) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
  running.clear();
}

export const execCommand: Exec = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    // Its own process group, so a timeout takes down the tools it spawned too (they hold the pipes open).
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const pid = child.pid;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const killGroup = (sig: NodeJS.Signals) => {
      if (exited()) return; // never signal a group id the OS may already have reused
      try {
        if (pid) process.kill(-pid, sig);
      } catch {
        child.kill(sig); // group already gone
      }
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    // SIGTERM first so the CLI can clean up; SIGKILL if it ignores that, so a stuck agent can never hang the worker.
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killer = setTimeout(() => killGroup('SIGKILL'), o.killGraceMs ?? 10_000);
    }, o.timeoutMs);
    if (pid) running.add(pid);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (pid) running.delete(pid);
    };
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code) => {
      done();
      if (timedOut) stderr += `\n${cmd} timed out after ${o.timeoutMs}ms`;
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });
    child.stdin.end(o.stdin);
  });

/** OpenAI-style strict schemas: every object closed, every property required. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strictSchema(v)])) as Record<string, unknown>;
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    s.additionalProperties = false;
    s.required = Object.keys(s.properties);
  }
  return s;
}

/** CLI agents run with only what they need: no other provider keys, GitHub/Linear tokens or the graph password. */
function cliEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/**
 * Reads claude may never make. Permission rules are gitignore-style: `**\/.env*` covers the cwd only, `/x` is the
 * project root, and an absolute filesystem path needs `//`. So each secret glob is denied under the cwd and anywhere,
 * and the worker's private folders by their absolute paths.
 */
const SECRET_READS = [
  ...SECRET_GLOBS.map((g) => `Read(${g})`),
  ...SECRET_GLOBS.map((g) => `Read(//${g})`),
  ...PRIVATE_DIRS.map((d) => `Read(/${d})`),
].join(',');

/**
 * The flags claude -p runs with (exported so a test can run the real CLI with exactly these). Confinement is
 * `--restricted`: the file tools stay inside the cwd (the repo), and the repo's own .claude settings are ignored, so a
 * repo cannot grant itself more. Only the three read tools exist at all; `dontAsk` denies anything not pre-approved
 * instead of waiting for a prompt nobody answers; nothing is pre-approved beyond the cwd (a bare `Read` allow would
 * approve reads of the whole filesystem). The deny rules stay as a second layer.
 */
export function claudeArgs(schema: object, model?: string): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--tools', 'Read,Grep,Glob',
    '--restricted',
    '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read(./**)',
    '--disallowedTools', `Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,${SECRET_READS}`,
    '--max-turns', '40',
    '--json-schema', JSON.stringify(schema),
  ];
  if (model) args.push('--model', model);
  return args;
}

function need(env: ProviderEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

function cliPrompt(t: JsonTask): string {
  return `${t.system}\n\n${t.user}\n\nReturn only the JSON object described by the schema.`;
}

function ollama(id: string, model: string, env: ProviderEnv, o: ProviderOpts): LlmProvider {
  const url = env.OLLAMA_URL ?? 'http://host.docker.internal:11434';
  return {
    id,
    agentic: false,
    json: (t) => ollamaChatJson({ url, model, system: t.system, user: t.user, schema: t.schema, fetchImpl: o.fetchImpl, timeoutMs: t.timeoutMs }),
  };
}

function openaiCompatible(id: string, model: string, baseUrl: string, key: string, o: ProviderOpts): LlmProvider {
  return {
    id,
    agentic: false,
    async json(t) {
      const res = await (o.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: t.system },
            { role: 'user', content: t.user },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: strictSchema(t.schema) } },
        }),
        signal: AbortSignal.timeout(t.timeoutMs ?? DEFAULT_TIMEOUT),
      });
      if (!res.ok) throw new Error(`${id} ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return extractJson(body.choices?.[0]?.message?.content ?? '');
    },
  };
}

function anthropic(id: string, model: string, key: string, o: ProviderOpts): LlmProvider {
  return {
    id,
    agentic: false,
    async json(t) {
      const res = await (o.fetchImpl ?? fetch)('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          system: t.system,
          messages: [{ role: 'user', content: t.user }],
          tools: [{ name: 'respond', description: 'Return the result', input_schema: t.schema }],
          tool_choice: { type: 'tool', name: 'respond' },
        }),
        signal: AbortSignal.timeout(t.timeoutMs ?? DEFAULT_TIMEOUT),
      });
      if (!res.ok) throw new Error(`${id} ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as { content?: { type: string; input?: unknown }[] };
      const call = body.content?.find((c) => c.type === 'tool_use');
      if (!call) throw new Error(`${id}: no tool_use in response`);
      return call.input;
    },
  };
}

function claudeCli(id: string, model: string | undefined, token: string, o: ProviderOpts): LlmProvider {
  return {
    id,
    agentic: true,
    async json(t) {
      const args = claudeArgs(t.schema, model);
      // Subscription only: no ANTHROPIC_API_KEY, so it never falls back to paid API billing.
      const env = cliEnv({ CLAUDE_CODE_OAUTH_TOKEN: token });
      const r = await (o.exec ?? execCommand)('claude', args, { cwd: t.cwd ?? process.cwd(), stdin: cliPrompt(t), env, timeoutMs: t.timeoutMs ?? DEFAULT_TIMEOUT });
      if (r.code !== 0) throw new Error(`claude exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 500)}`);
      const out = JSON.parse(r.stdout) as { is_error?: boolean; result?: string; structured_output?: unknown };
      if (out.is_error) throw new Error(`claude error: ${String(out.result).slice(0, 500)}`);
      return out.structured_output ?? extractJson(out.result ?? '');
    },
  };
}

/**
 * Codex's read-only sandbox can read the whole filesystem, and the worker image cannot narrow that (no per-path read
 * rules the worker can pass it; Docker's default seccomp profile blocks the namespaces bwrap would need). The repo mirror only keeps
 * secret files out of the cwd. So codex-cli runs only when the owner has accepted that, by name.
 */
export const CODEX_UNCONFINED =
  'codex-cli is not confined to the repository: its read-only sandbox can read every file the worker can, including every ' +
  'transcript in /transcripts and /codex-sessions (projects you did not select too), every project under /vibe with its ' +
  '.env files, /state, the Codex login in /codex, and the worker\'s environment (database password, GitHub and Linear ' +
  'tokens, API keys) through /proc. Use claude-cli or an API model instead, or set ALLOW_UNCONFINED_CODEX=1 to accept this (see SECURITY.md).';

function codexCli(id: string, model: string | undefined, o: ProviderOpts): LlmProvider {
  return {
    id,
    agentic: true,
    async json(t) {
      const dir = await mkdtemp(join(tmpdir(), 'fb-codex-'));
      // Codex's sandbox has no per-file deny list, so it explores a copy without secret files.
      const mirror = await mirrorForAgent(t.cwd ?? process.cwd());
      try {
        const schemaPath = join(dir, 'schema.json');
        const outPath = join(dir, 'out.json');
        await writeFile(schemaPath, JSON.stringify(strictSchema(t.schema)));
        const args = ['exec', '-s', 'read-only', '-C', mirror.dir, '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema', schemaPath, '-o', outPath];
        if (model) args.push('-m', model);
        args.push('-');
        const r = await (o.exec ?? execCommand)('codex', args, { cwd: mirror.dir, stdin: cliPrompt(t), env: cliEnv({ CODEX_HOME: process.env.CODEX_HOME }), timeoutMs: t.timeoutMs ?? DEFAULT_TIMEOUT });
        if (r.code !== 0) throw new Error(`codex exit ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`);
        return extractJson(await readFile(outPath, 'utf8'));
      } finally {
        await rm(dir, { recursive: true, force: true });
        await mirror.dispose();
      }
    },
  };
}

type SchemaProp = { type?: string | string[]; enum?: string[] };

/**
 * TypeSafe Jev (System One): answers typed decisions, not free text. Each enum field becomes a Choice
 * question over the same state; a `confidence` field gets Jev's calibrated confidence; other string
 * fields come back empty. Schemas needing lists or objects are refused, so use it for classification.
 */
function jev(id: string, model: string, key: string, o: ProviderOpts): LlmProvider {
  return {
    id,
    agentic: false,
    async json(t) {
      const props = ((t.schema as { properties?: Record<string, SchemaProp> }).properties ?? {});
      const choices = Object.entries(props).filter(([, p]) => p.enum?.length);
      const unsupported = Object.entries(props).filter(([k, p]) => !p.enum && !['string', 'number'].includes(String(p.type)) && k !== 'confidence');
      if (!choices.length || unsupported.length) {
        throw new Error(`${id}: jev only answers choice-style schemas (enum fields); cannot fill ${unsupported.map(([k]) => k).join(', ') || 'a schema without enums'}`);
      }
      const res = await (o.fetchImpl ?? fetch)('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          state: t.user,
          model,
          questions: Object.fromEntries(choices.map(([k, p]) => [k, { type: 'choice', instructions: t.system, criteria: Object.fromEntries(p.enum!.map((e) => [e, e])) }])),
        }),
        signal: AbortSignal.timeout(t.timeoutMs ?? 60_000),
      });
      if (!res.ok) throw new Error(`${id} ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as { answers?: Record<string, { choice?: string; confidence?: number }> };
      const answers = body.answers ?? {};
      const out: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(props)) {
        if (p.enum) out[k] = answers[k]?.choice;
        else if (k === 'confidence') out[k] = Math.min(...choices.map(([c]) => answers[c]?.confidence ?? 0));
        else out[k] = p.type === 'number' ? 0 : '';
      }
      return out;
    },
  };
}

/**
 * Build a provider from a spec string:
 * `ollama:<model>` · `claude-cli[:model]` · `codex-cli[:model]` · `openai:<model>` · `openrouter:<model>` ·
 * `groq:<model>` · `anthropic:<model>` · `jev[:model]` (TypeSafe, classification only).
 */
export function makeProvider(spec: string, env: ProviderEnv, o: ProviderOpts = {}): LlmProvider {
  const i = spec.indexOf(':');
  const kind = i < 0 ? spec : spec.slice(0, i);
  const model = i < 0 ? undefined : spec.slice(i + 1) || undefined;
  switch (kind) {
    case 'ollama':
      return ollama(spec, model ?? 'gemma4', env, o);
    case 'openai':
      return openaiCompatible(spec, model ?? 'gpt-5.1', env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', need(env, 'OPENAI_API_KEY'), o);
    case 'openrouter':
      return openaiCompatible(spec, need({ m: model }, 'm'), 'https://openrouter.ai/api/v1', need(env, 'OPENROUTER_API_KEY'), o);
    case 'groq':
      return openaiCompatible(spec, need({ m: model }, 'm'), 'https://api.groq.com/openai/v1', need(env, 'GROQ_API_KEY'), o);
    case 'anthropic':
      return anthropic(spec, model ?? 'claude-sonnet-5-5', need(env, 'ANTHROPIC_API_KEY'), o);
    case 'claude-cli':
      return claudeCli(spec, model, need(env, 'CLAUDE_CODE_OAUTH_TOKEN'), o);
    case 'codex-cli':
      if (env.ALLOW_UNCONFINED_CODEX !== '1') throw new Error(CODEX_UNCONFINED);
      return codexCli(spec, model, o);
    case 'jev':
      return jev(spec, model ?? 'jev-latest', need(env, 'TYPESAFE_API_KEY'), o);
    default:
      throw new Error(`unknown provider "${kind}" in "${spec}"`);
  }
}

/** Build `spec`, or `fallback` when `spec` cannot be built here (missing key, unknown kind), with the reason. */
export function makeProviderOr(spec: string, fallback: string, env: ProviderEnv, o: ProviderOpts = {}): { provider: LlmProvider; fellBack: string | null } {
  try {
    return { provider: makeProvider(spec, env, o), fellBack: null };
  } catch (err) {
    return { provider: makeProvider(fallback, env, o), fellBack: `${spec}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
