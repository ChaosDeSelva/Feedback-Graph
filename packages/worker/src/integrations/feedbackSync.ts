import {
  githubRepoOfRemote, integrationErrorKind, IntegrationError, redactSecrets,
  type ActivityStore, type Credential, type DocsStore, type ExternalRef, type ExternalThread, type FetchPrOpts, type GraphStore,
  type IntegrationKind, type Integrations, type IntegrationSyncState, type LinearComment, type PrContext, type Project, type WorkSession,
} from '@fb/core';

/**
 * Review comments on pull requests (GitHub) and comments on issues (Linear) as feedback for the Inbox. Each PR or issue
 * is stored as a stand-in thread (GraphStore.upsertExternalThread) whose turns the classifier labels like transcript
 * turns; pushback and corrections become Inbox items with source github or linear.
 *
 * Only the tracked projects are synced. Per project and service there is an incremental cursor
 * (`feedback-<service>:<project>`, removed with the project), and a project is synced at most every `minIntervalMs`.
 * The first sync looks back `lookbackDays` only, so connecting does not fill the Inbox with old review history.
 * A rejected token stops that service until the token changes; a rate limit stops it until the limit lifts.
 */

export type SyncProject = Project & { remote: string | null };

export type FeedbackSyncDeps = {
  integrations: Pick<Integrations, 'credential' | 'sync' | 'saveSync' | 'link'>;
  graph: Pick<GraphStore, 'upsertExternalThread' | 'workSessions'>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  /** The tracked (and not excluded) projects, with their canonical remotes. */
  projects(): Promise<SyncProject[]>;
  /** GITHUB_REPOS: project key -> owner/repo, overriding the remote. */
  githubOverride?: Map<string, string>;
  fetchPrs(o: FetchPrOpts): Promise<PrContext[]>;
  fetchLinear(o: { apiKey: string; teamId: string; since: string }): Promise<LinearComment[]>;
  activity?: Pick<ActivityStore, 'record'>;
  minIntervalMs: number;
  lookbackDays?: number;
  now?: () => Date;
  log?: (msg: string, extra?: object) => void;
};

const DAY = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 14;
/** When a rate-limit answer did not say when it lifts. */
const RATE_LIMIT_PAUSE_MS = 15 * 60_000;
/** How far before a comment an agent session with no branch match can have been active, to count as the work. */
const WINDOW_MS = 2 * DAY;
const CONTEXT_CAP = 2500;

export const feedbackCursor = (kind: IntegrationKind, projectKey: string) => `feedback-${kind}:${projectKey}`;

/** The repository a project's PR comments come from: GITHUB_REPOS first, else its github.com remote. */
export function githubTarget(p: SyncProject, override?: Map<string, string>): string | null {
  return override?.get(p.key) ?? githubRepoOfRemote(p.remote);
}

/**
 * The agent sessions that most likely did the work: those of the project on the work's branch that started before
 * the comment; with none, the one session active in the two days before it (several: none, rather than a wrong one).
 */
export async function findWorkSessions(graph: Pick<GraphStore, 'workSessions'>, projectKey: string, branch: string | null, before: string): Promise<WorkSession[]> {
  if (branch) {
    const onBranch = await graph.workSessions({ projectKey, branch, before, limit: 3 });
    if (onBranch.length) return onBranch;
  }
  const after = new Date(Date.parse(before) - WINDOW_MS).toISOString();
  const near = await graph.workSessions({ projectKey, branch: null, before, after, limit: 2 });
  return near.length === 1 ? near : [];
}

export async function linkWorkSessions(graph: Pick<GraphStore, 'workSessions'>, projectKey: string, branch: string | null, before: string): Promise<string[]> {
  return (await findWorkSessions(graph, projectKey, branch, before)).map((s) => s.id);
}

