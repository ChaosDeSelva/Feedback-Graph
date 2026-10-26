import { createHash } from 'node:crypto';
import { cloudUrlProblem, VERSION, type CloudConfig } from './config.ts';
import { EXPORT_FORMAT, type ExportBundle } from './graph/portability.ts';
import { redactDeep, redactSecrets } from './redact.ts';
import type { ActivityStore, DocsStore, PortabilityStore } from './store.ts';

/*
 * Feedback Graph Cloud sync: push your project knowledge to a team org. Off unless CLOUD_URL and CLOUD_TOKEN are set
 * (loadConfig). The body is the export bundle (format "feedback-graph-export", schemaVersion 1), rebuilt field by field
 * so only what is listed here can leave: approved lessons (see below), misses without the quoted feedback or excerpts,
 * current facts, doc titles and links, project remotes and code-map hotspot numbers. Never transcripts, source or
 * vectors.
 *
 * Nothing is shared without your approval: by default a bundle carries the lessons you approved, plus the current
 * status of any lesson the cloud already received (so a revoke, a supersede or a move back to proposed demotes the team
 * copy). A lesson you never approved is sent only with SYNC_SUGGESTIONS=true (proposed ones then arrive as suggestions
 * for an admin).
 *
 * The cloud's sync contract (POST /api/v1/sync): each bundle is one whole project and says `complete: true`, so the
 * cloud treats it as a tombstone set: what this member sent for the project before and leaves out now is withdrawn
 * from the team graph. Leaving unapproved lessons out is safe under it: what was never sent has nothing to withdraw.
 * What the cloud last accepted is kept in the store (storedSyncMemory), so it survives restarts and the worker's
 * schedule and the api's Sync now share it. A project that was synced and is no longer in the sync list (unselected,
 * excluded, or left out of SYNC_PROJECTS) gets one last, empty bundle that withdraws what was sent for it, so the
 * team copy does not linger; it then leaves the record. Approved lessons become team lessons
 * (or wait for an admin when the org reviews them), and rejected or superseded ones demote the team copy. `withdrawn`
 * also names what was sent before and is gone now. 429 means another sync of the org is running or the token's sync rate limit was hit: wait the Retry-After.
 */

/** POST /api/v1/sync's answer (the cloud's contract). */
export type SyncResponse = {
  syncId: string;
  org: string;
  projects: { localKey: string; key: string; remote: string | null; namespace: 'team' | 'personal' }[];
  lessons: { team: number; suggested: number; skipped: number; pendingRevisions?: number };
  /** What this sync took out of the team graph (older clouds leave it out). */
  withdrawn?: { lessons: number; misses: number; docs: number; files: number };
  misses: number;
  facts: { files: number; unchanged: number };
  docs: number;
};

/** An item deleted locally since it was last sent: ids as the bundle names them; a fact file by path with its project. */
export type WithdrawnItem = { kind: 'lesson' | 'miss' | 'doc'; id: string } | { kind: 'file'; id: string; projectKey: string };

/** The sync body: the export bundle plus the two cloud fields. */
/** `codeFilesPartial`: the code map was cut to fit (pushFitting), so the cloud keeps the files it leaves out. */
export type SyncBundle = ExportBundle & { complete: boolean; withdrawn: WithdrawnItem[]; codeFilesPartial?: boolean };

/** What the cloud last accepted for a project: enough to name what has since gone, and to skip an unchanged bundle. */
export type SentRecord = { fingerprint: string; remote: string | null; lessons: string[]; misses: string[]; docs: string[]; files: string[] };

/**
 * What the cloud last accepted, per project key. A Map works (tests, a one-off run); the services use
 * storedSyncMemory, records in the store shared by the worker's schedule and the api's Sync now.
 */
export type SyncMemory = {
  get(key: string): SentRecord | undefined | Promise<SentRecord | undefined>;
  set(key: string, r: SentRecord): unknown;
  delete(key: string): unknown;
  keys(): Iterable<string> | Promise<Iterable<string>>;
};

/** The store cursor naming one cloud org (URL and token; the token itself is never stored): its records are under `<it>/`. */
export const syncMemoryCursor = (cloud: Pick<CloudConfig, 'url' | 'token'>) =>
  `cloud-sync-sent:${createHash('sha256').update(`${cloud.url.replace(/\/+$/, '')}\0${cloud.token}`).digest('hex').slice(0, 24)}`;

