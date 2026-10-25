/**
 * fg: drive Feedback Graph from a terminal or an agent, over its HTTP API. No dependencies beyond Node itself, so it
 * runs on the host (scripts/fg) and inside the api container (docker compose exec api node src/cli.ts ...).
 *
 * Owner decisions (selecting projects, scans, Inbox decisions, lessons, Sync now) need FG_OPERATOR_TOKEN, and the API
 * allows only the verbs OPERATOR_ALLOW names. Without it, API_TOKEN (when set) signs in for reading.
 */
import { fileURLToPath } from 'node:url';

export type CliIO = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
};

const USAGE = `fg: drive Feedback Graph from a terminal or an agent

Usage:
  fg status [--watch [--interval 5]]
  fg projects list
  fg projects select --all | --key k1,k2 [--only]    add folders to the selection (--only: exactly these)
  fg projects unselect --key k1,k2
  fg scan --all | --key k1,k2 [--provider codex-cli]
  fg inbox list [--status pending|confirmed|rejected] [--project k] [--limit n]
  fg inbox confirm|reject <id> [<id> ...] [--reason "..."]
  fg lessons list [--status proposed|approved|rejected|superseded] [--project k]
  fg lessons approve|reject <id>
  fg cloud sync-now

Options:
  --json           print the API's JSON instead of a table
  --as <name>      the agent name Activity records (default: FG_OPERATOR_NAME, else fg)
  --url <url>      the API (default: FEEDBACK_GRAPH_URL, else http://localhost:8787)
  --help           this text

Environment:
  FEEDBACK_GRAPH_URL   where the API answers (default http://localhost:8787)
  FG_OPERATOR_TOKEN    lets fg make owner decisions; the API allows only the verbs in OPERATOR_ALLOW (by default
                       not lesson_decide, delete_project, docs_delete, settings, import, integrations). Writes are logged in Activity as operator:<name>.
  API_TOKEN            signs in for reading when FG_OPERATOR_TOKEN is not set
  FG_OPERATOR_NAME     the default for --as`;

// ── Arguments ──────────────────────────────────────────────────────────

type Flags = { json?: true; watch?: true; all?: true; only?: true; help?: true; key?: string[]; provider?: string; status?: string; project?: string; limit?: string; reason?: string; interval?: string; as?: string; url?: string };
export type Parsed = { words: string[]; flags: Flags };

const BOOLEAN = new Set(['json', 'watch', 'all', 'only', 'help']);
const VALUED = new Set(['key', 'provider', 'status', 'project', 'limit', 'reason', 'interval', 'as', 'url']);

export function parse(argv: string[]): Parsed {
  const words: string[] = [];
  const flags: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { words.push(a); continue; }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN.has(name) && eq === -1) { flags[name] = true; continue; }
    if (!VALUED.has(name)) throw new Error(`unknown option --${name} (see fg --help)`);
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Error(`--${name} needs a value`);
    if (name === 'key') flags.key = [...((flags.key as string[]) ?? []), ...value.split(',').map((k) => k.trim()).filter(Boolean)];
    else flags[name] = value;
  }
  return { words, flags: flags as Flags };
}

// ── HTTP ───────────────────────────────────────────────────────────────

class UsageError extends Error {}
class ApiError extends Error {}

const PLAIN_HTTP_OK = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

/** Server text (errors, summaries, model reasons) printed as text, never as terminal escapes. Keeps tabs and newlines. */
const printable = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

