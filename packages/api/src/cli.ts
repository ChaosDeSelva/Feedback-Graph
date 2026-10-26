/**
 * fg: drive Feedback Graph from a terminal or an agent, over its HTTP API. No dependencies beyond Node itself, so it
 * runs on the host (scripts/fg) and inside the api container (docker compose exec api node src/cli.ts ...).
 *
 * Owner decisions (selecting projects, scans, Inbox decisions, lessons, Sync now) need FG_OPERATOR_TOKEN, and the API
 * allows only the verbs OPERATOR_ALLOW names. Without it, API_TOKEN (when set) signs in for reading.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CliIO = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** For fg docs upload; default: the file system. */
  readFile?: (path: string) => Promise<Buffer>;
  /** For fg integrations set --from-stdin; default: all of standard input. */
  readStdin?: () => Promise<string>;
};

async function allOfStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) parts.push(chunk as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

const USAGE = `fg: drive Feedback Graph from a terminal or an agent

Usage:
  fg status [--watch [--interval 5]] [--until idle|<stage> [--timeout s]]   stages: sync ingest classify postmortem scan docs waiting
  fg pipeline                                    every stage's backlog
  fg projects list [--with-sessions]             every folder (--with-sessions: only those with sessions): selected, pinned, counts, last scan, links
  fg projects select --all | --key k1,k2 | --with-sessions [--only]    add folders to the selection (--only: exactly these;
                                                 --with-sessions: only folders with Claude or Codex sessions)
  fg projects unselect --key k1,k2
  fg scan --all | --key k1,k2 [--provider codex-cli] [--wait [--timeout s]]
  fg inbox list [--status pending|confirmed|rejected] [--source claude|codex|github|linear] [--project k] [--limit n]
  fg inbox show <id>
  fg inbox confirm|reject <id> [<id> ...] [--reason "..."]
  fg lessons list [--status proposed|approved|rejected|superseded] [--project k] [--flag <check>] [--source github|linear|session|memory|manual]
  fg lessons show <id>
  fg lessons approve|reject <id> [<id> ...] [--note "..."]   one batch; each lesson is recorded as decided on its own
  fg lessons quality [--project k]               of the lessons decided in the last 30 and 90 days: approved as written, after an edit, rejected
  fg lessons recheck                             re-run the lesson checks on every proposed and approved lesson (the worker's next round)
  fg lessons to-fact <id> [--kind convention] [--relevance 0.8]   file a lesson that states how the code is as a project fact you wrote; rejects the lesson
  fg demo seed [--project k]                     a small corpus marked demo in demo-shop (approved lessons tied to files, a miss,
                                                 facts) so the lesson path fires; you approve its lessons by running it.
                                                 --project: another project (the owner only: needs lesson_decide)
  fg demo remove [--project k]                   take back exactly what fg demo seed wrote
  fg map rebuild <key>                               remap a project's code from scratch at the worker's next pass (recorded in Activity)
  fg links list --project k
  fg links confirm|dismiss <a> <b> [--relation depends_on|related] [--note "..."]
  fg facts list --project k [--kind k] [--q "search"]
  fg facts relevance <id> <0..1> --project k
  fg docs list --project k
  fg docs upload <file> --project k [--title "..."]   text, or a png/jpeg/webp/gif image
  fg activity [--project k] [--kind k] [--run id] [--limit n]
  fg sessions [--project k] [--limit n]
  fg evidence <session-id>                       what the tool saw in one session and decided: turns, the detector's call
                                                 on each and the skip rules, Inbox items with their post-mortem and lesson, context served
  fg cleanup --run <id> [--apply]                remove what a labelled run wrote: a dry run (counts per kind, what stays and
                                                 why) unless --apply; never what anyone outside the run touched since
  fg cloud status
  fg cloud sync-now [--force]                    sends what changed since the last sync (--force: everything)
  fg integrations status
  fg integrations set github|linear --from-stdin   the token from standard input (never an argument; needs integrations in OPERATOR_ALLOW)
  fg integrations test github|linear             re-check the saved token (a read: no OPERATOR_ALLOW verb needed)
  fg doctor                                      ./scripts/doctor.sh (run by scripts/fg on the host)
  fg setup [args]                                ./scripts/setup.sh with those arguments (run by scripts/fg on the host)

Options:
  --json           print the API's JSON instead of a table; a failure is { "error": "...", "status"? } on stdout
  --wait           fg scan: follow each job until it is done or failed (exit 1 if any failed); progress (shard n of m,
                   facts so far) goes to stderr when it changes and at least every 30 s
  --watch          fg status: the whole status once, then only the lines that changed
  --until <what>   fg status: poll until idle (nothing queued; the GitHub and Linear sync does not hold it up) or that
                   stage; --timeout s gives up (exit 1)
  --as <name>      the agent name Activity records (default: FG_OPERATOR_NAME, else fg)
  --run <id>       label every request with this run (x-fg-run; default: FG_RUN), so fg cleanup --run removes what it wrote;
                   on cleanup and activity it names the run, and cleanup, activity and evidence are never labelled
  --sandbox        with --run: a sandbox run (x-fg-sandbox; default: FG_SANDBOX=1): what it writes is served only to its own agents
  --url <url>      the API (default: FEEDBACK_GRAPH_URL, else http://localhost:8787)
  --help           this text (fg help <command>: that command only)

Environment:
  FEEDBACK_GRAPH_URL   where the API answers (default http://localhost:8787)
  FG_OPERATOR_TOKEN    lets fg make owner decisions; the API allows only the verbs in OPERATOR_ALLOW (by default
                       not lesson_decide, select_projects, delete_project, docs_delete, links_delete, settings, import,
                       integrations, chat, chat_delete). Writes are logged in Activity as operator:<name>.
  API_TOKEN            signs in for reading when FG_OPERATOR_TOKEN is not set
  FG_OPERATOR_NAME     the default for --as
  FG_RUN, FG_SANDBOX   the defaults for --run and --sandbox (FG_SANDBOX=1)`;

// ── Arguments ──────────────────────────────────────────────────────────

type Flags = {
  json?: true; watch?: true; all?: true; only?: true; help?: true; wait?: true; force?: true; 'from-stdin'?: true; 'with-sessions'?: true;
  sandbox?: true; apply?: true; 'dry-run'?: true; run?: string;
  key?: string[]; provider?: string; status?: string; project?: string; limit?: string; reason?: string; interval?: string; as?: string; url?: string;
  until?: string; timeout?: string; kind?: string; q?: string; title?: string; note?: string; relation?: string; source?: string; relevance?: string; flag?: string;
};
export type Parsed = { words: string[]; flags: Flags };

const BOOLEAN = new Set(['json', 'watch', 'all', 'only', 'help', 'wait', 'force', 'from-stdin', 'with-sessions', 'sandbox', 'apply', 'dry-run']);
const VALUED = new Set(['key', 'provider', 'status', 'project', 'limit', 'reason', 'interval', 'as', 'url', 'until', 'timeout', 'kind', 'q', 'title', 'note', 'relation', 'source', 'relevance', 'flag', 'run']);

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
    if (!VALUED.has(name)) throw new Error(`unknown option --${name}`);
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Error(`--${name} needs a value`);
    if (name === 'key') flags.key = [...((flags.key as string[]) ?? []), ...value.split(',').map((k) => k.trim()).filter(Boolean)];
    else flags[name] = value;
  }
  return { words, flags: flags as Flags };
}

// ── HTTP ───────────────────────────────────────────────────────────────

