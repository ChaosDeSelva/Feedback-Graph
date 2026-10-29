import { parseLogins } from './feedbackRules.ts';
import { parseGithubRepos } from './integrations/github.ts';
import type { Root } from './projects.ts';
import { DEFAULT_NUM_CTX, DEFAULT_NUM_PREDICT, DEFAULT_OLLAMA_TIMEOUT_MS, DEFAULT_REPEAT_PENALTY } from './ollama.ts';

/** Bumped with each release; reported by /api/status and the worker heartbeat. */
export const VERSION = '0.6.7';

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const PROVIDERS = new Set(['ollama', 'openai', 'openrouter', 'groq', 'anthropic', 'claude-cli', 'codex-cli', 'jev']);
const NEEDS_MODEL = new Set(['openrouter', 'groq']);
const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|::1|\[::1\])$/i;

/** Where everything is stored. Neo4j is the default; Postgres (with pgvector) runs the same code. */
export type StoreChoice = 'neo4j' | 'postgres';
const STORES: readonly StoreChoice[] = ['neo4j', 'postgres'];

const SECRET_PARAM = /pass|secret|token|key/i;

/**
 * A connection URL with its password masked, for messages and logs: the userinfo password and any query parameter
 * that names one (pg reads `?password=` too). Unparseable input is not echoed at all.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    if (u.search) {
      u.search = u.search
        .slice(1)
        .split('&')
        .map((kv) => {
          const k = kv.split('=')[0];
          return kv.includes('=') && SECRET_PARAM.test(decodeURIComponent(k)) ? `${k}=***` : kv;
        })
        .join('&');
    }
    return u.toString();
  } catch {
    return '(unparseable URL)';
  }
}

export type Config = {
  store: StoreChoice;
  /** Set when store is 'neo4j'. */
  neo4j: { url: string; user: string; password: string } | null;
  /** Set when store is 'postgres'. Never log `url`: it carries the password (see redactUrl). */
  postgres: { url: string } | null;
  /** The mounted project roots (PROJECT_ROOTS / HOST_PROJECT_ROOTS from the generated override); empty when none. */
  roots: Root[];
  /** ROOTS_FILE: where Settings saves the owner's roots (host paths) for scripts/setup.sh to mount. Null: not editable. */
  rootsFile: string | null;
  /** Where tokens pasted in Settings (GitHub, Linear) are kept, mode 600; null: only .env tokens. */
  integrationsFile: string | null;
  /** HOST_HOME: the host's home folder, never suggested as a root. */
  hostHome: string | null;
  transcriptsDir: string;
  /** Codex CLI / Desktop rollout files (~/.codex/sessions on the host), mounted read-only. */
  codexSessionsDir: string;
  stateDb: string;
  /**
   * numPredict: OLLAMA_NUM_PREDICT, the answer limit for every job; null: each job's own (classify 256, relevance scores
   * 1024, everything else 2048). numCtx / repeatPenalty: sent with every Ollama chat call (OLLAMA_NUM_CTX, default
   * 16384; OLLAMA_REPEAT_PENALTY).
   * timeoutSeconds: OLLAMA_TIMEOUT_SECONDS, the limit for every Ollama chat call; null: each job's own (classify 120 s).
   */
  ollama: { url: string; model: string; embedModel: string; numPredict: number | null; numCtx: number; repeatPenalty: number; timeoutSeconds: number | null };
  /**
   * docs: reads uploaded documents and images into facts (DOCS_LLM, default SCAN_LLM; it needs vision for images).
   * chat: answers Ask conversations that have no provider of their own (CHAT_LLM); null: the worker picks claude-cli
   * when a Claude token is set, else codex-cli when a Codex login exists, else the local model.
   */
  llm: { classify: string | null; postmortem: string | null; scan: string | null; check: string | null; docs: string | null; chat: string | null };
  pollSeconds: number;
  classifyBatch: number;
  scanMaxBytes: number;
  /**
   * SCAN_MAX_FILES: files per project the code map keeps and changed files a per-file scan reads per run. Null (unset):
   * the map keeps 40% of the candidates, between 400 and 4000, and a scan reads 400 per run.
   */
  scanMaxFiles: number | null;
  /** SCAN_CONCURRENCY: scans run at once, beside the worker cycle (default 2; agentic ones one at a time). */
  scanConcurrency: number;
  /**
   * check_before_done's judge (api): CHECK_CONCURRENCY calls at once (default 2), the rest queued; a check the judge
   * has not answered within CHECK_WAIT_SECONDS (default 300, waiting included) is answered "not judged" at once and
   * its model call cancelled. The judge's attempts (an answer and its one retry) share that same budget.
   */
  check: { concurrency: number; waitSeconds: number };
  /** Seeds the project selection on its first start only; from then on the selection (Settings) decides. */
  ingestProjects: string[];
  /** Never ingested, scanned or served, even when INGEST_PROJECTS is empty. */
  excludeProjects: string[];
  /** Text of turns nobody flagged is removed after this many days; null keeps it. */
  turnRetentionDays: number | null;
  /** MEMORY_AUTO_APPROVE: import Claude Code feedback memories as approved lessons instead of proposed ones. */
  memoryAutoApprove: boolean;
  /** Session summaries (the worker's summarize stage). */
  summary: SummaryConfig;
  /**
   * GITHUB_REPOS (project=owner/repo), which overrides the repository a project's github.com remote names, and the
   * hours between PR-as-context syncs. The token is resolved per cycle (Integrations: .env, else Settings).
   * botLogins / agentLogins (GITHUB_BOT_LOGINS, GITHUB_AGENT_LOGINS, lower-cased): comment authors labelled bot
   * (skipped before the classifier) or agent (kept, labelled) besides the [bot] suffix and the "[claude]"-style markers.
   */
  github: { repos: Map<string, string>; syncHours: number; botLogins: string[]; agentLogins: string[] };
  /** Minutes between syncs of review comments and Linear comments into the Inbox, per project (INTEGRATION_SYNC_MINUTES). */
  integrationSyncMinutes: number;
  /** Minutes between rounds of looking for links between the selected projects (LINK_SCAN_MINUTES, default 30). */
  linkScanMinutes: number;
  apiToken: string | null;
  /** FG_OPERATOR_TOKEN and OPERATOR_ALLOW; null (the default): no request can make owner decisions without the UI. */
  operator: OperatorConfig | null;
  publicHosts: string[];
  /** Feedback Graph Cloud sync; null (the default) sends nothing anywhere. Never log `token`. */
  cloud: CloudConfig | null;
  /** Where the API is reachable from (API_BIND, the address compose publishes it on). Not loopback needs API_TOKEN. */
  apiBind: string;
  /** The interface the server listens on: API_LISTEN (0.0.0.0 inside the container), else API_BIND. */
  apiListen: string;
  port: number;
};