function client(io: CliIO, flags: Flags) {
  const base = (flags.url ?? io.env.FEEDBACK_GRAPH_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
  const token = io.env.FG_OPERATOR_TOKEN?.trim() || io.env.API_TOKEN?.trim() || '';
  const name = flags.as ?? io.env.FG_OPERATOR_NAME ?? 'fg';
  if (token) {
    let u: URL;
    try { u = new URL(base); } catch { throw new UsageError(`not a URL: ${base}`); }
    // A bearer token over plain http is readable on the way: only to this machine (or the host, from a container).
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && PLAIN_HTTP_OK.has(u.hostname))) {
      throw new UsageError(`refusing to send the token to ${u.host} over ${u.protocol.replace(':', '')}: use https:// for another machine`);
    }
  }
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { accept: 'application/json', 'x-fg-operator': name };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await io.fetch(`${base}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
    } catch (e) {
      throw new ApiError(`cannot reach Feedback Graph at ${base} (${(e as Error).message}). Is it running? Set FEEDBACK_GRAPH_URL or --url to point elsewhere.`);
    }
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const e = (data as { error?: unknown } | null)?.error ?? data ?? res.statusText;
      const hint = res.status === 401 ? ' (set FG_OPERATOR_TOKEN or API_TOKEN)'
        : res.status === 403 && !io.env.FG_OPERATOR_TOKEN?.trim() ? ' (set FG_OPERATOR_TOKEN in .env, restart, and run fg with it to let agents make this decision)' : '';
      throw new ApiError(`${method} ${path}: ${res.status} ${typeof e === 'string' ? e : JSON.stringify(e)}${hint}`);
    }
    return data as T;
  };
}

const qs = (o: Record<string, string | undefined>) => {
  const p = Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined);
  return p.length ? `?${new URLSearchParams(p)}` : '';
};

// ── Output ─────────────────────────────────────────────────────────────

/** Left-aligned columns, two spaces apart; long cells are cut so a row stays on one line. */
export function table(head: string[], rows: (string | number | null | undefined)[][], max = 60): string {
  const cells = [head, ...rows.map((r) => r.map((c) => {
    const s = String(c ?? '').replace(/\s+/g, ' ');
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }))];
  const widths = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
}

// ── Commands ───────────────────────────────────────────────────────────

type Candidate = { key: string; path: string; exists: boolean; tracked: boolean; excluded: boolean; aliasOf: string | null; claudeSessions: number; codexSessions: number };
type Settings = { tracked: string[]; candidates: Candidate[] };

function statusLines(s: Record<string, any>): string[] {
  const w = s.worker;
  const lines = [
    `version   ${s.version ?? '?'}${s.store ? ` (${s.store})` : ''}`,
    `store     ${s.graph === false ? 'NOT answering' : 'ok'}`,
    `worker    ${s.workerHealthy ? 'ok' : w ? 'stale (no heartbeat lately)' : 'not reported'}${w?.lastCycleAt ? `, last cycle ${w.lastCycleAt}` : ''}`,
  ];
  if (w?.lastCycle) lines.push(`cycle     ${Object.entries(w.lastCycle).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (w?.lastError) lines.push(`error     ${w.lastError}`);
  if (s.selection) lines.push(`projects  ${s.selection.tracked} selected${s.selection.note ? `: ${s.selection.note}` : ''}`);
  for (const [job, m] of Object.entries((s.models ?? {}) as Record<string, any>)) {
    lines.push(`model     ${job.padEnd(10)} ${m.off ? 'off' : `${m.provider ?? 'none'} ${m.ok ? 'ok' : `UNAVAILABLE: ${m.reason ?? ''}`}`}`);
  }
  if (s.givenUpTurns) lines.push(`given up  ${s.givenUpTurns} turns (re-queue them in the UI)`);
  for (const [name, c] of Object.entries((s.connections ?? {}) as Record<string, any>)) lines.push(`${name.padEnd(9)} ${c.state}: ${c.detail}`);
  return lines;
}

async function status(api: ReturnType<typeof client>, io: CliIO, f: Flags): Promise<number> {
  const interval = Math.max(1, Number(f.interval ?? 5)) * 1000;
  for (;;) {
    const s = await api<Record<string, unknown>>('GET', '/api/status');
    if (f.json) io.out(JSON.stringify(s, null, 2));
    else {
      if (f.watch) io.out(`── ${new Date().toISOString()}`);
      for (const l of statusLines(s)) io.out(l);
    }
    if (!f.watch) return 0;
    await io.sleep(interval);
  }
}

async function projects(api: ReturnType<typeof client>, io: CliIO, verb: string | undefined, f: Flags): Promise<number> {
  if (verb === 'list' || verb === undefined) {
    const current = await api<Settings>('GET', '/api/settings/projects');
    if (f.json) { io.out(JSON.stringify(current.candidates, null, 2)); return 0; }
    io.out(table(['KEY', 'SELECTED', 'SESSIONS', 'NOTE', 'PATH'], current.candidates.map((c) => [
      c.key, c.tracked ? 'yes' : 'no', c.claudeSessions + c.codexSessions,
      c.excluded ? 'excluded (EXCLUDE_PROJECTS)' : c.aliasOf ? `clone of ${c.aliasOf}` : !c.exists ? 'folder gone' : '', c.path,
    ])));
    return 0;
  }
  if (verb !== 'select' && verb !== 'unselect') throw new UsageError(`unknown projects command: ${verb}`);
  if (verb === 'unselect' && !f.key?.length) throw new UsageError('fg projects unselect needs --key k1,k2');
  if (verb === 'select' && !f.all && !f.key?.length) throw new UsageError('fg projects select needs --all or --key k1,k2');
  // The API takes the whole list (PUT { tracked }), so fg reads the current one and adds to it, or removes from it.
  const current = await api<Settings>('GET', '/api/settings/projects');
  // What the Settings page would let you tick: a folder that exists, not excluded, and not a clone (a clone follows
  // its project, and the API maps a ticked clone to it anyway).
  const selectable = current.candidates.filter((c) => c.exists && !c.excluded && !c.aliasOf).map((c) => c.key);
  const asked = f.all ? selectable : f.key!;
  const next = verb === 'unselect'
    ? current.tracked.filter((k) => !asked.includes(k))
    : [...new Set([...(f.only ? [] : current.tracked), ...asked])].sort();
  const saved = await api<Settings>('PUT', '/api/settings/projects', { tracked: next });
  if (f.json) io.out(JSON.stringify({ tracked: saved.tracked }, null, 2));
  else io.out(saved.tracked.length ? `selected (${saved.tracked.length}): ${saved.tracked.join(', ')}` : 'no projects selected: no sessions are read');
  return 0;
}

type ScanResult = { key: string; queued: boolean; job?: { id: string; status: string }; error?: string };

async function scan(api: ReturnType<typeof client>, io: CliIO, f: Flags): Promise<number> {
  if (!f.all && !f.key?.length) throw new UsageError('fg scan needs --all or --key k1,k2');
  const body = { ...(f.all ? { all: true } : { keys: f.key }), ...(f.provider && { provider: f.provider }) };
  const { results } = await api<{ results: ScanResult[] }>('POST', '/api/projects/scan', body);
  if (f.json) io.out(JSON.stringify(results, null, 2));
  else io.out(results.length ? table(['PROJECT', 'RESULT'], results.map((r) => [r.key, r.queued ? `queued (${r.job?.id ?? ''})` : r.error])) : 'nothing to scan: no selected folders');
  return results.every((r) => r.queued) ? 0 : 1;
}

async function inbox(api: ReturnType<typeof client>, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, ...ids] = words;
  if (verb === 'list' || verb === undefined) {
    const items = await api<any[]>('GET', `/api/candidates${qs({ status: f.status ?? 'pending', project: f.project, limit: f.limit })}`);
    if (f.json) { io.out(JSON.stringify(items, null, 2)); return 0; }
    io.out(items.length
      ? table(['ID', 'PROJECT', 'SOURCE', 'LABEL', 'CONF', 'SUMMARY'], items.map((c) => [c.id, c.projectKey, c.source, c.classification?.label, c.classification?.confidence?.toFixed(2), c.classification?.summary]))
      : `no ${f.status ?? 'pending'} items`);
    return 0;
  }
  if (verb !== 'confirm' && verb !== 'reject') throw new UsageError(`unknown inbox command: ${verb}`);
  if (!ids.length) throw new UsageError(`fg inbox ${verb} needs at least one item id (see fg inbox list)`);
  const items = ids.map((id) => ({ id, decision: verb, ...(f.reason !== undefined && { reason: f.reason }) }));
  const { results } = await api<{ results: { id: string; ok: boolean; status?: string; error?: string }[] }>('POST', '/api/candidates/decisions', { items });
  if (f.json) io.out(JSON.stringify(results, null, 2));
  else io.out(table(['ID', 'RESULT'], results.map((r) => [r.id, r.ok ? r.status : r.error])));
  return results.every((r) => r.ok) ? 0 : 1;
}

