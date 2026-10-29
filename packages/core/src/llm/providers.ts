import { PRIVATE_DIRS, SECRET_GLOBS } from '../secrets.ts';
import { mirrorForAgent } from './mirror.ts';
import { purgeStaleRunnerMirrors, runnerReadiness, codexArgs, runOnRunner, RunnerUnavailableError } from './codexRunner.ts';
import { CliRunError, ProviderUnavailableError } from './unavailable.ts';
import { basename } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ollamaChatJson, ollamaTuning } from '../ollama.ts';
import { extractJsonAnswer, ModelOutputError } from './json.ts';
import { inEmptyFolder } from './promptOnly.ts';

/**
 * One structured-output request. `cwd` lets agentic providers read the repo themselves; without one they run in a fresh
 * empty folder (never the process's own). Prompt-only jobs go through askPromptOnly (promptOnly.ts).
 */
export type JsonTask = {
  system: string;
  user: string;
  schema: object;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Aborts the request when the caller gives up (check_before_done's admission deadline). The HTTP providers (Ollama,
   * OpenAI-compatible, Anthropic, jev) cancel the request; the CLI providers run to their timeoutMs.
   */
  signal?: AbortSignal;
  images?: TaskImage[];
  /**
   * The most tokens this job's answer needs (a short label: 256). Ollama sends it as num_predict unless
   * OLLAMA_NUM_PREDICT overrides every job; absent: DEFAULT_NUM_PREDICT. Other providers keep their own limits.
   */
  maxTokens?: number;
};

/** An image sent with a request (an uploaded screenshot, diagram or mock), base64 without a data: prefix. */
export type TaskImage = { mediaType: ImageMediaType; data: string };
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
const IMAGE_EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export interface LlmProvider {
  /** The spec string it was built from, e.g. `ollama:gemma4`. */
  id: string;
  /** True when the provider can explore `cwd` with read-only tools (Claude Code, Codex). */
  agentic: boolean;
  /** True when it can read `images`; one that cannot refuses a task that has any. Absent: false. */
  vision?: boolean;
  json(task: JsonTask): Promise<unknown>;
  /** Cheap readiness check before listing or copying a repository. */
  ready?(): Promise<void>;
  /**
   * For providers that explore a filtered copy of the repo (codex-cli): make that copy once, so many jobs over one repo
   * (the shards of a scan) do not copy it each. A job whose cwd is a mirror this provider made and has not disposed
   * runs in it as it is; any other cwd is still copied per job. Absent: the provider reads the repo in place.
   */
  mirror?(repo: string): Promise<AgentMirror>;
}

/** A filtered copy of a repo (mirror.ts) a provider made with LlmProvider.mirror; dispose removes it. */
export type AgentMirror = { dir: string; dispose(): Promise<void> };

/**
 * The mirrors a provider made and has not disposed: a job in one of them runs there, any other folder is mirrored for
 * that job alone. Only a folder this provider made counts, so no caller can skip the secret filter by naming a folder.
 */
function mirrors(parent?: string) {
  const live = new Set<string>();
  const swept = purgeStaleRunnerMirrors(parent ?? tmpdir(), undefined, Date.now(), true);
  return {
    async make(repo: string): Promise<AgentMirror> {
      await swept;
      const m = await mirrorForAgent(repo, parent);
      live.add(m.dir);
      return { dir: m.dir, dispose: async () => { live.delete(m.dir); await m.dispose(); } };
    },
    /** The task folder's mirror: the one given when it is live, else a fresh one, removed after the job. */
    async forJob(cwd: string): Promise<{ dir: string; dispose(): Promise<void> }> {
      if (live.has(cwd)) return { dir: cwd, dispose: async () => {} };
      return mirrorForAgent(cwd, parent);
    },
  };
}

/** A provider that cannot see refuses images rather than answering as if there were none. */
function blind(p: LlmProvider): LlmProvider {
  return {
    ...p,
    vision: false,
    json: (t) => (t.images?.length ? Promise.reject(new Error(`${p.id} cannot read images: choose a model with vision for this job (DOCS_LLM)`)) : p.json(t)),
  };
}

export type { Exec, ExecResult } from './exec.ts';
export { execCommand, killRunningCommands } from './exec.ts';
import { execCommand, type Exec } from './exec.ts';

export type ProviderEnv = Record<string, string | undefined>;
export type ProviderOpts = { fetchImpl?: typeof fetch; exec?: Exec };

const DEFAULT_TIMEOUT = 15 * 60_000;

/** A request's signal: its timeout, and the caller's own (JsonTask.signal) when it gives one. */
export const withSignal = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
  (signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs));

/** `fn` in the task's folder, or in a fresh empty one when it names none (never the process's own folder). */
const inTaskFolder = <T>(t: JsonTask, fn: (cwd: string) => Promise<T>): Promise<T> => (t.cwd ? fn(t.cwd) : inEmptyFolder(fn));


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

function cliPrompt(t: JsonTask): string {
  return `${t.system}\n\n${t.user}\n\nReturn only the JSON object described by the schema.`;
}