export type SummaryConfig = {
  /** SUMMARY_LLM=off turns summaries off. */
  enabled: boolean;
  /** SUMMARY_LLM: a provider spec; null uses the local Ollama model. */
  llm: string | null;
  /** A session's new turns are summarized once it has been quiet this long (SUMMARY_QUIET_MINUTES, 10)... */
  quietMinutes: number;
  /** ...or at once when this many are waiting (SUMMARY_MAX_DELTA_TURNS, 40). */
  maxDeltaTurns: number;
  /** Quiet this long, and summarized to its last turn: idle, "complete for now" (SESSION_IDLE_MINUTES, 30). */
  idleMinutes: number;
  /** Existing sessions summarized per cycle, newest first (SUMMARY_BACKFILL_PER_CYCLE, 3; 0 stops the backfill). */
  backfillPerCycle: number;
};

export type CloudConfig = {
  /** Base URL, no trailing slash: https, or http on this machine only. */
  url: string;
  token: string;
  /** Minutes between automatic syncs; null syncs only when you press Sync now. */
  intervalMinutes: number | null;
  /** Projects to sync; empty means the projects selected in Settings. */
  projects: string[];
  /** CLOUD_MACHINE: this machine's name, sent as x-fg-machine (a provenance label on the cloud's sync log). Null: none. */
  machine: string | null;
  /**
   * SYNC_SUGGESTIONS=true: also send lessons you have not approved (proposed ones arrive as suggestions for an admin).
   * false (the default): only approved lessons leave, plus the new status of any lesson the cloud already has.
   */
  suggestions: boolean;
  /** Explicit privacy boundary: these project keys never export new content to cloud. */
  localOnlyProjects?: string[];
  /** Explicit owner opt-in, loaded from shared Settings, never inferred from scanned content. */
  shareDemoProjects?: string[];
};

/** fgc_pat_<16 hex lookup id>_<43 base64url chars>: what the cloud issues. */
export const CLOUD_TOKEN_RE = /^fgc_pat_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;
/**
 * This machine: loopback, and host.docker.internal, which is how the api and worker containers reach the host (inside a
 * container localhost is the container; docker-compose.yml maps host.docker.internal for them).
 */