class UsageError extends Error {}
class ApiError extends Error {
  /** The HTTP status the API answered with; unset when it could not be reached. */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const PLAIN_HTTP_OK = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

/** Server text (errors, summaries, model reasons) printed as text, never as terminal escapes. Keeps tabs and newlines. */
const printable = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

type Api = ReturnType<typeof client>;

/** Verbs whose requests are never part of a run (cleanup, and reading what runs did). */
const UNLABELLED = new Set(['cleanup', 'activity', 'evidence']);

function client(io: CliIO, flags: Flags, labels = true) {
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
  // A run label (fg cleanup --run removes what the run wrote); the API checks it and refuses a malformed one. Not on
  // cleanup, activity or evidence: their --run names the run to clean or list, and labelling would claim it.
  const runId = labels ? flags.run ?? io.env.FG_RUN?.trim() ?? '' : '';
  const sandbox = labels && (!!flags.sandbox || io.env.FG_SANDBOX?.trim() === '1');
  if (sandbox && !runId) throw new UsageError('--sandbox needs --run <id> (or FG_RUN): a sandbox run is cleaned up by its id');
  const runHeaders: Record<string, string> = runId ? { 'x-fg-run': runId, ...(sandbox && { 'x-fg-sandbox': '1' }) } : {};
  const authHeaders = (): Record<string, string> => ({ 'x-fg-operator': name, ...runHeaders, ...(token && { authorization: `Bearer ${token}` }) });
  /** A server-sent event stream; null when the API has none there (an older version) or cannot be reached. */
  const events = async (path: string): Promise<{ events: AsyncGenerator<SseEvent>; close(): void } | null> => {
    const ctl = new AbortController();
    const res = await io.fetch(`${base}${path}`, { headers: { ...authHeaders(), accept: 'text/event-stream' }, signal: ctl.signal }).catch(() => null);
    if (!res?.ok || !res.body || !res.headers.get('content-type')?.startsWith('text/event-stream')) {
      await res?.body?.cancel().catch(() => {});
      return null;
    }
    return { events: readSse(res.body), close: () => ctl.abort() };
  };
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { accept: 'application/json', ...authHeaders() };
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
      throw new ApiError(`${method} ${path}: ${res.status} ${typeof e === 'string' ? e : JSON.stringify(e)}${hint}`, res.status);
    }
    return data as T;
  };
  return Object.assign(api, { events });
}

type SseEvent = { event: string; data: string };

/** The events of a text/event-stream body, as they complete; comments (heartbeats) and retry hints are skipped. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      for (let end = buf.indexOf('\n\n'); end !== -1; end = buf.indexOf('\n\n')) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
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
/** A folder with Claude Code or Codex sessions on disk (what Settings counts for it). */
const hasSessions = (c: Pick<Candidate, 'claudeSessions' | 'codexSessions'>) => (c.claudeSessions ?? 0) + (c.codexSessions ?? 0) > 0;
type Settings = { tracked: string[]; candidates: Candidate[] };

/** An ISO time as `2026-10-25 03:38:29` (UTC, as the API gives it). */
const at = (iso: string | null | undefined) => (iso ? iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '') : '');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

type Pipeline = Record<string, any>;

/** LessonQuality (GET /api/lessons/quality, /api/pipeline lessons.quality). */
type Quality = { days: number; asWritten: number; edited: number; rejected: number; decided: number };
const pct = (n: number, of: number) => `${n} (${of ? Math.round((100 * n) / of) : 0}%)`;
/** How the owner judged the lessons the post-mortem wrote, in one window. */
function qualityLine(q: Quality): string {
  const share = (n: number) => `${Math.round((100 * n) / q.decided)}%`;
  return q.decided
    ? `last ${q.days} d: ${q.decided} decided: ${q.asWritten} approved as written (${share(q.asWritten)}), ${q.edited} after an edit (${share(q.edited)}), ${q.rejected} rejected (${share(q.rejected)})`
    : `last ${q.days} d: no lessons decided`;
}

/** One line of every stage's backlog, for status. */
function pipelineLine(p: Pipeline): string {
  const parts = [];
  if (p.classify) parts.push(`classify ${p.classify.backlog}${p.classify.capped ? '+' : ''}`);
  if (p.inbox) parts.push(`inbox ${p.inbox.pending} pending`);
  if (p.postmortems) parts.push(`postmortems ${p.postmortems.queued}`);
  if (p.lessons) parts.push(`lessons ${p.lessons.proposed} proposed`);
  if (p.scans) parts.push(`scans ${p.scans.running} running, ${p.scans.queued} queued${p.scans.failed ? `, ${p.scans.failed} failed` : ''}`);
  return parts.join(' · ');
}