/**
 * SyncMemory kept in the store, so it survives restarts and is the one record both services use. Keyed by the cloud URL
 * and token: another org (or a new token) starts with no record, so nothing it never received is withdrawn from it and
 * no lesson's status is sent to it just because an earlier org had the lesson. One cursor per project
 * (`<syncMemoryCursor>/<project key>`), each written whole: the api's Sync now and the worker's schedule can run at
 * once and neither can lose the other's record (a single shared record, read, changed and written back, could).
 * A record kept the old way (one cursor holding every project) is moved over on first use; a project that already
 * has its own record keeps it.
 */
export function storedSyncMemory(docs: Pick<DocsStore, 'getCursor' | 'setCursor' | 'cursorsWithPrefix' | 'deleteCursor'>, cloud: Pick<CloudConfig, 'url' | 'token'>): SyncMemory {
  const legacy = syncMemoryCursor(cloud);
  const prefix = `${legacy}/`;
  const parse = (v: string | null): SentRecord | undefined => {
    try {
      const r = JSON.parse(v ?? 'null');
      return r && typeof r === 'object' && !Array.isArray(r) && typeof r.fingerprint === 'string' ? r : undefined;
    } catch {
      return undefined;
    }
  };
  let moved: Promise<void> | null = null;
  const ready = () =>
    (moved ??= (async () => {
      const old = await docs.getCursor(legacy);
      if (old === null) return;
      let all: Record<string, unknown> = {};
      try {
        const v = JSON.parse(old);
        if (v && typeof v === 'object' && !Array.isArray(v)) all = v;
      } catch {
        /* a damaged record reads as none */
      }
      for (const [key, r] of Object.entries(all)) {
        if (parse(JSON.stringify(r)) && (await docs.getCursor(prefix + key)) === null) await docs.setCursor(prefix + key, JSON.stringify(r));
      }
      await docs.deleteCursor(legacy);
    })().catch((err) => {
      moved = null;
      throw err;
    }));
  return {
    get: async (key) => {
      await ready();
      return parse(await docs.getCursor(prefix + key));
    },
    set: async (key, r) => {
      await ready();
      await docs.setCursor(prefix + key, JSON.stringify(r));
    },
    delete: async (key) => {
      await ready();
      await docs.deleteCursor(prefix + key);
    },
    keys: async () => {
      await ready();
      return (await docs.cursorsWithPrefix(prefix)).filter((c) => parse(c.value)).map((c) => c.key.slice(prefix.length));
    },
  };
}

export type SyncCounts = { projects: number; lessons: number; misses: number; facts: number; docs: number; codeFiles: number };

export type SyncTrigger = 'manual' | 'schedule';

export type ProjectSyncResult = {
  key: string;
  /**
   * sent; empty (nothing stored); unchanged (same bundle as the last send; a forced Sync now resends it); failed; not sent (an
   * earlier 401/403 stopped the run); withdrawn (no longer synced: its last, empty bundle took back what was sent);
   * waiting (the schedule is backing off from this project after it failed, until `until`; the others go on).
   */
  status: 'sent' | 'empty' | 'unchanged' | 'failed' | 'not sent' | 'withdrawn' | 'waiting';
  counts: SyncCounts | null;
  /** Where the cloud filed it. */
  cloudKey?: string;
  namespace?: 'team' | 'personal';
  lessons?: SyncResponse['lessons'];
  syncId?: string;
  /** Items this bundle named in `withdrawn`. */
  withdrawn?: number;
  /** The cloud refused the whole bundle as too large (413), so it went with only the hottest code map files that fit. */
  trimmed?: { codeFiles: { sent: number; of: number } };
  /** waiting: when the schedule tries this project again. */
  until?: string;
  error?: string;
};

export type CloudSyncResult = {
  at: string;
  trigger: SyncTrigger;
  host: string;
  ok: boolean;
  /** Totals over the projects sent. */
  sent: SyncCounts;
  projects: ProjectSyncResult[];
  /** The first failure, one line, redacted. */
  error: string | null;
  /** A 401/403 (or a refused CLOUD_URL) stopped the run: no project will fare better, unlike one project's failure. */
  stopped: boolean;
};

/** The last Sync now the api ran: when, whether it worked, what it sent, and how many projects had nothing new. */
export type ManualSync = { at: string; ok: boolean; error: string | null; sent: SyncCounts; unchanged: number; failed: number };