async function lessons(api: ReturnType<typeof client>, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, id] = words;
  if (verb === 'list' || verb === undefined) {
    const list = await api<any[]>('GET', `/api/lessons${qs({ status: f.status ?? 'proposed', project: f.project })}`);
    if (f.json) { io.out(JSON.stringify(list, null, 2)); return 0; }
    io.out(list.length
      ? table(['ID', 'STATUS', 'PROJECT', 'TITLE', 'DECIDED BY'], list.map((l) => [l.id, l.status, l.projectKey ?? 'global', l.title, l.decidedBy ?? '']), 70)
      : `no ${f.status ?? 'proposed'} lessons`);
    return 0;
  }
  if (verb !== 'approve' && verb !== 'reject') throw new UsageError(`unknown lessons command: ${verb}`);
  if (!id) throw new UsageError(`fg lessons ${verb} needs a lesson id (see fg lessons list)`);
  const next = verb === 'approve' ? 'approved' : 'rejected';
  await api('PATCH', `/api/lessons/${encodeURIComponent(id)}`, { status: next });
  io.out(f.json ? JSON.stringify({ id, status: next }) : `${id} ${next}`);
  return 0;
}

async function cloud(api: ReturnType<typeof client>, io: CliIO, verb: string | undefined, f: Flags): Promise<number> {
  if (verb !== 'sync-now' && verb !== 'sync') throw new UsageError('usage: fg cloud sync-now');
  const r = await api<Record<string, unknown>>('POST', '/api/cloud/sync', {});
  io.out(f.json ? JSON.stringify(r, null, 2) : `cloud sync ${r?.ok === false ? `failed: ${r.error ?? ''}` : 'done'}${r?.sent ? `: sent ${JSON.stringify(r.sent)}` : ''}`);
  return r?.ok === false ? 1 : 0;
}