/** How long since an ISO time, roughly: `40 s`, `14 min`, `3 h`, `2 d`. */
export function waited(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

const QUEUE_LABEL: Record<string, string> = { scans: 'scans', classify: 'classify', postmortems: 'post-mortems', chats: 'Ask answers' };
/** Scans listed by project under the scan queue's line at most. */
const QUEUE_PROJECTS = 10;

/** One line per queue (pipeline.queues): how many wait, the oldest wait, what runs now and for how long; then each scan. */
function queueLines(queues: Record<string, any> | undefined): string[] {
  if (!queues) return [];
  const lines: string[] = [];
  for (const [name, q] of Object.entries(queues)) {
    if (!q) continue;
    const head = q.waiting
      ? `${q.waiting}${q.capped ? '+' : ''} waiting${q.oldestAt ? `, oldest ${q.capped ? 'at least ' : ''}${waited(q.oldestAt)}` : ''}`
      : 'none waiting';
    const runs = (q.running ?? []).map((r: { what: string; since: string; shards?: { done: number; total: number } | null }) =>
      `running ${r.shards ? `shard ${Math.min(r.shards.done + 1, r.shards.total)}/${r.shards.total} of ` : ''}${r.what} for ${waited(r.since)}`);
    lines.push(`queue     ${QUEUE_LABEL[name] ?? name}: ${[head, ...runs].join('; ')}`);
    if (name !== 'scans') continue;
    const projects = (q.projects ?? []) as { project: string; status: string; since: string; shards: { done: number; total: number } | null }[];
    for (const j of projects.slice(0, QUEUE_PROJECTS)) {
      const shards = j.shards ? `, ${j.shards.done} of ${plural(j.shards.total, 'shard')} done` : '';
      lines.push(`          ${j.project.padEnd(20)} ${j.status} ${waited(j.since)}${shards}`);
    }
    if (projects.length > QUEUE_PROJECTS) lines.push(`          and ${projects.length - QUEUE_PROJECTS} more`);
  }
  return lines;
}

function statusLines(s: Record<string, any>, p: Pipeline | null): string[] {
  const w = s.worker;
  const lines = [
    `version   ${s.version ?? '?'}${s.store ? ` (${s.store})` : ''}`,
    `store     ${s.graph === false ? 'NOT answering' : 'ok'}`,
    `worker    ${s.workerHealthy ? 'ok' : w ? 'stale (no heartbeat lately)' : 'not reported'}${w?.lastCycleAt ? `, last cycle ${w.lastCycleAt}` : ''}`,
  ];
  if (s.stage) {
    const pr = s.progress;
    const count = pr ? ` (${pr.total === null ? `${pr.done} done` : `${pr.done} of ${pr.total}`})` : '';
    lines.push(`stage     ${s.stage.name}${s.stage.current ? ` ${s.stage.current}` : ''}${count} since ${at(s.stage.startedAt)}`);
  }
  if (p) lines.push(`pipeline  ${pipelineLine(p)}`, ...queueLines(p.queues));
  const judged = (p?.lessons?.quality as Quality[] | undefined)?.[0];
  if (judged) lines.push(`lessons   ${qualityLine(judged)}`);
  const older = p?.scans?.olderScanner;
  if (older?.files) {
    const where = Object.entries((older.projects ?? {}) as Record<string, number>).map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(`scanner   ${plural(older.files, 'file')} ${older.files === 1 ? 'was' : 'were'} read by an older scanner${where ? ` (${where})` : ''}: press Scan on the Projects page (or fg scan <project>) to refresh ${older.files === 1 ? 'it' : 'them'}`);
  }
  if (w?.lastCycle) lines.push(`cycle     ${Object.entries(w.lastCycle).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (w?.lastError) lines.push(`error     ${w.lastError}`);
  if (s.selection) lines.push(`projects  ${s.selection.tracked} selected${s.selection.note ? `: ${s.selection.note}` : ''}`);
  for (const [job, m] of Object.entries((s.models ?? {}) as Record<string, any>)) {
    const down = `UNAVAILABLE${m.since ? ` since ${at(m.since)}` : ''}: ${m.reason ?? ''}`;
    lines.push(`model     ${job.padEnd(10)} ${m.off ? 'off' : `${m.provider ?? 'none'} ${m.ok ? 'ok' : down}`}`);
  }
  if (s.givenUpTurns) lines.push(`given up  ${s.givenUpTurns} turns (re-queue them in the UI)`);
  for (const [name, c] of Object.entries((s.connections ?? {}) as Record<string, any>)) lines.push(`${name.padEnd(9)} ${c.state}: ${c.detail}`);
  const sync = s.cloud?.syncing;
  if (sync) lines.push(`syncing   ${sync.done} of ${sync.total} projects${sync.current ? ` (${sync.current})` : ''} since ${at(sync.startedAt)}`);
  const m = s.cloud?.lastManual;
  if (m) {
    const sent = m.sent?.projects ?? 0;
    lines.push(`sync now  ${at(m.at)} ${m.ok ? 'ok' : `FAILED: ${m.error ?? ''}`}: sent ${plural(sent, 'project')}, ${m.unchanged} unchanged${m.failed ? `, ${m.failed} failed` : ''}`);
  }
  return lines;
}

/**
 * Idle: the worker is waiting, nothing is waiting for the classifier, a post-mortem or a scan, and no Sync now runs. The
 * worker's GitHub and Linear sync (stage sync) counts as idle too: it can take minutes against the services' rate
 * limits, and what it finds is new work for the next cycle, not work anyone is waiting on.
 */
function isIdle(s: Record<string, any>, p: Pipeline | null): boolean {
  if ((s.stage?.name !== 'waiting' && s.stage?.name !== 'sync') || !p) return false;
  return (p.classify?.backlog ?? 0) === 0 && (p.postmortems?.queued ?? 0) === 0 && (p.scans?.queued ?? 0) === 0 && (p.scans?.running ?? 0) === 0 && !s.cloud?.syncing;
}

const STAGES = new Set(['sync', 'ingest', 'classify', 'postmortem', 'scan', 'docs', 'waiting']);

const seconds = (raw: string | undefined, d: number, what: string) => {
  const n = raw === undefined ? d : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${what} must be a number of seconds above 0`);
  return n;
};

async function status(api: Api, io: CliIO, f: Flags): Promise<number> {
  const interval = Math.max(1, Number(f.interval ?? 5)) * 1000;
  const until = f.until;
  if (until !== undefined && until !== 'idle' && !STAGES.has(until)) throw new UsageError(`--until takes idle or a stage (${[...STAGES].join(', ')})`);
  const timeout = f.timeout === undefined ? null : seconds(f.timeout, 0, '--timeout') * 1000;
  // /api/events says when something changed, so the watch need not poll; an API without it (or a dropped stream) is polled.
  // Both print through one printer: the whole status once, then only the lines that changed.
  const print = watchPrinter(io, f);
  if (f.watch && until === undefined) await watchEvents(api, io, f, print);
  let waited = 0;
  for (;;) {
    const s = await api<Record<string, any>>('GET', '/api/status');
    // The backlog is a second call; an older API without it still gets the rest.
    const p = await api<Pipeline>('GET', '/api/pipeline').catch(() => null);
    const reached = until === 'idle' ? isIdle(s, p) : until !== undefined && s.stage?.name === until;
    if (until !== undefined) {
      if (reached) {
        const syncing = until === 'idle' && s.stage?.name === 'sync';
        io.out(f.json ? JSON.stringify({ ...s, pipeline: p }, null, 2)
          : syncing ? `idle: nothing is queued (the worker is syncing GitHub and Linear comments since ${at(s.stage?.startedAt)})`
          : `${until === 'idle' ? 'idle' : `stage ${until}`} since ${at(s.stage?.startedAt)}`);
        return 0;
      }
      if (timeout !== null && waited + interval > timeout) {
        io.err(`fg: still not ${until === 'idle' ? 'idle' : `at stage ${until}`} after ${Math.round(timeout / 1000)} s: ${s.stage ? `stage ${s.stage.name}` : 'no stage reported'}${p ? `; ${pipelineLine(p)}` : ''}`);
        return 1;
      }
    } else if (f.watch) print(s, p);
    else if (f.json) io.out(JSON.stringify(s, null, 2));
    else for (const l of statusLines(s, p)) io.out(l);
    if (!f.watch && until === undefined) return 0;
    await io.sleep(interval);
    waited += interval;
  }
}

/** How long fg status --watch waits after a change for the ones that come with it (the stage and the counts), to print once. */
const SETTLE_MS = 250;

/**
 * fg status --watch over /api/events: the status again when the stage, a count, a scan or an Ask answer changes (and
 * only if what it prints changed), and each new Activity entry as a line. Returns when the stream ends or is not there.
 */
type Printer = (s: Record<string, any>, p: Pipeline | null) => void;

/**
 * fg status --watch's output: the whole status the first time, then under a timestamp only the lines that are new since
 * the last print (nothing at all when nothing changed). --json prints the whole status again whenever it changed.
 */
function watchPrinter(io: CliIO, f: Flags): Printer {
  let last: string[] | null = null;
  return (s, p) => {
    const lines = f.json ? [JSON.stringify(s, null, 2)] : statusLines(s, p);
    const fresh = last ? lines.filter((l) => !last!.includes(l)) : lines;
    last = lines;
    if (!fresh.length) return;
    if (!f.json) io.out(`── ${new Date().toISOString()}`);
    for (const l of fresh) io.out(l);
  };
}

async function watchEvents(api: Api, io: CliIO, f: Flags, print: Printer): Promise<void> {
  const stream = await api.events('/api/events');
  if (!stream) return;
  try {
    await follow(stream.events);
  } finally {
    // An open stream would keep fg running after an error.
    stream.close();
  }

  async function follow(events: AsyncGenerator<SseEvent>) {
    const show = async () => {
      const s = await api<Record<string, any>>('GET', '/api/status');
      const p = await api<Pipeline>('GET', '/api/pipeline').catch(() => null);
      print(s, p);
    };
    await show();
    let changed = false;
    let ended = false;
    let wake = () => {};
    const reading = (async () => {
      try {
        for await (const e of events) {
          if (e.event !== 'activity') {
            changed = true;
            wake();
            continue;
          }
          const a = JSON.parse(e.data) as { kind: string; subject: string; projectKey: string | null };
          io.out(f.json ? JSON.stringify({ event: 'activity', data: a }) : `activity  ${a.kind}${a.projectKey ? ` [${a.projectKey}]` : ''}: ${a.subject}`);
        }
      } catch { /* a dropped stream: back to polling */ } finally {
        ended = true;
        wake();
      }
    })();
    for (;;) {
      if (!changed && !ended) await new Promise<void>((resolve) => { wake = resolve; });
      if (!changed) break;
      await io.sleep(SETTLE_MS);
      changed = false;
      await show();
    }
    await reading;
  }
}

async function pipelineCmd(api: Api, io: CliIO, f: Flags): Promise<number> {
  const p = await api<Pipeline>('GET', '/api/pipeline');
  if (f.json) { io.out(JSON.stringify(p, null, 2)); return 0; }
  const n = (x: unknown) => (x === null || x === undefined ? 'unknown' : String(x));
  io.out(table(['STAGE', 'COUNT'], [
    ['worker', p.stage ? `${p.stage.name}${p.stage.current ? ` ${p.stage.current}` : ''} since ${at(p.stage.startedAt)}` : 'not reported'],
    ['sessions', n(p.sessions)],
    ['classify', p.classify ? `${p.classify.backlog}${p.classify.capped ? '+' : ''} waiting` : 'unknown'],
    ['inbox', p.inbox ? `${p.inbox.pending} pending, ${p.inbox.confirmed} confirmed` : 'unknown'],
    ['postmortems', p.postmortems ? `${p.postmortems.queued} queued` : 'unknown'],
    ['lessons', p.lessons ? `${p.lessons.proposed} proposed, ${p.lessons.approved} approved` : 'unknown'],
    ['scans', p.scans ? `${p.scans.done} done, ${p.scans.queued} queued, ${p.scans.running} running, ${p.scans.failed} failed, ${p.scans.never} never` : 'unknown'],
  ], 100));
  return 0;
}

async function projects(api: Api, io: CliIO, verb: string | undefined, f: Flags): Promise<number> {
  if (verb === 'list' || verb === undefined) {
    // Every folder (Settings) joined with what each shown project holds (/api/projects) and its links.
    const [current, shown] = await Promise.all([api<Settings>('GET', '/api/settings/projects'), api<any[]>('GET', '/api/projects')]);
    const byKey = new Map(shown.map((p) => [p.key, p]));
    const linkCounts = new Map<string, Record<string, number>>();
    const keys = shown.map((p) => p.key as string);
    // A few at a time: one request per project.
    for (let i = 0; i < keys.length; i += 8) {
      await Promise.all(keys.slice(i, i + 8).map(async (key) => {
        const links = await api<{ status: string }[]>('GET', `/api/projects/${encodeURIComponent(key)}/links`).catch(() => null);
        if (!links) return;
        const n: Record<string, number> = { confirmed: 0, suggested: 0, dismissed: 0 };
        for (const l of links) n[l.status] = (n[l.status] ?? 0) + 1;
        linkCounts.set(key, n);
      }));
    }
    const all = [...current.candidates.map((c) => c.key), ...keys.filter((k) => !current.candidates.some((c) => c.key === k))].map((key) => {
      const c = current.candidates.find((x) => x.key === key);
      const p = byKey.get(key);
      return {
        key, path: c?.path ?? p?.repoPath ?? '', exists: c?.exists ?? true, tracked: c?.tracked ?? true, excluded: c?.excluded ?? false, aliasOf: c?.aliasOf ?? null,
        claudeSessions: c?.claudeSessions ?? 0, codexSessions: c?.codexSessions ?? 0,
        pinned: !!p?.pinned, sessions: p?.sessions ?? null, feedback: p?.feedback ?? null, lessons: p?.lessons ?? null, facts: p?.facts ?? null,
        remote: p?.remote ?? null, lastScan: p?.lastScan ?? null, links: linkCounts.get(key) ?? null,
      };
    });
    // Sessions on disk (Settings), or recorded for a shown project.
    const rows = f['with-sessions'] ? all.filter((r) => hasSessions(r) || (r.sessions ?? 0) > 0) : all;
    if (f.json) { io.out(JSON.stringify(rows, null, 2)); return 0; }
    const scanOf = (s: any) => (s ? `${s.status}${s.finishedAt || s.startedAt || s.requestedAt ? ` ${at(s.finishedAt ?? s.startedAt ?? s.requestedAt).slice(0, 16)}` : ''}` : '');
    const linksOf = (n: Record<string, number> | null) => (n ? Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') : '');
    io.out(table(['KEY', 'SELECTED', 'PINNED', 'SESSIONS', 'FEEDBACK', 'LESSONS', 'FACTS', 'LAST SCAN', 'LINKS', 'NOTE', 'PATH'], rows.map((r) => [
      r.key, r.tracked ? 'yes' : 'no', r.pinned ? 'yes' : '', r.sessions ?? r.claudeSessions + r.codexSessions, r.feedback ?? '', r.lessons ?? '', r.facts ?? '',
      scanOf(r.lastScan), linksOf(r.links),
      r.excluded ? 'excluded (EXCLUDE_PROJECTS)' : r.aliasOf ? `clone of ${r.aliasOf}` : !r.exists ? 'folder gone' : '', r.path,
    ])));
    return 0;
  }
  if (verb !== 'select' && verb !== 'unselect') throw new UsageError(`unknown projects command: ${verb}`);
  if (verb === 'unselect' && !f.key?.length) throw new UsageError('fg projects unselect needs --key k1,k2');
  if (verb === 'select' && !f.all && !f.key?.length && !f['with-sessions']) throw new UsageError('fg projects select needs --all, --key k1,k2 or --with-sessions');
  // The API takes the whole list (PUT { tracked }), so fg reads the current one and adds to it, or removes from it.
  const current = await api<Settings>('GET', '/api/settings/projects');
  // What the Settings page would let you tick: a folder that exists, not excluded, and not a clone (a clone follows
  // its project, and the API maps a ticked clone to it anyway).
  const selectable = current.candidates.filter((c) => c.exists && !c.excluded && !c.aliasOf).map((c) => c.key);
  const withSessions = new Set(current.candidates.filter(hasSessions).map((c) => c.key));
  const named = f.key?.length ? f.key : selectable;
  const asked = verb === 'select' && f['with-sessions'] ? named.filter((k) => selectable.includes(k) && withSessions.has(k)) : f.all ? selectable : f.key!;
  const next = verb === 'unselect'
    ? current.tracked.filter((k) => !asked.includes(k))
    : [...new Set([...(f.only ? [] : current.tracked), ...asked])].sort();
  const saved = await api<Settings>('PUT', '/api/settings/projects', { tracked: next });
  if (f.json) io.out(JSON.stringify({ tracked: saved.tracked }, null, 2));
  else io.out(saved.tracked.length ? `selected (${saved.tracked.length}): ${saved.tracked.join(', ')}` : 'no projects selected: no sessions are read');
  return 0;
}

type ScanResult = { key: string; queued: boolean; job?: { id: string; status: string }; error?: string };

async function scan(api: Api, io: CliIO, f: Flags): Promise<number> {
  if (!f.all && !f.key?.length) throw new UsageError('fg scan needs --all or --key k1,k2');
  const body = { ...(f.all ? { all: true } : { keys: f.key }), ...(f.provider && { provider: f.provider }) };
  const { results } = await api<{ results: ScanResult[] }>('POST', '/api/projects/scan', body);
  if (f.wait) return waitForScans(api, io, f, results);
  if (f.json) io.out(JSON.stringify(results, null, 2));
  else io.out(results.length ? table(['PROJECT', 'RESULT'], results.map((r) => [r.key, r.queued ? `queued (${r.job?.id ?? ''})` : r.error])) : 'nothing to scan: no selected folders');
  return results.every((r) => r.queued) ? 0 : 1;
}

type ScanJobView = {
  id: string; projectKey: string; status: string; filesScanned?: number; factsAdded?: number; error?: string | null; queuePosition?: number | null;
  /** An agentic scan's shards: done (so far, while it runs) of total. */
  shards?: { total: number; done?: number; rescanned: number; failed: number } | null;
};

/** fg scan --wait prints a job's progress when it changes, and at least this often while it does not. */
const PROGRESS_EVERY_MS = 30_000;
const elapsed = (ms: number) => `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;

/** A job still going, in one line: where it is in the queue, or how many shards are done and facts saved so far. */
function progressLine(j: ScanJobView): string {
  const where = j.status === 'queued' && j.queuePosition ? ` (${ordinal(j.queuePosition)} in the queue)` : '';
  const shards = j.shards?.total ? `, shard ${j.shards.done ?? j.shards.rescanned} of ${j.shards.total}` : '';
  const facts = j.status === 'running' ? `, ${plural(j.factsAdded ?? 0, 'fact')} so far` : '';
  return `${j.projectKey}: ${j.status}${where}${shards}${facts}`;
}

/** Poll GET /api/scans/:id for each queued job until all are done or failed, or --timeout runs out. */
async function waitForScans(api: Api, io: CliIO, f: Flags, results: ScanResult[]): Promise<number> {
  const interval = Math.max(1, Number(f.interval ?? 5)) * 1000;
  const timeout = seconds(f.timeout, 1800, '--timeout') * 1000;
  const jobs = new Map<string, ScanJobView>();
  for (const r of results) if (r.queued && r.job) jobs.set(r.job.id, { id: r.job.id, projectKey: r.key, status: r.job.status });
  const finished = (j: ScanJobView) => j.status === 'done' || j.status === 'failed';
  // Progress goes to stderr, so stdout stays the result table (or --json).
  const printed = new Map<string, { line: string; at: number }>();
  let waited = 0;
  for (;;) {
    for (const j of [...jobs.values()].filter((x) => !finished(x))) jobs.set(j.id, await api<ScanJobView>('GET', `/api/scans/${encodeURIComponent(j.id)}`));
    for (const j of jobs.values()) {
      if (finished(j)) continue;
      const line = progressLine(j);
      const last = printed.get(j.id);
      if (last && last.line === line && waited - last.at < PROGRESS_EVERY_MS) continue;
      io.err(`${line} (${elapsed(waited)})`);
      printed.set(j.id, { line, at: waited });
    }
    if ([...jobs.values()].every(finished) || waited + interval > timeout) break;
    await io.sleep(interval);
    waited += interval;
  }
  const all = [...jobs.values()];
  const refused = results.filter((r) => !r.queued);
  if (f.json) io.out(JSON.stringify({ jobs: all, refused }, null, 2));
  else {
    const line = (j: ScanJobView) => j.status === 'done'
      ? `done: ${plural(j.filesScanned ?? 0, 'file')}, ${plural(j.factsAdded ?? 0, 'fact')}${j.filesScanned ? '' : ' (nothing changed since the last scan)'}`
      : j.status === 'failed' ? `failed: ${j.error ?? 'no reason given'}`
      : `still ${j.status}${j.queuePosition ? ` (${ordinal(j.queuePosition)} in the queue)` : ''}`;
    io.out(table(['PROJECT', 'RESULT'], [...all.map((j) => [j.projectKey, line(j)]), ...refused.map((r) => [r.key, r.error])], 100));
  }
  return refused.length || all.some((j) => j.status !== 'done') ? 1 : 0;
}

/** Where an Inbox item came from (FeedbackSource). */
const SOURCES = ['claude', 'codex', 'github', 'linear'];

async function inbox(api: Api, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, ...ids] = words;
  if (verb === 'list' || verb === undefined) {
    if (f.source !== undefined && !SOURCES.includes(f.source)) throw new UsageError(`--source takes one of ${SOURCES.join(', ')}`);
    const items = await api<any[]>('GET', `/api/candidates${qs({ status: f.status ?? 'pending', source: f.source, project: f.project, limit: f.limit })}`);
    if (f.json) { io.out(JSON.stringify(items, null, 2)); return 0; }
    io.out(items.length
      ? table(['ID', 'PROJECT', 'SOURCE', 'LABEL', 'CONF', 'SUMMARY'], items.map((c) => [c.id, c.projectKey, c.source, c.classification?.label, c.classification?.confidence?.toFixed(2), c.classification?.summary]))
      : `no ${f.status ?? 'pending'} items${f.source ? ` from ${f.source}` : ''}`);
    return 0;
  }
  if (verb === 'show') {
    if (!ids[0]) throw new UsageError('fg inbox show needs an item id (see fg inbox list)');
    const d = await api<any>('GET', `/api/candidates/${encodeURIComponent(ids[0])}`);
    if (f.json) { io.out(JSON.stringify(d, null, 2)); return 0; }
    const c = d.candidate;
    const ext = c.external;
    io.out(table(['FIELD', 'VALUE'], [
      ['id', c.id], ['project', c.projectKey], ['source', c.source],
      ['status', `${c.status}${c.decidedBy ? ` by ${c.decidedBy}` : ''}${c.decidedAt ? ` at ${at(c.decidedAt)}` : ''}`],
      ['label', `${c.classification?.label ?? ''} (${c.classification?.confidence ?? ''}): ${c.classification?.summary ?? ''}`],
      ...(ext ? [['author', `${ext.author ?? ''}${ext.authorKind ? ` (${ext.authorKind})` : ''}`], ['url', ext.url ?? '']] : []),
      ['comment', d.turn?.text ?? ''],
      ...(c.note ? [['note', c.note]] : []),
      ...(c.agentReport ? [['reported', c.agentReport.text]] : []),
      ...(d.postmortem ? [['postmortem', d.postmortem.done ? 'done' : d.postmortem.gaveUp ? `gave up: ${d.postmortem.lastError ?? ''}` : `attempt ${d.postmortem.attempts}${d.postmortem.retryAt ? `, next ${at(d.postmortem.retryAt)}` : ''}`]] : []),
    ], 400));
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

async function lessons(api: Api, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, id] = words;
  if (verb === 'list' || verb === undefined) {
    const list = await api<any[]>('GET', `/api/lessons${qs({ status: f.status ?? 'proposed', project: f.project, flag: f.flag, source: f.source })}`);
    if (f.json) { io.out(JSON.stringify(list, null, 2)); return 0; }
    io.out(list.length
      ? table(['ID', 'STATUS', 'PROJECT', 'FROM', 'FLAGS', 'TITLE', 'DECIDED BY'], list.map((l) => [
        l.id, l.status, l.projectKey ?? 'global', l.from ?? '', (l.checks ?? []).map((c: { name: string }) => c.name).join(','), l.title, l.decidedBy ?? '',
      ]), 70)
      : `no ${f.status ?? 'proposed'} lessons`);
    return 0;
  }
  if (verb === 'quality') {
    const r = await api<{ windows: Quality[]; projects: Record<string, Quality[]>; capped?: true }>('GET', `/api/lessons/quality${qs({ project: f.project })}`);
    if (f.json) { io.out(JSON.stringify(r, null, 2)); return 0; }
    const rows = [['all', r.windows] as const, ...Object.entries(r.projects).sort(([a], [b]) => a.localeCompare(b))].flatMap(([k, ws]) =>
      ws.map((q) => [k, String(q.days), String(q.decided), pct(q.asWritten, q.decided), pct(q.edited, q.decided), pct(q.rejected, q.decided)]));
    io.out(table(['PROJECT', 'DAYS', 'DECIDED', 'AS WRITTEN', 'AFTER EDIT', 'REJECTED'], rows, 40));
    if (r.capped) io.out('(capped: more decisions than were counted; the oldest are left out)');
    return 0;
  }
  if (verb === 'recheck') {
    const r = await api<{ queued: number }>('POST', '/api/lessons/recheck', {});
    io.out(f.json ? JSON.stringify(r) : `${r.queued} lessons queued for a re-check: the worker re-runs the checks at its next round (fg activity --kind lessons_checked)`);
    return 0;
  }
  if (verb === 'show') {
    if (!id) throw new UsageError('fg lessons show needs a lesson id (see fg lessons list)');
    const d = await api<any>('GET', `/api/lessons/${encodeURIComponent(id)}`);
    if (f.json) { io.out(JSON.stringify(d, null, 2)); return 0; }
    const l = d.lesson;
    io.out(table(['FIELD', 'VALUE'], [
      ['id', l.id], ['status', `${l.status}${l.decidedBy ? ` by ${l.decidedBy}` : ''}`], ['project', l.projectKey ?? 'global'], ['scope', l.scope],
      ['title', l.title], ['rule', l.rule], ['applies', l.appliesWhen], ['paths', (l.paths ?? []).join(', ')],
      ...(d.miss ? [['missed', `${d.miss.missed} (${d.miss.cause ?? ''})`]] : []),
      ...(d.feedback ? [['feedback', d.feedback.text]] : []),
    ], 400));
    return 0;
  }
  if (verb === 'to-fact') {
    if (!id) throw new UsageError('fg lessons to-fact needs a lesson id (see fg lessons list)');
    const relevance = f.relevance === undefined ? undefined : Number(f.relevance);
    if (relevance !== undefined && !(Number.isFinite(relevance) && relevance >= 0 && relevance <= 1)) throw new UsageError('--relevance takes a number from 0 to 1');
    // The API checks the kind (FACT_KINDS) and defaults to convention, relevance 0.8 (everyday).
    const fact = await api<any>('POST', `/api/lessons/${encodeURIComponent(id)}/to-fact`, { ...(f.kind && { kind: f.kind }), ...(relevance !== undefined && { relevance }) });
    io.out(f.json ? JSON.stringify(fact, null, 2) : `${id} converted to a ${fact.kind} fact ${fact.id} (${fact.path}); the lesson is rejected (fg facts list --project <key>)`);
    return 0;
  }
  if (verb !== 'approve' && verb !== 'reject') throw new UsageError(`unknown lessons command: ${verb}`);
  const ids = words.slice(1);
  if (!ids.length) throw new UsageError(`fg lessons ${verb} needs at least one lesson id (see fg lessons list)`);
  const status = verb === 'approve' ? 'approved' : 'rejected';
  const items = ids.map((lessonId) => ({ id: lessonId, status, ...(f.note !== undefined && { note: f.note }) }));
  const { results } = await api<{ results: { id: string; ok: boolean; status?: string; error?: string }[] }>('POST', '/api/lessons/decisions', { items });
  if (f.json) io.out(JSON.stringify(results, null, 2));
  else io.out(table(['ID', 'RESULT'], results.map((r) => [r.id, r.ok ? r.status : r.error])));
  return results.every((r) => r.ok) ? 0 : 1;
}

async function cloud(api: Api, io: CliIO, verb: string | undefined, f: Flags): Promise<number> {
  if (verb === 'status') {
    const c = await api<any>('GET', '/api/cloud');
    if (f.json) { io.out(JSON.stringify(c, null, 2)); return 0; }
    if (!c.enabled) { io.out('cloud sync is off: set CLOUD_URL and CLOUD_TOKEN in .env and restart'); return 0; }
    const t = c.preview?.total;
    io.out(table(['FIELD', 'VALUE'], [
      ['host', `${c.host}, ${c.intervalMinutes ? `every ${c.intervalMinutes} min${c.nextAt ? `, next ${at(c.nextAt)}` : ''}` : 'only on Sync now'}`],
      ['projects', `${c.projects.length}: ${c.projects.join(', ')}`],
      ['lessons', c.suggestions ? 'approved and proposed (SYNC_SUGGESTIONS)' : 'approved only'],
      ...(t ? [['would send', `${t.projects} projects, ${t.lessons} lessons, ${t.misses} misses, ${t.facts} facts, ${t.docs} docs, ${t.codeFiles} code files`]] : []),
      ...(c.previewError ? [['preview', `failed: ${c.previewError}`]] : []),
      ['last', c.last ? `${at(c.last.at)} (${c.last.trigger}) ${c.last.ok ? 'ok' : `FAILED: ${c.last.error ?? ''}`}` : 'never'],
    ], 200));
    return 0;
  }
  if (verb !== 'sync-now' && verb !== 'sync') throw new UsageError('usage: fg cloud status | fg cloud sync-now [--force]');
  // The sync is one request that can take minutes: show its progress on stderr while it runs.
  let done = false;
  const sync = api<Record<string, any>>('POST', '/api/cloud/sync', f.force ? { force: true } : {}).finally(() => { done = true; });
  let shown = '';
  while (!done) {
    await Promise.race([sync.catch(() => null), io.sleep(2000)]);
    if (done) break;
    const pr = await api<{ running: { done: number; total: number; current: string | null } | null }>('GET', '/api/cloud/progress').catch(() => null);
    const line = pr?.running ? `syncing ${pr.running.done} of ${pr.running.total}${pr.running.current ? ` (${pr.running.current})` : ''}` : '';
    if (line && line !== shown) io.err(line);
    shown = line;
  }
  const r = await sync;
  if (f.json) { io.out(JSON.stringify(r, null, 2)); return r?.ok === false ? 1 : 0; }
  const by: Record<string, number> = {};
  for (const p of (r?.projects ?? []) as { status: string }[]) by[p.status] = (by[p.status] ?? 0) + 1;
  const summary = Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ');
  io.out(`cloud sync ${r?.ok === false ? `failed: ${r.error ?? ''}` : 'done'}${summary ? `: ${summary}` : ''}${r?.sent?.projects ? `; sent ${JSON.stringify(r.sent)}` : ''}`);
  return r?.ok === false ? 1 : 0;
}

async function map(api: ReturnType<typeof client>, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, key] = words;
  if (verb !== 'rebuild') throw new UsageError('usage: fg map rebuild <key>');
  if (!key) throw new UsageError('fg map rebuild needs a project key (see fg projects list)');
  const r = await api<{ queued: boolean }>('POST', `/api/projects/${encodeURIComponent(key)}/codemap/rebuild`, {});
  io.out(f.json ? JSON.stringify({ key, ...r }) : `${key}: rebuild queued; the worker remaps it at its next pass (watch Activity for code_mapped)`);
  return 0;
}

async function demo(api: Api, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb] = words;
  if (verb !== 'seed' && verb !== 'remove') throw new UsageError('usage: fg demo seed|remove [--project k]');
  const r = await api<{ message: string }>('POST', `/api/demo/${verb}`, f.project ? { project: f.project } : {});
  io.out(f.json ? JSON.stringify(r, null, 2) : r.message);
  return 0;
}

async function links(api: Api, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, a, b] = words;
  if (verb === 'list' || verb === undefined) {
    if (!f.project) throw new UsageError('fg links list needs --project k');
    const list = await api<any[]>('GET', `/api/projects/${encodeURIComponent(f.project)}/links`);
    if (f.json) { io.out(JSON.stringify(list, null, 2)); return 0; }
    io.out(list.length ? table(['A', 'B', 'RELATION', 'STATUS', 'SCORE', 'NOTE'], list.map((l) => [l.a, l.b, l.relation, l.status, Number(l.score ?? 0).toFixed(2), l.note ?? ''])) : `no links for ${f.project}`);
    return 0;
  }
  if (verb !== 'confirm' && verb !== 'dismiss') throw new UsageError(`unknown links command: ${verb}`);
  if (!a || !b) throw new UsageError(`fg links ${verb} needs two projects: fg links ${verb} <a> <b>`);
  const body = { a, b, status: verb === 'confirm' ? 'confirmed' : 'dismissed', ...(f.relation && { relation: f.relation }), ...(f.note !== undefined && { note: f.note }) };
  const link = await api<any>('PUT', '/api/links', body);
  io.out(f.json ? JSON.stringify(link, null, 2) : `${link.a} ↔ ${link.b} ${link.status} (${link.relation})`);
  return 0;
}

async function factsCmd(api: Api, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, id, value] = words;
  if (!f.project) throw new UsageError(`fg facts ${verb ?? 'list'} needs --project k`);
  const base = `/api/projects/${encodeURIComponent(f.project)}/facts`;
  if (verb === 'list' || verb === undefined) {
    const raw = await api<any[]>('GET', `${base}${qs({ kind: f.kind, q: f.q })}`);
    // A search (--q) answers { fact, score } pairs, best first; the kind filter is the list's only.
    const searched = raw.length > 0 && raw[0]?.fact !== undefined;
    const list = searched ? raw.map((h) => ({ ...h.fact, score: h.score })).filter((x) => !f.kind || x.kind === f.kind) : raw;
    const shown = f.limit ? list.slice(0, Number(f.limit)) : list;
    if (f.json) { io.out(JSON.stringify(shown, null, 2)); return 0; }
    const relevance = (x: any) => (x.relevance === null || x.relevance === undefined ? 'unscored' : `${Number(x.relevance).toFixed(2)} ${x.relevanceBy ?? ''}`.trim());
    io.out(shown.length
      ? searched
        ? table(['ID', 'KIND', 'RELEVANCE', 'SCORE', 'PATH', 'STATEMENT'], shown.map((x) => [x.id, x.kind, relevance(x), Number(x.score).toFixed(2), x.path, x.statement]), 90)
        : table(['ID', 'KIND', 'RELEVANCE', 'PATH', 'STATEMENT'], shown.map((x) => [x.id, x.kind, relevance(x), x.path, x.statement]), 90)
      : f.q ? `no facts in ${f.project} match "${f.q}"` : `no facts for ${f.project}`);
    return 0;
  }
  if (verb !== 'relevance') throw new UsageError(`unknown facts command: ${verb}`);
  const n = Number(value);
  if (!id || value === undefined || !Number.isFinite(n) || n < 0 || n > 1) throw new UsageError('fg facts relevance <id> <0..1> --project k');
  await api('PATCH', `${base}/${encodeURIComponent(id)}/relevance`, { relevance: n });
  io.out(f.json ? JSON.stringify({ id, relevance: n }) : `${id} relevance ${n}`);
  return 0;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const DOCS_LIST_MAX = 500;

async function docs(api: Api, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, file] = words;
  if (!f.project) throw new UsageError(`fg docs ${verb ?? 'list'} needs --project k`);
  const base = `/api/projects/${encodeURIComponent(f.project)}/docs`;
  if (verb === 'list' || verb === undefined) {
    // The API pages documents (a GitHub sync adds one per PR): the newest page of the largest size.
    const list = await api<any[]>('GET', `${base}?limit=${DOCS_LIST_MAX}`);
    if (f.json) { io.out(JSON.stringify(list, null, 2)); return 0; }
    const read = (r: any) => (r ? `${r.status}${r.status === 'done' ? ` (${plural(r.facts ?? 0, 'fact')})` : r.error ? `: ${r.error}` : ''}` : '');
    io.out(list.length ? table(['REF', 'KIND', 'READ', 'ADDED BY', 'ADDED', 'TITLE'], list.map((d) => [d.ref, d.kind ?? 'text', read(d.read), d.addedBy ?? '', at(d.addedAt), d.title]), 90) : `no documents for ${f.project}`);
    if (list.length >= DOCS_LIST_MAX) io.out(`the newest ${DOCS_LIST_MAX} documents are shown: older ones are on the project's Docs page`);
    return 0;
  }
  if (verb !== 'upload') throw new UsageError(`unknown docs command: ${verb}`);
  if (!file) throw new UsageError('fg docs upload <file> --project k [--title "..."]');
  let bytes: Buffer;
  try {
    bytes = await (io.readFile ?? readFile)(file);
  } catch (e) {
    throw new ApiError(`cannot read ${file}: ${(e as Error).message}`);
  }
  // The API takes a plain file name.
  const name = basename(file).replace(/[^\w .()-]/g, '_').replace(/^[^\w]+/, '') || 'upload.txt';
  const media = IMAGE_TYPES[extname(name).toLowerCase()];
  const body = { title: f.title ?? name, name, ...(media ? { image: { mediaType: media, data: bytes.toString('base64') } } : { text: bytes.toString('utf8') }) };
  const r = await api<{ id: string; chunks: number }>('POST', base, body);
  io.out(f.json ? JSON.stringify(r, null, 2) : `uploaded ${r.id}: the worker reads it into facts (fg docs list --project ${f.project})`);
  return 0;
}