/** What the worker reports about sync in its heartbeat (WorkerStatus.cloudSync). */
export type CloudSyncStatus = {
  host: string;
  intervalMinutes: number | null;
  lastAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  lastSent: SyncCounts | null;
  nextAt: string | null;
  /** Runs in a row a 401/403 stopped, or that threw: the whole schedule backs off for these. */
  failures: number;
  /** Projects the schedule is backing off from after they failed, alone (older workers leave it out). */
  waiting?: { key: string; failures: number; until: string; error: string | null }[];
};

const zero = (): SyncCounts => ({ projects: 0, lessons: 0, misses: 0, facts: 0, docs: 0, codeFiles: 0 });

export const bundleCounts = (b: ExportBundle): SyncCounts => ({
  projects: b.projects.length,
  lessons: b.lessons.length,
  misses: b.misses.length,
  facts: b.facts.length,
  docs: b.docs.length,
  codeFiles: b.codeFiles?.length ?? 0,
});

/** Which lessons a bundle carries: `suggestions` is SYNC_SUGGESTIONS. */
export type SyncOptions = { suggestions?: boolean };

/**
 * The sync body for one project, or null when nothing is stored for it. The export is the whole project (nothing
 * capped), so the bundle says `complete: true`. Lessons: approved ones, any the cloud already has (in `previous`) with
 * their current status, and the rest only with `suggestions`. `previous` (what the cloud last accepted) also fills in
 * `withdrawn`.
 */
export async function syncBundle(p: Pick<PortabilityStore, 'exportData'>, projectKey: string, previous?: SentRecord, o: SyncOptions = {}): Promise<SyncBundle | null> {
  const b = await p.exportData({ projectKey, approvedOnly: false });
  const received = new Set(previous?.lessons ?? []);
  const shared = (l: { id: string; status: string }) => l.status === 'approved' || received.has(l.id) || !!o.suggestions;
  if (!b.projects.length && !b.lessons.length && !b.misses.length && !b.facts.length && !b.docs.length) return null;
  const out: SyncBundle = {
    format: b.format,
    schemaVersion: b.schemaVersion,
    toolVersion: b.toolVersion,
    exportedAt: b.exportedAt,
    projectKey: b.projectKey,
    projects: b.projects.map((x) => ({ key: x.key, remote: x.remote })),
    // Approved ones, and the cloud's copies with their new status (it demotes rejected, superseded or proposed ones).
    // A lesson you never approved stays home unless SYNC_SUGGESTIONS is on.
    lessons: b.lessons
      .filter((l) => LESSON_STATUSES.has(l.status) && shared(l))
      .map((l) => ({
        id: l.id, projectKey: l.projectKey, title: l.title, rule: l.rule, appliesWhen: l.appliesWhen, scope: l.scope, paths: [...l.paths],
        status: l.status, source: l.source, cause: l.cause, missId: l.missId, createdAt: l.createdAt, decidedAt: l.decidedAt,
      })),
    // The quoted feedback is transcript text and excerpts can be source or document text: both stay home.
    misses: b.misses.map((m) => ({
      id: m.id, projectKey: m.projectKey, missed: m.missed, cause: m.cause, causeExplanation: m.causeExplanation, feedbackText: '', ts: m.ts,
      contextItems: m.contextItems.map((c) => ({ kind: c.kind, ref: c.ref, excerpt: '', why: c.why })),
    })),
    facts: b.facts.map((f) => ({
      path: f.path, lines: f.lines, kind: f.kind, statement: f.statement, why: f.why, confidence: f.confidence, source: f.source, createdAt: f.createdAt, projectKey: f.projectKey,
    })),
    docs: b.docs.map((d) => ({ id: d.id, projectKey: d.projectKey, source: d.source, ref: d.ref, title: d.title, url: d.url })),
    codeFiles: (b.codeFiles ?? []).map((c) => ({
      projectKey: c.projectKey, path: c.path, lang: c.lang, loc: c.loc, isTest: c.isTest, churn: c.churn, misses: c.misses, dependents: c.dependents, score: c.score,
    })),
    complete: b.projectKey === projectKey,
    withdrawn: [],
  };
  out.withdrawn = previous ? withdrawnSince(previous, out) : [];
  // Stored text was redacted on the way in; this catches anything stored before a pattern existed.
  return redactDeep(out);
}