function ollama(id: string, model: string, env: ProviderEnv, o: ProviderOpts): LlmProvider {
  const url = env.OLLAMA_URL ?? 'http://host.docker.internal:11434';
  const tune = ollamaTuning(env);
  return {
    id,
    agentic: false,
    vision: true,
    json: (t) => ollamaChatJson({
      url, model, system: t.system, user: t.user, schema: t.schema, fetchImpl: o.fetchImpl,
      // OLLAMA_TIMEOUT_SECONDS, when set, is the limit for every Ollama call; otherwise each job's own.
      timeoutMs: tune.timeoutMs ?? t.timeoutMs,
      numPredict: tune.numPredict ?? t.maxTokens,
      numCtx: tune.numCtx,
      repeatPenalty: tune.repeatPenalty,
      images: t.images?.map((i) => i.data),
      signal: t.signal,
    }),
  };
}

function openaiCompatible(id: string, model: string, baseUrl: string, key: string, o: ProviderOpts): LlmProvider {
  return {
    id,
    agentic: false,
    vision: true,
    async json(t) {
      const res = await (o.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: t.system },
            {
              role: 'user',
              content: t.images?.length
                ? [{ type: 'text', text: t.user }, ...t.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))]
                : t.user,
            },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: strictSchema(t.schema) } },
        }),
        signal: withSignal(t.timeoutMs ?? DEFAULT_TIMEOUT, t.signal),
      });
      if (!res.ok) throw new Error(`${id} ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return extractJsonAnswer(body.choices?.[0]?.message?.content ?? '');
    },
  };
}

function anthropic(id: string, model: string, key: string, o: ProviderOpts): LlmProvider {
  return {
    id,
    agentic: false,
    vision: true,
    async json(t) {
      const res = await (o.fetchImpl ?? fetch)('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          system: t.system,
          messages: [{
            role: 'user',
            content: t.images?.length
              ? [...t.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text: t.user }]
              : t.user,
          }],
          tools: [{ name: 'respond', description: 'Return the result', input_schema: t.schema }],
          tool_choice: { type: 'tool', name: 'respond' },
        }),
        signal: withSignal(t.timeoutMs ?? DEFAULT_TIMEOUT, t.signal),
      });
      if (!res.ok) throw new Error(`${id} ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as { content?: { type: string; input?: unknown }[] };
      const call = body.content?.find((c) => c.type === 'tool_use');
      if (!call) throw new Error(`${id}: no tool_use in response`);
      return call.input;
    },
  };
}

/** The error claude reported in its JSON result (is_error), or '': never the model's answer. */
function cliReportedError(stdout: string): string {
  try {
    const out = JSON.parse(stdout) as { is_error?: boolean; result?: unknown };
    return out?.is_error ? String(out.result ?? '') : '';
  } catch {
    return '';
  }
}

function claudeCli(id: string, model: string | undefined, token: string, o: ProviderOpts): LlmProvider {
  return {
    id,
    agentic: true,
    vision: true,
    async json(t) {
      const args = claudeArgs(t.schema, model);
      // Subscription only: no ANTHROPIC_API_KEY, so it never falls back to paid API billing.
      const env = cliEnv({ CLAUDE_CODE_OAUTH_TOKEN: token });
      const ask = (cwd: string, stdin: string) => (o.exec ?? execCommand)('claude', args, { cwd, stdin, env, timeoutMs: t.timeoutMs ?? DEFAULT_TIMEOUT });
      // Images go in as files it opens with Read, in a fresh folder holding only them: never written into a repo.
      const r = t.images?.length
        ? await inEmptyFolder(async (cwd) => {
            const names = await Promise.all(t.images!.map(async (img, i) => {
              const name = `image-${i + 1}.${IMAGE_EXT[img.mediaType]}`;
              await writeFile(join(cwd, name), Buffer.from(img.data, 'base64'));
              return name;
            }));
            return ask(cwd, `${cliPrompt(t)}\n\nThe image${names.length === 1 ? ' is' : 's are'} ${names.join(', ')} in your current directory: open ${names.length === 1 ? 'it' : 'each'} with the Read tool before answering.`);
          }, 'fb-image-')
        : await inTaskFolder(t, (cwd) => ask(cwd, cliPrompt(t)));
      if (r.code !== 0) throw new CliRunError('claude', r.code, r.stderr.trim() || cliReportedError(r.stdout), r.stdout);
      let out: { is_error?: boolean; result?: string; structured_output?: unknown };
      try {
        out = JSON.parse(r.stdout) as typeof out;
      } catch {
        throw new ModelOutputError('claude printed no JSON result', r.stdout);
      }
      if (out.is_error) throw new CliRunError('claude', null, String(out.result));
      return out.structured_output ?? extractJsonAnswer(out.result ?? '');
    },
  };
}

/**
 * Codex's read-only sandbox can read the whole filesystem, and the worker image cannot narrow that (no per-path read
 * rules the worker can pass it; Docker's default seccomp profile blocks the namespaces bwrap would need). The repo mirror
 * only keeps secret files out of the cwd. So inside the worker codex-cli runs only when the owner has accepted that, by
 * name; the confined way is the codex-runner sidecar (CODEX_RUNNER_URL), which has nothing else to read.
 */