async function activityCmd(api: Api, io: CliIO, f: Flags): Promise<number> {
  // --json is the whole record: the list leaves big details out unless asked.
  const list = await api<any[]>('GET', `/api/activity${qs({ project: f.project, kind: f.kind, run: f.run, limit: f.limit ?? '50', details: f.json ? '1' : undefined })}`);
  if (f.json) { io.out(JSON.stringify(list, null, 2)); return 0; }
  const runs = list.some((a) => a.run);
  io.out(list.length
    ? table(['TIME', 'ACTOR', 'KIND', 'PROJECT', ...(runs ? ['RUN'] : []), 'SUBJECT'], list.map((a) => [at(a.ts), a.actor, a.kind, a.projectKey ?? '', ...(runs ? [a.run ? `${a.run}${a.sandbox ? ' (sandbox)' : ''}` : ''] : []), a.subject]), 90)
    : 'no activity');
  return 0;
}

/** fg cleanup --run <id>: what the run wrote, removed with --apply (DELETE /api/runs/:id); a dry run otherwise. */
async function cleanupCmd(api: Api, io: CliIO, f: Flags): Promise<number> {
  if (!f.run) throw new UsageError('fg cleanup --run <id> [--apply]');
  if (f.apply && f['dry-run']) throw new UsageError('--apply and --dry-run: choose one');
  const r = await api<any>('DELETE', `/api/runs/${encodeURIComponent(f.run)}`, { dryRun: !f.apply });
  if (f.json) { io.out(JSON.stringify(r, null, 2)); return 0; }
  const counts: Record<string, number> = r.dryRun ? r.remove : r.removed ?? r.remove;
  const rows = Object.entries(counts).filter(([, n]) => n > 0);
  io.out(`run ${r.run}${r.sandbox ? ' (sandbox)' : ''}: ${r.dryRun ? 'dry run, nothing removed yet' : 'removed'}`);
  io.out(rows.length ? table(['KIND', r.dryRun ? 'WOULD REMOVE' : 'REMOVED'], rows) : r.dryRun ? 'nothing to remove' : 'nothing removed');
  if (r.kept?.length) {
    io.out(`\nkept (${r.kept.length}): someone outside the run touched them, or they are a real session's now`);
    io.out(table(['KIND', 'ID', 'WHY'], r.kept.map((k: any) => [k.kind, k.id, k.why]), 100));
  }
  if (r.changed?.length) {
    io.out(`\nchanged by the run but not its own (never undone: put them back by hand if you need to)`);
    io.out(table(['KIND', 'TARGETS', 'SUBJECT'], r.changed.map((c: any) => [c.kind, c.targets.join(','), c.subject]), 80));
  }
  const n = r.entries ?? 0;
  io.out(`\nits ${n} Activity ${n === 1 ? 'entry stays' : 'entries stay'} (the log is never edited)${r.dryRun ? `; fg cleanup --run ${r.run} --apply removes the rest` : ''}`);
  return 0;
}