const LESSON_STATUSES = new Set(['proposed', 'approved', 'rejected', 'superseded']);

const factFiles = (b: ExportBundle) => [...new Set(b.facts.map((f) => f.path))];

/** What the cloud last had and this bundle no longer names. */
export function withdrawnSince(previous: SentRecord, b: Pick<SyncBundle, 'projectKey' | 'lessons' | 'misses' | 'docs' | 'facts'>): WithdrawnItem[] {
  const gone = (before: string[], now: string[]) => {
    const keep = new Set(now);
    return before.filter((x) => !keep.has(x));
  };
  return [
    ...gone(previous.lessons, b.lessons.map((l) => l.id)).map((id) => ({ kind: 'lesson' as const, id })),
    ...gone(previous.misses, b.misses.map((m) => m.id)).map((id) => ({ kind: 'miss' as const, id })),
    ...gone(previous.docs, b.docs.map((d) => d.id)).map((id) => ({ kind: 'doc' as const, id })),
    ...gone(previous.files, factFiles(b as ExportBundle)).map((id) => ({ kind: 'file' as const, id, projectKey: b.projectKey ?? '' })),
  ];
}

/** A project the cloud has from an earlier sync and that now holds nothing: a complete, empty bundle withdraws it all. */
function tombstone(key: string, previous: SentRecord): SyncBundle {
  const empty = { projectKey: key, lessons: [], misses: [], docs: [], facts: [] };
  return {
    format: EXPORT_FORMAT, schemaVersion: 1, toolVersion: VERSION, exportedAt: new Date().toISOString(),
    // The remote it was filed under, so the cloud finds the same team project.
    projects: [{ key, remote: previous.remote }],
    ...empty,
    codeFiles: [],
    complete: true,
    withdrawn: withdrawnSince(previous, empty),
  };
}

const record = (key: string, b: SyncBundle, fingerprint: string): SentRecord => ({
  fingerprint,
  remote: b.projects.find((x) => x.key === key)?.remote ?? null,
  lessons: b.lessons.map((l) => l.id),
  misses: b.misses.map((m) => m.id),
  docs: b.docs.map((d) => d.id),
  files: factFiles(b),
});

/** What a sync of these projects would send, without sending it. */
/** Projects the preview exports at once: enough to overlap the store's round trips, few enough not to crowd it. */
export const PREVIEW_CONCURRENCY = 4;

export async function previewCloudSync(p: Pick<PortabilityStore, 'exportData'>, keys: string[], o: SyncOptions & { memory?: SyncMemory } = {}) {
  const total = zero();
  // A few at a time, each into its own slot, so the list keeps the order of `keys`.
  const projects: { key: string; counts: SyncCounts | null }[] = new Array(keys.length);
  let at = 0;
  const lane = async () => {
    while (at < keys.length) {
      const i = at++;
      const key = keys[i];
      const b = await syncBundle(p, key, await o.memory?.get(key), o);
      projects[i] = { key, counts: b && bundleCounts(b) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, keys.length) }, lane));
  for (const { counts } of projects) if (counts) for (const k of Object.keys(total) as (keyof SyncCounts)[]) total[k] += counts[k];
  return { total, projects };
}

export class CloudSyncError extends Error {
  /** HTTP status, or 0 for a network error or a refused URL. */
  readonly status: number;
  readonly retryable: boolean;
  /** 401/403: no other project will fare better, so the run stops. */
  readonly fatal: boolean;
  /** 413: the most bytes the cloud takes in one request, when it said (its SYNC_MAX_BYTES). */
  readonly limit: number | null;
  constructor(message: string, status: number, retryable = false, limit: number | null = null) {
    super(redactSecrets(message).slice(0, 500));
    this.status = status;
    this.retryable = retryable;
    this.fatal = status === 401 || status === 403 || status === -1;
    this.limit = limit;
  }
}

const RETRY_AFTER_CAP_MS = 60_000;