const CLOUD_LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

/** The problem with a cloud base URL, or null: https anywhere, plain http only to this machine, no credentials. */
export function cloudUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'CLOUD_URL is not a URL (https://cloud.example.com)';
  }
  if (u.username || u.password) return 'CLOUD_URL must not carry a user name or password (the token goes in CLOUD_TOKEN)';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && CLOUD_LOCAL.has(u.hostname)) return null;
  return `CLOUD_URL must be https:// (plain http is allowed only for localhost or host.docker.internal); got ${u.protocol}//${u.host}`;
}

/**
 * The owner-only actions an agent holding FG_OPERATOR_TOKEN can be allowed (OPERATOR_ALLOW). Each names a group of the
 * routes createApp guards with ownerOnly.
 */
export const OPERATOR_VERBS = [
  'select_projects', 'settings', 'scan', 'inbox_decide', 'lesson_decide', 'relevance', 'pin', 'links', 'links_delete', 'docs', 'docs_delete',
  'delete_project', 'retry', 'requeue', 'sync_now', 'import', 'resummarize', 'integrations', 'chat', 'chat_delete',
  // Removes what one labelled run (x-fg-run) wrote and nothing else, so it is on by default (DELETE /api/runs/:id).
  'run_cleanup',
] as const;
export type OperatorVerb = (typeof OPERATOR_VERBS)[number];
/**
 * Off unless OPERATOR_ALLOW names them: deciding lessons (what agents are taught), choosing which project folders are read
 * (projects are the owner's opt-in), and what deletes data (deleting a project, an uploaded document, a link between
 * projects or an Ask conversation; settings, whose cleanup deletes unselected projects' data), imports lessons from a
 * file, or sets integration keys; and `chat` (asking in Ask), which spends the owner's Claude or Codex subscription.
 */
const OPERATOR_DEFAULT_OFF: readonly OperatorVerb[] = ['lesson_decide', 'select_projects', 'delete_project', 'docs_delete', 'links_delete', 'settings', 'import', 'integrations', 'chat', 'chat_delete'];

/** FG_OPERATOR_TOKEN: agents (the `fg` CLI) may make the owner decisions in `allow`. Never log `token`. */
export type OperatorConfig = { token: string; allow: OperatorVerb[] };

type Env = Record<string, string | undefined>;