/** Runs one fg command. Exit codes: 0 done, 1 the API refused or something failed, 2 a usage mistake. */
export async function run(argv: string[], raw: CliIO): Promise<number> {
  let io = raw;
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (e) {
    io.err(`fg: ${(e as Error).message}`);
    return 2;
  }
  const { words, flags } = p;
  io = { ...io, out: (l) => raw.out(printable(l)), err: (l) => raw.err(printable(l)) };
  if (flags.help || !words.length || words[0] === 'help') { io.out(USAGE); return 0; }
  try {
    const api = client(io, flags);
    switch (words[0]) {
      case 'status': return await status(api, io, flags);
      case 'projects': return await projects(api, io, words[1], flags);
      case 'scan': return await scan(api, io, flags);
      case 'inbox': return await inbox(api, io, words.slice(1), flags);
      case 'lessons': return await lessons(api, io, words.slice(1), flags);
      case 'cloud': return await cloud(api, io, words[1], flags);
      default: throw new UsageError(`unknown command: ${words[0]}`);
    }
  } catch (e) {
    if (e instanceof UsageError) { io.err(`fg: ${e.message}\n\n${USAGE}`); return 2; }
    if (e instanceof ApiError) { io.err(`fg: ${e.message}`); return 1; }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await run(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  process.exitCode = code;
}