const clip = (s: string, n = CONTEXT_CAP) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A PR's comments as a thread: indexes follow creation order over all of them, so they stay put between syncs. */
export function prThread(pr: PrContext, floorMs: number, linked: string[]): ExternalThread {
  const ordered = [...pr.comments].filter((c) => c.createdAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const header = `PR ${pr.repo}#${pr.number} "${pr.title}" by ${pr.author} (${pr.state}${pr.headBranch ? `, branch ${pr.headBranch}` : ''})`;
  return {
    id: `github:${pr.repo}#${pr.number}`,
    source: 'github',
    items: ordered.flatMap((c, i) => {
      if (Date.parse(c.createdAt) < floorMs) return [];
      const where = c.path ? `\nOn ${c.path}${c.line != null ? `:${c.line}` : ''}${c.diffHunk ? `\n${c.diffHunk}` : ''}` : '';
      const external: ExternalRef = {
        source: 'github', kind: c.kind, author: c.author, url: c.url, thread: `${pr.repo}#${pr.number}`, title: pr.title, threadUrl: pr.url,
        path: c.path, line: c.line, diffHunk: c.diffHunk, branch: pr.headBranch, createdAt: c.createdAt, linkedSessionIds: linked,
      };
      return [{ uuid: `github:${pr.repo}#${pr.number}/${c.kind}/${c.id}`, ts: c.createdAt, index: i + 1, text: c.body, context: clip(`${header}${where}`), external }];
    }),
  };
}

/** One Linear issue's comments as a thread. */
export function linearThread(comments: LinearComment[], floorMs: number, linked: string[]): ExternalThread {
  const ordered = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const issue = ordered[0].issue;
  return {
    id: `linear:${issue.identifier}`,
    source: 'linear',
    items: ordered.flatMap((c, i) => {
      if (Date.parse(c.createdAt) < floorMs) return [];
      const external: ExternalRef = {
        source: 'linear', kind: 'linear_comment', author: c.author, url: c.url, thread: issue.identifier, title: issue.title, threadUrl: issue.url,
        path: null, line: null, diffHunk: null, branch: issue.branch, createdAt: c.createdAt, linkedSessionIds: linked,
      };
      return [{ uuid: `linear:${issue.identifier}/${c.id}`, ts: c.createdAt, index: i + 1, text: c.body, context: `Linear ${issue.identifier} "${issue.title}"`, external }];
    }),
  };
}

type Outcome = { added: number; threads: number; target: string };

/** Sync both services for every tracked project. Returns how many new comments each brought in. */
export async function syncExternalFeedback(d: FeedbackSyncDeps): Promise<Record<IntegrationKind, number>> {
  const out: Record<IntegrationKind, number> = { github: 0, linear: 0 };
  const projects = await d.projects();
  for (const kind of ['github', 'linear'] as const) {
    const cred = await d.integrations.credential(kind);
    if (!cred) continue;
    out[kind] = await syncKind(kind, cred, projects, d);
  }
  return out;
}

async function syncKind(kind: IntegrationKind, cred: Credential, projects: SyncProject[], d: FeedbackSyncDeps): Promise<number> {
  const now = d.now ?? (() => new Date());
  const state: IntegrationSyncState = await d.integrations.sync(kind);
  if (state.authFailedFor === cred.fingerprint) return 0; // rejected before: wait for a new token
  if (state.rateLimitedUntil && Date.parse(state.rateLimitedUntil) > now().getTime()) return 0;
  const lookback = (d.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * DAY;
  let added = 0;
  let attempted = false;
  let stopped = false;
  state.authFailedFor = null;
  state.rateLimitedUntil = null;
  state.lastError = null;
  state.errorKind = null;

  for (const p of projects) {
    const link = await d.integrations.link(p.key);
    const target = kind === 'github' ? (link.github ? githubTarget(p, d.githubOverride) : null) : link.linearTeamId;
    if (!target) {
      delete state.projects[p.key];
      continue;
    }
    const cursorKey = feedbackCursor(kind, p.key);
    const since = await d.cursors.getCursor(cursorKey);
    const started = now();
    if (since && started.getTime() - Date.parse(since) < d.minIntervalMs) continue;
    attempted = true;
    const floorMs = (since ? Date.parse(since) : started.getTime()) - lookback;
    const fetchSince = since ?? new Date(started.getTime() - lookback).toISOString();
    try {
      const r = kind === 'github' ? await syncRepo(p, target, cred.token, fetchSince, floorMs, d) : await syncTeam(p, target, link.linearTeamName ?? target, cred.token, fetchSince, floorMs, d);
      await d.cursors.setCursor(cursorKey, started.toISOString());
      added += r.added;
      state.projects[p.key] = { lastSyncAt: started.toISOString(), items: (state.projects[p.key]?.items ?? 0) + r.added, error: null, target: kind === 'github' ? target : link.linearTeamName ?? target };
      if (r.added) {
        await d.activity?.record({
          kind: 'feedback_synced', actor: kind, projectKey: p.key,
          subject: `${r.added} new comment${r.added === 1 ? '' : 's'} from ${r.threads} ${kind === 'github' ? 'pull request' : 'issue'}${r.threads === 1 ? '' : 's'} in ${r.target}`,
          why: since ? `updated since the last sync at ${since}` : `first sync: the last ${lookback / DAY} days`,
          details: { target: r.target },
        });
      }
    } catch (err) {
      const errorKind = integrationErrorKind(err);
      const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);
      d.log?.(`${kind} feedback sync failed`, { projectKey: p.key, kind: errorKind, error: message });
      state.projects[p.key] = { ...(state.projects[p.key] ?? { lastSyncAt: null, items: 0, target }), error: message };
      if (errorKind === 'auth' || errorKind === 'rate_limit') {
        state.lastError = message;
        state.errorKind = errorKind;
        if (errorKind === 'auth') state.authFailedFor = cred.fingerprint;
        else state.rateLimitedUntil = (err instanceof IntegrationError && err.retryAt) || new Date(now().getTime() + RATE_LIMIT_PAUSE_MS).toISOString();
        stopped = true;
        break;
      }
    }
  }
  if (attempted && !stopped) state.lastSyncAt = now().toISOString();
  for (const k of Object.keys(state.projects)) if (!projects.some((p) => p.key === k)) delete state.projects[k];
  await d.integrations.saveSync(kind, state);
  return added;
}

async function syncRepo(p: SyncProject, repo: string, token: string, since: string, floorMs: number, d: FeedbackSyncDeps): Promise<Outcome> {
  const prs = await d.fetchPrs({ repo, token, since });
  let added = 0;
  let threads = 0;
  for (const pr of prs) {
    const fresh = pr.comments.filter((c) => c.createdAt && Date.parse(c.createdAt) >= floorMs);
    if (!fresh.length) continue;
    const latest = fresh.map((c) => c.createdAt).sort().at(-1)!;
    const linked = await linkWorkSessions(d.graph, p.key, pr.headBranch, latest);
    const n = await d.graph.upsertExternalThread(p, prThread(pr, floorMs, linked));
    added += n;
    if (n) threads++;
  }
  return { added, threads, target: repo };
}

async function syncTeam(p: SyncProject, teamId: string, teamName: string, apiKey: string, since: string, floorMs: number, d: FeedbackSyncDeps): Promise<Outcome> {
  const comments = await d.fetchLinear({ apiKey, teamId, since });
  const byIssue = new Map<string, LinearComment[]>();
  for (const c of comments) byIssue.set(c.issue.id, [...(byIssue.get(c.issue.id) ?? []), c]);
  let added = 0;
  let threads = 0;
  for (const list of byIssue.values()) {
    const fresh = list.filter((c) => Date.parse(c.createdAt) >= floorMs);
    if (!fresh.length) continue;
    const latest = fresh.map((c) => c.createdAt).sort().at(-1)!;
    const linked = await linkWorkSessions(d.graph, p.key, list[0].issue.branch, latest);
    const n = await d.graph.upsertExternalThread(p, linearThread(list, floorMs, linked));
    added += n;
    if (n) threads++;
  }
  return { added, threads, target: `Linear team ${teamName}` };
}