const list = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Read and check every setting; throws one ConfigError naming each problem so a bad .env fails fast and clearly. */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const str = (k: string, d?: string) => {
    const v = env[k]?.trim() || d;
    if (v === undefined) problems.push(`${k} is required`);
    return v ?? '';
  };
  const num = (k: string, d: number, min = 1) => {
    const raw = env[k]?.trim();
    if (!raw) return d;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) {
      problems.push(`${k} must be a number of at least ${min} (got ${JSON.stringify(raw)})`);
      return d;
    }
    return n;
  };
  const spec = (k: string, classifyOnly = false) => {
    const v = env[k]?.trim();
    if (!v) return null;
    const i = v.indexOf(':');
    const kind = i < 0 ? v : v.slice(0, i);
    if (!PROVIDERS.has(kind)) problems.push(`${k}: unknown provider ${JSON.stringify(kind)} (use ${[...PROVIDERS].join(', ')})`);
    else if (NEEDS_MODEL.has(kind) && (i < 0 || !v.slice(i + 1))) problems.push(`${k}: ${kind} needs a model, e.g. ${kind}:<model>`);
    else if (kind === 'jev' && !classifyOnly) problems.push(`${k}: jev is a classification model; use it for CLASSIFY_LLM only`);
    return v;
  };

  // No roots is valid: the owner adds folders in Settings, and scripts/setup.sh mounts them (docker-compose.override.yml).
  const containers = list(env.PROJECT_ROOTS);
  const hosts = list(env.HOST_PROJECT_ROOTS);
  if (containers.length && !hosts.length) problems.push('HOST_PROJECT_ROOTS is required when PROJECT_ROOTS is set');
  else if (hosts.length !== containers.length) {
    problems.push(`HOST_PROJECT_ROOTS has ${hosts.length} entries but PROJECT_ROOTS has ${containers.length}; they pair up in order`);
  }

  // The token can also be pasted in Settings, so GITHUB_REPOS no longer needs GITHUB_TOKEN here.
  let repos = new Map<string, string>();
  try {
    repos = parseGithubRepos(env.GITHUB_REPOS?.trim() ?? '');
  } catch (e) {
    problems.push((e as Error).message);
  }
  const github: Config['github'] = {
    repos, syncHours: num('GITHUB_SYNC_HOURS', 6), botLogins: parseLogins(env.GITHUB_BOT_LOGINS), agentLogins: parseLogins(env.GITHUB_AGENT_LOGINS),
  };

  const apiToken = env.API_TOKEN?.trim() || null;
  if (apiToken && apiToken.length < 24) problems.push('API_TOKEN must be at least 24 characters (try: openssl rand -hex 24)');
  const publicHosts = list(env.PUBLIC_HOSTS);
  if (publicHosts.length && !apiToken) problems.push('PUBLIC_HOSTS needs API_TOKEN: other machines must not reach the API unauthenticated');
  const apiBind = env.API_BIND?.trim() || '127.0.0.1';
  // Without a token the Host check is the only guard, and any client can send `Host: localhost`.
  if (!apiToken && !LOOPBACK.test(apiBind)) {
    problems.push(`API_BIND=${apiBind} exposes the API beyond this machine, which needs API_TOKEN (openssl rand -hex 24); or set API_BIND=127.0.0.1`);
  }
  const operatorToken = env.FG_OPERATOR_TOKEN?.trim() || null;
  let operator: OperatorConfig | null = null;
  if (operatorToken) {
    if (operatorToken.length < 24) problems.push('FG_OPERATOR_TOKEN must be at least 24 characters (try: openssl rand -hex 24)');
    if (operatorToken === apiToken) problems.push('FG_OPERATOR_TOKEN must differ from API_TOKEN: the operator token can make owner decisions');
    const asked = list(env.OPERATOR_ALLOW);
    const isVerb = (v: string): v is OperatorVerb => (OPERATOR_VERBS as readonly string[]).includes(v);
    const unknown = asked.filter((v) => v !== 'all' && !isVerb(v));
    if (unknown.length) problems.push(`OPERATOR_ALLOW names unknown actions: ${unknown.join(', ')} (known: all, ${OPERATOR_VERBS.join(', ')})`);
    const allow = !asked.length
      ? OPERATOR_VERBS.filter((v) => !OPERATOR_DEFAULT_OFF.includes(v))
      : asked.includes('all') ? [...OPERATOR_VERBS] : [...new Set(asked.filter(isVerb))];
    operator = { token: operatorToken, allow };
  }
  const runnerUrl = env.CODEX_RUNNER_URL?.trim() || '';
  if (runnerUrl) {
    let u: URL | null = null;
    try {
      u = new URL(runnerUrl);
    } catch {
      problems.push('CODEX_RUNNER_URL is not a URL (http://codex-runner:8790)');
    }
    if (u && u.protocol !== 'http:' && u.protocol !== 'https:') problems.push(`CODEX_RUNNER_URL must be http:// or https:// (got ${u.protocol})`);
    else if (u && (u.username || u.password)) problems.push('CODEX_RUNNER_URL must not carry a user name or password (the runner token is in the scratch volume)');
  }
  for (const k of ['CLASSIFY_LLM', 'POSTMORTEM_LLM', 'SCAN_LLM', 'SUMMARY_LLM', 'DOCS_LLM', 'CHAT_LLM']) {
    if (/^codex-cli(:|$)/.test(env[k]?.trim() ?? '') && !runnerUrl && env.ALLOW_UNCONFINED_CODEX?.trim() !== '1') {
      problems.push(`${k}: codex-cli inside the worker can read every file the worker can (all transcripts, every project's .env, the worker's secrets); run it in the codex-runner sidecar (CODEX_RUNNER_URL with docker compose --profile codex), set ALLOW_UNCONFINED_CODEX=1 to accept that, or use claude-cli (SECURITY.md)`);
    }
  }
  // check_before_done is judged inside the api, which has no agent CLIs (and should not hold their logins: it is the
  // service other machines can reach). The judge reads only the summary and diff it is sent, so it needs no repo access.
  if (/^(claude|codex)-cli(:|$)/.test(env.CHECK_LLM?.trim() ?? '')) {
    problems.push('CHECK_LLM: claude-cli and codex-cli run in the worker, not the api, so they cannot judge check_before_done; use ollama:<model> or an API model (openai:, anthropic:, openrouter:, groq:), or leave it empty for the local model');
  }

  const storeRaw = env.STORE?.trim().toLowerCase() || 'neo4j';
  const store: StoreChoice = (STORES as readonly string[]).includes(storeRaw) ? (storeRaw as StoreChoice) : 'neo4j';
  if (store !== storeRaw) problems.push(`STORE: unknown store ${JSON.stringify(env.STORE?.trim())} (use ${STORES.join(', ')})`);
  let postgres: Config['postgres'] = null;
  if (storeRaw === 'postgres') {
    const url = env.DATABASE_URL?.trim();
    if (!url) problems.push('DATABASE_URL is required when STORE=postgres (postgres://user:password@host:5432/database)');
    else {
      let u: URL | null = null;
      try {
        u = new URL(url);
      } catch {
        problems.push('DATABASE_URL is not a URL (postgres://user:password@host:5432/database)');
      }
      if (u && !['postgres:', 'postgresql:'].includes(u.protocol)) problems.push(`DATABASE_URL must start with postgres:// (got ${redactUrl(url)})`);
      else if (u && (!u.hostname || u.pathname.length < 2)) problems.push(`DATABASE_URL needs a host and a database name (got ${redactUrl(url)})`);
      // The bundled service (docker-compose.yml builds this URL) always needs a password; your own server may not.
      else if (u && u.hostname === 'postgres' && !u.password) problems.push('POSTGRES_PASSWORD is empty: the bundled postgres service needs one (letters and digits, e.g. openssl rand -hex 18) in .env, or set DATABASE_URL to your own server');
      else if (u) postgres = { url };
    }
  }

  const syncSuggestions = env.SYNC_SUGGESTIONS?.trim().toLowerCase() || 'false';
  if (syncSuggestions !== 'true' && syncSuggestions !== 'false') problems.push(`SYNC_SUGGESTIONS must be true or false (got ${JSON.stringify(env.SYNC_SUGGESTIONS)})`);
  const cloudUrl = env.CLOUD_URL?.trim() || '';
  const cloudToken = env.CLOUD_TOKEN?.trim() || '';
  let cloud: Config['cloud'] = null;
  if (cloudUrl || cloudToken) {
    const before = problems.length;
    if (!cloudUrl) problems.push('CLOUD_URL is required when CLOUD_TOKEN is set');
    if (!cloudToken) problems.push('CLOUD_TOKEN is required when CLOUD_URL is set (create a token with the sync scope in the cloud web app)');
    const urlProblem = cloudUrl ? cloudUrlProblem(cloudUrl) : null;
    if (urlProblem) problems.push(urlProblem);
    // Never echo the value: a mistyped token is still most of a secret.
    if (cloudToken && !CLOUD_TOKEN_RE.test(cloudToken)) problems.push('CLOUD_TOKEN is not a Feedback Graph Cloud token (fgc_pat_<16 hex>_<43 characters>)');
    const interval = env.SYNC_INTERVAL_MINUTES?.trim() ? num('SYNC_INTERVAL_MINUTES', 60, 5) : null;
    const machine = env.CLOUD_MACHINE?.trim() || null;
    if (machine && !/^[\w.-]{1,64}$/.test(machine)) problems.push('CLOUD_MACHINE must be 1 to 64 letters, digits, dots, dashes or underscores');
    if (problems.length === before) {
      cloud = { url: cloudUrl.replace(/\/+$/, ''), token: cloudToken, intervalMinutes: interval, projects: list(env.SYNC_PROJECTS), ...(env.CLOUD_LOCAL_ONLY_PROJECTS?.trim() ? { localOnlyProjects: list(env.CLOUD_LOCAL_ONLY_PROJECTS) } : {}), suggestions: syncSuggestions === 'true', machine };
    }
  } else {
    if (syncSuggestions === 'true') problems.push('SYNC_SUGGESTIONS needs CLOUD_URL and CLOUD_TOKEN');
    if (env.SYNC_INTERVAL_MINUTES?.trim()) problems.push('SYNC_INTERVAL_MINUTES needs CLOUD_URL and CLOUD_TOKEN');
    if (env.SYNC_PROJECTS?.trim()) problems.push('SYNC_PROJECTS needs CLOUD_URL and CLOUD_TOKEN');
  }
  const autoApproveRaw = env.MEMORY_AUTO_APPROVE?.trim().toLowerCase() || 'false';
  if (autoApproveRaw !== 'true' && autoApproveRaw !== 'false') problems.push(`MEMORY_AUTO_APPROVE must be true or false (got ${JSON.stringify(env.MEMORY_AUTO_APPROVE)})`);

  const retention = env.TURN_RETENTION_DAYS?.trim() ? num('TURN_RETENTION_DAYS', 0) : null;

  const summaryOff = env.SUMMARY_LLM?.trim().toLowerCase() === 'off';
  const summary: SummaryConfig = {
    enabled: !summaryOff,
    llm: summaryOff ? null : spec('SUMMARY_LLM'),
    quietMinutes: num('SUMMARY_QUIET_MINUTES', 10),
    maxDeltaTurns: num('SUMMARY_MAX_DELTA_TURNS', 40, 2),
    idleMinutes: num('SESSION_IDLE_MINUTES', 30),
    backfillPerCycle: num('SUMMARY_BACKFILL_PER_CYCLE', 3, 0),
  };
  if (summary.idleMinutes < summary.quietMinutes) {
    problems.push(`SESSION_IDLE_MINUTES (${summary.idleMinutes}) must be at least SUMMARY_QUIET_MINUTES (${summary.quietMinutes}): a session is summarized before it is called idle`);
  }

  const config: Config = {
    store,
    neo4j: store === 'neo4j' ? { url: str('NEO4J_URL', 'bolt://neo4j:7687'), user: str('NEO4J_USER', 'neo4j'), password: str('NEO4J_PASSWORD') } : null,
    postgres,
    roots: containers.map((container, i) => ({ container, host: hosts[i] ?? '' })),
    rootsFile: env.ROOTS_FILE?.trim() || null,
    integrationsFile: env.INTEGRATIONS_FILE?.trim() || null,
    hostHome: env.HOST_HOME?.trim().replace(/\/+$/, '') || null,
    transcriptsDir: str('TRANSCRIPTS_DIR', '/transcripts'),
    codexSessionsDir: str('CODEX_SESSIONS_DIR', '/codex-sessions'),
    stateDb: str('STATE_DB', '/state/worker.sqlite'),
    ollama: {
      url: str('OLLAMA_URL', 'http://host.docker.internal:11434'),
      model: str('OLLAMA_MODEL', 'gemma4'),
      embedModel: str('OLLAMA_EMBED_MODEL', 'nomic-embed-text'),
      // Read again by each Ollama provider (ollamaTuning): checked here so a bad value fails at startup.
      numPredict: env.OLLAMA_NUM_PREDICT?.trim() ? num('OLLAMA_NUM_PREDICT', DEFAULT_NUM_PREDICT) : null,
      numCtx: num('OLLAMA_NUM_CTX', DEFAULT_NUM_CTX, 512),
      repeatPenalty: num('OLLAMA_REPEAT_PENALTY', DEFAULT_REPEAT_PENALTY, 0.01),
      timeoutSeconds: env.OLLAMA_TIMEOUT_SECONDS?.trim() ? num('OLLAMA_TIMEOUT_SECONDS', DEFAULT_OLLAMA_TIMEOUT_MS / 1000) : null,
    },
    llm: { classify: spec('CLASSIFY_LLM', true), postmortem: spec('POSTMORTEM_LLM'), scan: spec('SCAN_LLM'), check: spec('CHECK_LLM'), docs: spec('DOCS_LLM'), chat: spec('CHAT_LLM') },
    pollSeconds: num('POLL_SECONDS', 30),
    classifyBatch: num('CLASSIFY_BATCH', 50),
    scanMaxBytes: num('SCAN_MAX_BYTES', 80_000),
    scanMaxFiles: env.SCAN_MAX_FILES?.trim() ? num('SCAN_MAX_FILES', 400) : null,
    scanConcurrency: num('SCAN_CONCURRENCY', 2),
    check: { concurrency: num('CHECK_CONCURRENCY', 2), waitSeconds: num('CHECK_WAIT_SECONDS', 300, 5) },
    ingestProjects: list(env.INGEST_PROJECTS),
    excludeProjects: list(env.EXCLUDE_PROJECTS),
    turnRetentionDays: retention,
    memoryAutoApprove: autoApproveRaw === 'true',
    summary,
    github,
    integrationSyncMinutes: num('INTEGRATION_SYNC_MINUTES', 10),
    linkScanMinutes: num('LINK_SCAN_MINUTES', 30),
    apiToken,
    operator,
    publicHosts,
    cloud,
    apiBind,
    apiListen: env.API_LISTEN?.trim() || apiBind,
    port: num('PORT', 8787),
  };
  if (problems.length) throw new ConfigError(problems);
  return config;
}