/** fg evidence <session>: GET /api/sessions/:id/evidence, in a few tables. */
async function evidenceCmd(api: Api, io: CliIO, words: string[], f: Flags): Promise<number> {
  const id = words[0];
  if (!id) throw new UsageError('fg evidence <session-id>');
  const e = await api<any>('GET', `/api/sessions/${encodeURIComponent(id)}/evidence`);
  if (f.json) { io.out(JSON.stringify(e, null, 2)); return 0; }
  const t = e.turns;
  io.out(`${e.session.id} [${e.session.projectKey}] ${e.session.source}, ${e.session.state}: ${plural(t.count, 'turn')} (${at(t.first)} to ${at(t.last)}), ${t.classified} classified, ${t.waiting} waiting, ${t.givenUp} given up${t.prunedText ? `, ${t.prunedText} with their text pruned` : ''}`);
  if (e.files) io.out(`files: ${e.files.edited.length} edited${e.files.edited.length ? ` (${e.files.edited.slice(0, 8).join(', ')}${e.files.edited.length > 8 ? ', ...' : ''})` : ''}, ${e.files.readOnly.length} only read`);
  const flags = e.flags.filter((x: any) => x.flagged || x.skipped.length || x.label === 'pushback' || x.label === 'correction');
  io.out(flags.length
    ? `\n${table(['TURN', 'LABEL', 'CONF', 'FILED', 'SKIP RULES', 'WHY'], flags.map((x: any) => [x.index, x.label, x.confidence ?? '', x.flagged ? x.candidateId : 'no', x.skipped.join(',') || '', x.why ?? '']), 80)}`
    : '\nno turn read as pushback or correction');
  if (e.flagsLeftOut) io.out(`(${e.flagsLeftOut} more classified turns not listed)`);
  if (e.inbox.length) io.out(`\n${table(['INBOX', 'STATUS', 'DECIDED BY', 'LESSON', 'MISS'], e.inbox.map((i: any) => [i.id, i.status, i.decidedBy ?? '', i.lesson ? `${i.lesson.id} (${i.lesson.status})` : '', i.miss?.missed ?? '']), 70)}`);
  io.out(e.served.length ? `\ncontext served: ${plural(e.served.length, 'call')}` : '\nno context served is recorded (it is when the agent passes its session_id)');
  return 0;
}