export const CODEX_UNCONFINED =
  'codex-cli is not confined to the repository: its read-only sandbox can read every file the worker can, including every ' +
  'transcript in /transcripts and /codex-sessions (projects you did not select too), every project under /vibe with its ' +
  '.env files, /state, the Codex login in /codex, and the worker\'s environment (database password, GitHub and Linear ' +
  'tokens, API keys) through /proc. Run it in the codex-runner sidecar instead (CODEX_RUNNER_URL, docker compose --profile codex), ' +
  'use claude-cli or an API model, or set ALLOW_UNCONFINED_CODEX=1 to accept this (see SECURITY.md).';

/** Where the worker mounts the scratch volume it shares with the codex-runner sidecar. */
export const DEFAULT_RUNNER_SCRATCH = '/scratch';

/** Inside the worker, unconfined: only with ALLOW_UNCONFINED_CODEX=1. */
function codexCli(id: string, model: string | undefined, o: ProviderOpts): LlmProvider {
  const own = mirrors();
  return {
    id,
    agentic: true,
    mirror: (repo) => own.make(repo),
    json: (t) => inTaskFolder(t, async (cwd) => {
      const dir = await mkdtemp(join(tmpdir(), 'fb-codex-'));
      // Codex's sandbox has no per-file deny list, so it explores a copy without secret files.
      const mirror = await own.forJob(cwd);
      try {
        const schemaPath = join(dir, 'schema.json');
        const outPath = join(dir, 'out.json');
        await writeFile(schemaPath, JSON.stringify(strictSchema(t.schema)));
        const args = codexArgs({ dir: mirror.dir, schemaPath, outPath, model });
        const r = await (o.exec ?? execCommand)('codex', args, { cwd: mirror.dir, stdin: cliPrompt(t), env: cliEnv({ CODEX_HOME: process.env.CODEX_HOME }), timeoutMs: t.timeoutMs ?? DEFAULT_TIMEOUT });
        if (r.code !== 0) throw new CliRunError('codex', r.code, r.stderr, r.stdout);
        return extractJsonAnswer(await readFile(outPath, 'utf8'));
      } finally {
        await rm(dir, { recursive: true, force: true });
        await mirror.dispose();
      }
    }),
  };
}

/** Confined: the mirror goes into the scratch volume and the codex-runner sidecar runs codex on it (codexRunner.ts). */
function codexRunnerCli(id: string, model: string | undefined, url: string, scratch: string, o: ProviderOpts): LlmProvider {
  const own = mirrors(scratch);
  const ready = async () => {
    const health = await runnerReadiness(url, o.fetchImpl);
    if (!health.ok) throw new ProviderUnavailableError(health.reason ?? 'codex runner sandbox unavailable');
  };
  return {
    id,
    agentic: true,
    ready,
    mirror: async (repo) => { await ready(); return own.make(repo); },
    json: (t) => inTaskFolder(t, async (cwd) => {
      await ready();
      const mirror = await own.forJob(cwd);
      try {
        const r = await runOnRunner({
          url,
          scratch,
          fetchImpl: o.fetchImpl,
          // The runner mounts the volume at its own path: the mirror is named relative to it.
          job: { prompt: cliPrompt(t), mirror: basename(mirror.dir), schema: strictSchema(t.schema) as object, model, timeoutMs: t.timeoutMs ?? DEFAULT_TIMEOUT },
        }).catch((err: unknown) => {
          throw err instanceof RunnerUnavailableError ? new ProviderUnavailableError(err.message) : err;
        });
        if (r.code !== 0) throw new CliRunError('codex', r.code, r.stderr, r.stdout);
        if (r.output === null) throw new Error('codex exit 0: it wrote no answer');
        return extractJsonAnswer(r.output);
      } finally {
        await mirror.dispose();
      }
    }),
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
        signal: withSignal(t.timeoutMs ?? 60_000, t.signal),
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
      if (env.CODEX_RUNNER_URL) return blind(codexRunnerCli(spec, model, env.CODEX_RUNNER_URL, env.CODEX_RUNNER_SCRATCH || DEFAULT_RUNNER_SCRATCH, o));
      if (env.ALLOW_UNCONFINED_CODEX !== '1') throw new Error(CODEX_UNCONFINED);
      return blind(codexCli(spec, model, o));
    case 'jev':
      return blind(jev(spec, model ?? 'jev-latest', need(env, 'TYPESAFE_API_KEY'), o));
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

/** Startup housekeeping for both local and sidecar copies, without deleting a live lease. */
export const purgeAgentMirrors = async (env: NodeJS.ProcessEnv = process.env) => {
  await purgeStaleRunnerMirrors(tmpdir(), undefined, Date.now(), true);
  await purgeStaleRunnerMirrors(env.CODEX_RUNNER_SCRATCH || DEFAULT_RUNNER_SCRATCH, undefined, Date.now(), true);
};