/** Retry-After as delay-seconds or an HTTP date, in ms; null when absent or unreadable. */
export function retryAfterMs(h: string | null, now = Date.now()): number | null {
  if (!h?.trim()) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : null;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
const REQUEST_TIMEOUT_MS = 120_000;

/** The cloud's limit from its 413 answer ("bundle larger than <n> bytes"), or null. */
const limitOf = (serverError: string | null) => {
  const n = Number(serverError?.match(/larger than (\d+) bytes/)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Each bundle is already one project, so a 413 is not helped by syncing fewer: the cloud's limit has to go up or the
 * project has to stay home. (A code map too large is cut before this is said: see runCloudSync.)
 */
const tooLarge = (bytes: number, limit: number | null, what = 'the bundle') =>
  `${what} (${Math.round(bytes / 1024)} KB) is too large for the cloud (413)${limit ? `, which takes at most ${limit} bytes` : ''}: ` +
  `ask its operator to raise SYNC_MAX_BYTES${limit ? ` above ${limit} bytes` : ''}, or leave this project out of sync with EXCLUDE_PROJECTS or SYNC_PROJECTS`;

function explain(status: number, serverError: string | null, bytes: number): string {
  const said = serverError ? `: ${serverError}` : '';
  switch (status) {
    case 401: return 'the cloud refused the token (401): check CLOUD_TOKEN; it may be revoked or expired';
    case 403: return `the token cannot sync (403): it needs the sync scope and a member role or above in its org${said}`;
    case 413: return tooLarge(bytes, limitOf(serverError));
    case 422: return `the cloud rejected the bundle (422)${said}`;
    case 429: return 'the cloud is busy (another sync of this org is running) or this token hit its sync rate limit (429)';
    default: return `the cloud answered ${status}${said}`;
  }
}

/**
 * POST one bundle to CLOUD_URL/api/v1/sync. 429, 5xx and network errors are retried (Retry-After honoured, capped at a
 * minute; otherwise baseDelayMs doubling); anything else throws a CloudSyncError at once. Redirects are refused, so the
 * token only ever goes to CLOUD_URL.
 */
export async function pushBundle(o: {
  cloud: Pick<CloudConfig, 'url' | 'token'> & Partial<Pick<CloudConfig, 'machine'>>;
  bundle: ExportBundle;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  baseDelayMs?: number;
}): Promise<SyncResponse> {
  const problem = cloudUrlProblem(o.cloud.url);
  if (problem) throw new CloudSyncError(problem, -1);
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, o.attempts ?? 4);
  const base = o.baseDelayMs ?? 2000;
  const body = JSON.stringify(o.bundle);
  const bytes = Buffer.byteLength(body);
  const url = `${o.cloud.url.replace(/\/+$/, '')}/api/v1/sync`;
  let last: CloudSyncError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${o.cloud.token}`,
          'content-type': 'application/json',
          'user-agent': `feedback-graph/${VERSION}`,
          ...(o.cloud.machine ? { 'x-fg-machine': o.cloud.machine } : {}),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      last = new CloudSyncError(`could not reach the cloud: ${(err as Error).message ?? String(err)}`, 0, true);
      if (attempt < attempts) await sleep(base * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as SyncResponse | null;
      if (!data || typeof data !== 'object' || typeof data.syncId !== 'string') throw new CloudSyncError('the cloud answered 200 without a sync result; is CLOUD_URL a Feedback Graph Cloud?', res.status);
      return data;
    }
    const text = await res.text().catch(() => '');
    let serverError: string | null = null;
    try {
      const e = (JSON.parse(text) as { error?: unknown }).error;
      serverError = typeof e === 'string' ? e.slice(0, 300) : null;
    } catch {
      /* not JSON */
    }
    const retryable = res.status === 429 || res.status >= 500;
    last = new CloudSyncError(explain(res.status, serverError, bytes), res.status, retryable, res.status === 413 ? limitOf(serverError) : null);
    if (!retryable) throw last;
    if (attempt < attempts) {
      const after = retryAfterMs(res.headers.get('retry-after'));
      // Never sooner than the cloud asked; a wait longer than we hold a run for fails this project until the next sync.
      if (after !== null && after > RETRY_AFTER_CAP_MS) {
        throw new CloudSyncError(`${explain(res.status, serverError, bytes)}; it asked to retry after ${Math.ceil(after / 1000)} s`, res.status, true);
      }
      await sleep(after ?? base * 2 ** (attempt - 1));
    }
  }
  throw last ?? new CloudSyncError('sync failed', 0);
}

/**
 * The projects a sync sends: the ones selected in Settings, narrowed to SYNC_PROJECTS when it is set. EXCLUDE_PROJECTS
 * always wins. Nothing outside your selection leaves.
 */
export function syncProjects(o: { configured: string[]; selected: string[]; excluded: string[] }): string[] {
  const excluded = new Set(o.excluded);
  const wanted = o.configured.length ? new Set(o.configured) : null;
  return o.selected.filter((k) => !excluded.has(k) && (!wanted || wanted.has(k)));
}

/** Rows in a fixed order (by their own JSON, compared by code unit): the same rows read in another order are one form. */
const sorted = <T>(rows: T[]) => rows.map((r) => [JSON.stringify(r), r] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);

/**
 * What identifies a bundle's content, for the unchanged skip: hashed over a canonical form (every list sorted, the
 * export time and `withdrawn` left out), so a store that hands back tied rows in another order (Neo4j reads have no
 * snapshot, and its five queries run apart) is not a change that resends the whole project.
 */
const fingerprint = (b: SyncBundle) => createHash('sha256').update(JSON.stringify({
  ...b,
  exportedAt: '',
  withdrawn: [],
  projects: sorted(b.projects),
  lessons: sorted(b.lessons),
  misses: sorted(b.misses.map((m) => ({ ...m, contextItems: sorted(m.contextItems) }))),
  facts: sorted(b.facts),
  docs: sorted(b.docs),
  codeFiles: sorted(b.codeFiles ?? []),
})).digest('hex');
const list = (keys: string[]) => keys.join(', ');
const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

const bytesOf = (b: SyncBundle) => Buffer.byteLength(JSON.stringify(b));

/**
 * `b` with its code map cut to the files with the highest hotspot scores that keep the whole body within `maxBytes`
 * (kept in their path order). Everything else stays whole: lessons, misses, facts and docs are what the team reads.
 */
export function fitCodeFiles(b: SyncBundle, maxBytes: number): SyncBundle {
  let room = maxBytes - bytesOf({ ...b, codeFiles: [] });
  const keep = new Set<ExportBundle['codeFiles'][number]>();
  const hottest = [...b.codeFiles].sort((x, y) => y.score - x.score || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  for (const c of hottest) {
    const size = Buffer.byteLength(JSON.stringify(c)) + 1;
    if (size > room) break;
    room -= size;
    keep.add(c);
  }
  return { ...b, codeFiles: b.codeFiles.filter((c) => keep.has(c)) };
}

/**
 * Send `bundle`; when the cloud refuses it as too large (413) and it carries a code map, send it again with the code
 * map cut to fit: to the limit the cloud named (else half the body), then half that, then none. The cut bundle says
 * `codeFilesPartial`, so the cloud keeps the files it leaves out (the rest of the bundle is still complete); a cloud
 * from before that flag takes them out of the team's code map until they fit again. The result says how many went. A bundle too large even without its code map fails with what to do.
 */
async function pushFitting(bundle: SyncBundle, push: (b: SyncBundle) => Promise<SyncResponse>): Promise<{ r: SyncResponse; trimmed?: ProjectSyncResult['trimmed'] }> {
  try {
    return { r: await push(bundle) };
  } catch (err) {
    if (!(err instanceof CloudSyncError) || err.status !== 413 || !bundle.codeFiles.length) throw err;
    const full = bytesOf(bundle);
    let budget = Math.floor(err.limit !== null ? err.limit * 0.95 : full / 2);
    let limit = err.limit;
    for (let attempt = 0; attempt < 3; attempt++) {
      const fit = { ...(attempt === 2 ? { ...bundle, codeFiles: [] } : fitCodeFiles(bundle, budget)), codeFilesPartial: true };
      try {
        return { r: await push(fit), trimmed: { codeFiles: { sent: fit.codeFiles.length, of: bundle.codeFiles.length } } };
      } catch (again) {
        if (!(again instanceof CloudSyncError) || again.status !== 413) throw again;
        limit = again.limit ?? limit;
        if (!fit.codeFiles.length) throw new CloudSyncError(tooLarge(bytesOf(fit), limit, 'the bundle, even without its code map,'), 413, false, limit);
        budget = Math.floor(budget / 2);
      }
    }
    throw err;
  }
}

/** How far a run has got: projects done of total, and the one being sent now (null once all are done). */
export type SyncProgress = { done: number; total: number; current: string | null };

/**
 * Sync the given projects, one request each, and record one Activity entry for the run (what was sent: counts,
 * project keys, the cloud's host; never the token). `memory` holds what the cloud last accepted per project: it names
 * what has gone since in `withdrawn`, turns a project that now holds nothing into a tombstone, lets a run skip a
 * project whose bundle has not changed (`force`, for Sync now, resends it anyway), and names the projects synced before
 * that are no longer in the list: each gets a last, empty bundle that withdraws everything sent for it. It is updated
 * only on success, so a failed send's withdrawals go with the next one. Without it, `complete: true` still withdraws on
 * the cloud whatever a bundle leaves out. A scheduled run that sent nothing and failed nothing logs nothing; Sync now
 * always logs, so whoever asked can see the answer ("nothing to send"). `onProgress` hears before each project and
 * once at the end.
 */
export async function runCloudSync(d: {
  cloud: CloudConfig;
  portability: Pick<PortabilityStore, 'exportData'>;
  activity?: Pick<ActivityStore, 'record'>;
  projects: () => Promise<string[]>;
  trigger: SyncTrigger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  memory?: SyncMemory;
  baseDelayMs?: number;
  /** Resend projects whose bundle has not changed (Sync now with --force). */
  force?: boolean;
  /**
   * The schedule's per-project backoff: when a project last failed, the time it waits until (ISO), else null. A
   * waiting project is neither exported nor sent this run; the others keep their interval.
   */
  waiting?: (key: string) => string | null;
  onProgress?: (p: SyncProgress) => void;
}): Promise<CloudSyncResult> {
  const host = new URL(d.cloud.url).host;
  const sent = zero();
  const results: ProjectSyncResult[] = [];
  let error: string | null = null;
  let stopped = false;
  const keys = [...new Set(await d.projects())];
  for (const [i, key] of keys.entries()) {
    d.onProgress?.({ done: i, total: keys.length, current: key });
    if (stopped) {
      results.push({ key, status: 'not sent', counts: null });
      continue;
    }
    const until = d.waiting?.(key) ?? null;
    if (until) {
      results.push({ key, status: 'waiting', counts: null, until });
      continue;
    }
    const previous = await d.memory?.get(key);
    const stored = await syncBundle(d.portability, key, previous, { suggestions: d.cloud.suggestions });
    if (!stored && !previous) {
      results.push({ key, status: 'empty', counts: null });
      continue;
    }
    const bundle = stored ?? tombstone(key, previous!);
    const counts = bundleCounts(bundle);
    const print = fingerprint(bundle);
    if (!d.force && previous?.fingerprint === print && !bundle.withdrawn.length) {
      results.push({ key, status: 'unchanged', counts });
      continue;
    }
    try {
      const { r, trimmed } = await pushFitting(bundle, (b) => pushBundle({ cloud: d.cloud, bundle: b, fetch: d.fetch, sleep: d.sleep, baseDelayMs: d.baseDelayMs }));
      // The whole bundle's fingerprint even when its code map was cut: an unchanged project is not cut and resent each run.
      if (stored) await d.memory?.set(key, record(key, bundle, print));
      else await d.memory?.delete(key);
      const went = trimmed ? { ...counts, codeFiles: trimmed.codeFiles.sent } : counts;
      for (const k of Object.keys(sent) as (keyof SyncCounts)[]) sent[k] += went[k];
      const filed = r.projects?.find((p) => p.localKey === key) ?? r.projects?.[0];
      results.push({ key, status: 'sent', counts: went, cloudKey: filed?.key, namespace: filed?.namespace, lessons: r.lessons, syncId: r.syncId, withdrawn: bundle.withdrawn.length, ...(trimmed ? { trimmed } : {}) });
    } catch (err) {
      const e = err instanceof CloudSyncError ? err : new CloudSyncError(String(err), 0);
      results.push({ key, status: 'failed', counts, error: e.message });
      error ??= `${key}: ${e.message}`;
      if (e.fatal) stopped = true;
    }
  }
  // Synced before, not in the list now (unselected, excluded, or left out of SYNC_PROJECTS): take it back out of the
  // team graph once, so the team copy does not linger. Only ids already sent go, and the remote it was filed under.
  const listed = new Set(keys);
  for (const key of d.memory ? [...(await d.memory.keys())].filter((k) => !listed.has(k)).sort() : []) {
    if (stopped) break;
    const until = d.waiting?.(key) ?? null;
    if (until) {
      results.push({ key, status: 'waiting', counts: null, until });
      continue;
    }
    const previous = await d.memory!.get(key);
    if (!previous) continue;
    const bundle = tombstone(key, previous);
    try {
      const r = await pushBundle({ cloud: d.cloud, bundle, fetch: d.fetch, sleep: d.sleep, baseDelayMs: d.baseDelayMs });
      await d.memory!.delete(key);
      const filed = r.projects?.find((p) => p.localKey === key) ?? r.projects?.[0];
      results.push({ key, status: 'withdrawn', counts: bundleCounts(bundle), cloudKey: filed?.key, namespace: filed?.namespace, syncId: r.syncId, withdrawn: bundle.withdrawn.length });
    } catch (err) {
      const e = err instanceof CloudSyncError ? err : new CloudSyncError(String(err), 0);
      results.push({ key, status: 'failed', counts: null, error: `withdrawing it: ${e.message}` });
      error ??= `${key}: withdrawing it: ${e.message}`;
      if (e.fatal) stopped = true;
    }
  }
  d.onProgress?.({ done: keys.length, total: keys.length, current: null });
  const result: CloudSyncResult = { at: new Date().toISOString(), trigger: d.trigger, host, ok: error === null, sent, projects: results, error, stopped };
  const sentKeys = results.filter((r) => r.status === 'sent').map((r) => r.key);
  const failedKeys = results.filter((r) => r.status === 'failed').map((r) => r.key);
  const withdrawnKeys = results.filter((r) => r.status === 'withdrawn').map((r) => r.key);
  const unchanged = results.filter((r) => r.status === 'unchanged').length;
  const asked = d.trigger === 'manual' && unchanged > 0;
  if (d.activity && (sentKeys.length || failedKeys.length || withdrawnKeys.length || asked)) {
    const what = `${plural(sent.lessons, 'lesson')}, ${plural(sent.misses, 'miss', 'misses')}, ${plural(sent.facts, 'fact')}, ${plural(sent.docs, 'doc')}`;
    const attempted = sentKeys.length + failedKeys.length + withdrawnKeys.length;
    const cut = results.filter((r) => r.trimmed).map((r) => `; ${r.key}'s code map cut to ${r.trimmed!.codeFiles.sent} of ${r.trimmed!.codeFiles.of} files (too large for the cloud)`).join('');
    const took = `${withdrawnKeys.length ? `; took ${list(withdrawnKeys)} back out (no longer synced)` : ''}${cut}`;
    const subject = !sentKeys.length && !failedKeys.length && !withdrawnKeys.length
      ? `nothing to send to ${host}: ${plural(unchanged, 'project')} unchanged since the last sync`
      : !failedKeys.length
      ? (sentKeys.length ? `sent ${plural(sentKeys.length, 'project')} to ${host}: ${what}${took}` : `took ${list(withdrawnKeys)} back out of ${host}: no longer synced`)
      : sentKeys.length || withdrawnKeys.length
        ? `${failedKeys.length} of ${plural(attempted, 'project')} failed to sync to ${host}; sent ${list(sentKeys) || 'nothing'} (${what})${took}`
        : `sync to ${host} failed: ${error}`;
    await d.activity.record({
      kind: 'cloud_synced',
      actor: d.trigger === 'manual' ? 'you' : 'sync schedule',
      projectKey: null,
      subject: subject.slice(0, 500),
      why: d.trigger === 'manual'
        ? 'you asked for Sync now (Settings, or fg cloud sync-now)'
        : `CLOUD_URL and CLOUD_TOKEN are set and SYNC_INTERVAL_MINUTES is ${d.cloud.intervalMinutes}`,
      details: {
        host,
        ok: result.ok,
        trigger: d.trigger,
        projects: sentKeys,
        failed: failedKeys,
        withdrawnProjects: withdrawnKeys,
        sent,
        results: results.map(({ key, status, counts, cloudKey, namespace, lessons, syncId, withdrawn, trimmed, until, error: e }) => ({ key, status, counts, cloudKey, namespace, lessons, syncId, withdrawn, trimmed, until, error: e })),
        error,
      },
      targets: [],
    });
  }
  return result;
}

const DAY_MS = 86_400_000;

/** Wait before the next scheduled sync (or the next try of one failing project): the interval, doubled per failure in a row, at most a day. */
export function nextSyncDelayMs(intervalMinutes: number, failures: number): number {
  const base = intervalMinutes * 60_000;
  return Math.min(DAY_MS, base * 2 ** Math.min(failures, 20));
}