async function sessionsCmd(api: Api, io: CliIO, f: Flags): Promise<number> {
  const r = await api<{ sessions: any[]; next: string | null }>('GET', `/api/sessions${qs({ project: f.project, limit: f.limit })}`);
  if (f.json) { io.out(JSON.stringify(r, null, 2)); return 0; }
  io.out(r.sessions.length
    ? table(['ID', 'PROJECT', 'SOURCE', 'STATE', 'TURNS', 'LAST ACTIVITY', 'GOAL'], r.sessions.map((x) => [x.id, x.projectKey, x.source, x.state, x.turnCount ?? '', at(x.lastActivityAt), x.snippet ?? '']), 70)
    : 'no sessions');
  if (r.next) io.out(`(more: the API's next cursor is ${r.next})`);
  return 0;
}

const SERVICES = new Set(['github', 'linear']);

async function integrationsCmd(api: Api, io: CliIO, words: string[], f: Flags): Promise<number> {
  const [verb, kind] = words;
  if (verb === 'set' || verb === 'test') {
    if (!kind || !SERVICES.has(kind)) throw new UsageError(`fg integrations ${verb} github|linear`);
    if (verb === 'test') {
      const r = await api<{ ok: boolean; account: string | null; error: string | null }>('POST', `/api/settings/integrations/${kind}/test`, {});
      io.out(f.json ? JSON.stringify(r, null, 2) : `${kind}: ${r.ok ? `ok (${r.account ?? 'signed in'})` : `FAILED: ${r.error ?? ''}`}`);
      return r.ok ? 0 : 1;
    }
    // A token on the command line ends up in shell history and the process list: only standard input.
    if (!f['from-stdin']) throw new UsageError(`fg integrations set ${kind} --from-stdin  (pipe the token in, e.g. from a file you then delete)`);
    const token = (await (io.readStdin ?? allOfStdin)()).trim();
    if (!token) throw new UsageError('no token on standard input');
    const r = await api<{ ok: boolean; view?: Record<string, any> }>('PUT', `/api/settings/integrations/${kind}`, { token });
    const c = r.view?.[kind]?.connection;
    io.out(f.json ? JSON.stringify({ ok: r.ok, connection: c ?? null }, null, 2) : table(['SERVICE', 'STATE'], [[kind, c ? `${c.state}: ${c.detail}` : 'saved']], 120));
    return 0;
  }
  if (verb !== 'status' && verb !== undefined) throw new UsageError('usage: fg integrations status | set github|linear --from-stdin | test github|linear');
  const v = await api<any>('GET', '/api/settings/integrations');
  if (f.json) { io.out(JSON.stringify(v, null, 2)); return 0; }
  io.out(table(['SERVICE', 'STATE', 'LAST SYNC'], (['github', 'linear'] as const).map((k) => [k, `${v[k]?.connection?.state ?? 'unknown'}: ${v[k]?.connection?.detail ?? ''}`, at(v[k]?.lastSyncAt) || 'never']), 120));
  return 0;
}

const VERBS = new Set(['status', 'pipeline', 'projects', 'scan', 'inbox', 'lessons', 'demo', 'map', 'links', 'facts', 'docs', 'activity', 'sessions', 'evidence', 'cleanup', 'cloud', 'integrations', 'doctor', 'setup']);

/** fg help <verb>: that verb's usage lines (with their continuation lines) and the options; the whole text otherwise. */
export function helpFor(verb: string | undefined): string {
  if (!verb || !VERBS.has(verb)) return USAGE;
  const [head, rest] = USAGE.split('\nOptions:\n');
  const out: string[] = [];
  let inVerb = false;
  for (const line of head.split('\n')) {
    if (line.startsWith('  fg ')) inVerb = line.startsWith(`  fg ${verb} `) || line === `  fg ${verb}`;
    else if (!line.startsWith('    ')) inVerb = false;
    if (inVerb) out.push(line);
  }
  return `Usage:\n${out.join('\n')}\n\nOptions:\n${rest.split('\n\nEnvironment:')[0]}`;
}

/** Runs one fg command. Exit codes: 0 done, 1 the API refused or something failed, 2 a usage mistake. */
export async function run(argv: string[], raw: CliIO): Promise<number> {
  let io = raw;
  let p: Parsed;
  // --json: a failure is JSON on stdout too, so whatever parses the output gets { error } and not prose.
  const asJson = argv.includes('--json');
  const failed = (message: string, code: 1 | 2, extra: { status?: number; help?: string } = {}) => {
    const hint = code === 2 ? ` (see ${extra.help ?? 'fg help'})` : '';
    if (asJson) io.out(JSON.stringify({ error: `${message}${hint}`, ...(extra.status !== undefined && { status: extra.status }) }));
    else io.err(`fg: ${message}${hint}`);
    return code;
  };
  // setup's arguments are setup.sh's, not fg's: say where it runs before trying to read them as fg options.
  if (argv[0] === 'setup') {
    io.err('fg: fg setup runs ./scripts/setup.sh, which must run on the host (scripts/fg does that): it cannot run inside the api container');
    return 2;
  }
  const verb = argv.find((a) => !a.startsWith('-'));
  const help = verb && VERBS.has(verb) ? `fg help ${verb}` : 'fg help';
  try {
    p = parse(argv);
  } catch (e) {
    return failed((e as Error).message, 2, { help });
  }
  const { words, flags } = p;
  io = { ...io, out: (l) => raw.out(printable(l)), err: (l) => raw.err(printable(l)) };
  if (words[0] === 'help') { io.out(helpFor(words[1])); return 0; }
  if (flags.help || !words.length) { io.out(words.length ? helpFor(words[0]) : USAGE); return 0; }
  try {
    const api = client(io, flags, !UNLABELLED.has(words[0]));
    switch (words[0]) {
      case 'status': return await status(api, io, flags);
      case 'pipeline': return await pipelineCmd(api, io, flags);
      case 'links': return await links(api, io, words.slice(1), flags);
      case 'facts': return await factsCmd(api, io, words.slice(1), flags);
      case 'docs': return await docs(api, io, words.slice(1), flags);
      case 'activity': return await activityCmd(api, io, flags);
      case 'sessions': return await sessionsCmd(api, io, flags);
      case 'evidence': return await evidenceCmd(api, io, words.slice(1), flags);
      case 'cleanup': return await cleanupCmd(api, io, flags);
      case 'integrations': return await integrationsCmd(api, io, words.slice(1), flags);
      case 'doctor': throw new UsageError('fg doctor runs ./scripts/doctor.sh on the host (scripts/fg does that); it cannot run inside the api container');
      case 'projects': return await projects(api, io, words[1], flags);
      case 'scan': return await scan(api, io, flags);
      case 'inbox': return await inbox(api, io, words.slice(1), flags);
      case 'lessons': return await lessons(api, io, words.slice(1), flags);
      case 'cloud': return await cloud(api, io, words[1], flags);
      case 'map': return await map(api, io, words.slice(1), flags);
      case 'demo': return await demo(api, io, words.slice(1), flags);
      default: throw new UsageError(`unknown command: ${words[0]}`);
    }
  } catch (e) {
    if (e instanceof UsageError) return failed(e.message, 2, { help: VERBS.has(words[0]) ? `fg help ${words[0]}` : 'fg help' });
    if (e instanceof ApiError) return failed(e.message, 1, { status: e.status });
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
