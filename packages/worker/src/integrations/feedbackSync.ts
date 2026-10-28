import {
  authorKindOf, foldsIntoInline, githubRepoOfRemote, type PrComment, integrationErrorKind, IntegrationError, redactSecrets,
  type ActivityStore, type Credential, type DocsStore, type ExternalRef, type ExternalThread, type FetchPrOpts, type GraphStore,
  type IntegrationKind, type Integrations, type IntegrationSyncState, type LinearComment, type LinearTeamIssue, type PrContext, type Project, type WorkSession,
  linearCommentsOf, linearDocRef, linearIssueDocChunks,
} from '@fb/core';
import { skipMatchingPending } from './pendingSkips.ts';

/**
 * Review comments on pull requests (GitHub) and comments on issues (Linear) as feedback for the Inbox; Linear issues
 * themselves (ticket and comments) as project documents, context rather than Inbox items. Each PR or issue
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
  /** pendingExternalItems and skipPendingItem: the pending Inbox items a skip rule matches after a backfill are skipped (unset: not looked at). */
  graph: Pick<GraphStore, 'upsertExternalThread' | 'workSessions'> & Partial<Pick<GraphStore, 'pendingExternalItems' | 'skipPendingItem'>>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  /** The tracked (and not excluded) projects, with their canonical remotes. */
  projects(): Promise<SyncProject[]>;
  /** GITHUB_REPOS: project key -> owner/repo, overriding the remote. */
  githubOverride?: Map<string, string>;
  fetchPrs(o: FetchPrOpts): Promise<PrContext[]>;
  /** The mapped team's issues updated since, with their comments (fetchLinearIssues: one query per page). */
  fetchLinearIssues(o: { apiKey: string; teamId: string; since: string }): Promise<LinearTeamIssue[]>;
  /**
   * With embed: each issue is also stored as a document (source linear, ref linear:<identifier>), project context like
   * a PR's discussion, found by docs search and linked to the PRs that name it (DocsStore.linkedDocs). Unset: comments only.
   */
  docs?: Pick<DocsStore, 'upsertDoc'>;
  embed?: (texts: string[]) => Promise<number[][]>;
  activity?: Pick<ActivityStore, 'record'>;
  minIntervalMs: number;
  lookbackDays?: number;
  /** GITHUB_BOT_LOGINS and GITHUB_AGENT_LOGINS (lower-cased): who counts as a bot or an AI agent besides the markers. */
  botLogins?: string[];
  agentLogins?: string[];
  now?: () => Date;
  log?: (msg: string, extra?: object) => void;
};

const DAY = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 14;
/** When a rate-limit answer did not say when it lifts. */
const RATE_LIMIT_PAUSE_MS = 15 * 60_000;
/**
 * How far before a comment an agent session with no branch match can have been active to be a candidate. Being in it
 * is never evidence (the files are), so it can span the days a PR waits for review.
 */
const WINDOW_MS = 7 * DAY;
const CONTEXT_CAP = 2500;

export const feedbackCursor = (kind: IntegrationKind, projectKey: string) => `feedback-${kind}:${projectKey}`;
/**
 * Set once a project's GitHub comments carry their author details (author kind, PR author, reply, review verdict).
 * Comments synced before those were kept have none, so the skip rules cannot see them: the first sync without this
 * marker fetches the last `lookbackDays` again, which rewrites the stored comments' details (classifications stay).
 */
export const authorsCursor = (projectKey: string) => `feedback-github-authors:${projectKey}`;
/** Failed backfill tries, as `<count>|<last try>`: a failing one waits the sync interval, and stops after MAX_BACKFILL_TRIES. */
const authorsTriesCursor = (projectKey: string) => `feedback-github-authors-tries:${projectKey}`;
const MAX_BACKFILL_TRIES = 3;

/** The repository a project's PR comments come from: GITHUB_REPOS first, else its github.com remote. */
export function githubTarget(p: SyncProject, override?: Map<string, string>): string | null {
  return override?.get(p.key) ?? githubRepoOfRemote(p.remote);
}

/** A session that edited files or committed; one that only read (a review, a question) never did the work. */
const didWork = (s: WorkSession) => s.edits + s.commits > 0;

/** Branches a session may have started on before it made the work's branch. */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

/**
 * Whether a session found by time alone can have done the work on `branch`: not when it ran on another feature branch.
 * A session with no branch recorded, or on a default branch (it may have created the work's branch), can.
 */
const mayBeOnBranch = (s: WorkSession, branch: string | null) => !branch || !s.gitBranch || s.gitBranch === branch || DEFAULT_BRANCHES.has(s.gitBranch);

/**
 * A session that may have done the work, and how it was found: on the work's branch, or only in the days before the
 * comment (`window`), a candidate that counts only if it edited the files the PR changed (postmortem/work.ts).
 */
export type WorkMatch = WorkSession & { by: 'branch' | 'window' };

/**
 * The version of the rule that matches a comment to the session that did its work (findWorkSessions and
 * postmortem/work.ts workMatches). Raise it when the rule changes: at start the worker re-matches what is pending and
 * flags proposed lessons whose session the new rule would not match (postmortem/rematch.ts).
 * 1: on the branch, else the only session in the two days before the comment, with a file the comment named.
 * 2: on the branch (not a default branch), else a session that edited files the PR changed; never by time alone.
 */
export const SESSION_MATCH_VERSION = 2;

/** Candidates off the branch: at most this many, so a busy week is not one files lookup per session. */
const MAX_WINDOW_CANDIDATES = 10;

/**
 * The agent sessions that may have done the work, all of the comment's project: those on the work's branch that edited
 * files or committed before the comment, most edits first; with none, those that did work in the days before it (not
 * on another feature branch), as candidates only: a session is never the work for being near in time, the post-mortem
 * keeps one only when it edited the files the PR changed (postmortem/work.ts). A PR from a default branch (main) says
 * nothing about who did it, so it has no branch match. The store already leaves read-only sessions out; checked again here.
 */
export async function findWorkSessions(graph: Pick<GraphStore, 'workSessions'>, projectKey: string, branch: string | null, before: string): Promise<WorkMatch[]> {
  if (branch && !DEFAULT_BRANCHES.has(branch)) {
    const onBranch = (await graph.workSessions({ projectKey, branch, before, limit: 3 })).filter(didWork);
    if (onBranch.length) return onBranch.map((s) => ({ ...s, by: 'branch' as const }));
  }
  const after = new Date(Date.parse(before) - WINDOW_MS).toISOString();
  const near = (await graph.workSessions({ projectKey, branch: null, before, after, limit: MAX_WINDOW_CANDIDATES })).filter(didWork);
  return near.filter((s) => mayBeOnBranch(s, branch)).map((s) => ({ ...s, by: 'window' as const }));
}

/** The sessions shown as a comment's work: only those on its branch (a match by time alone is not known to be it). */
export async function linkWorkSessions(graph: Pick<GraphStore, 'workSessions'>, projectKey: string, branch: string | null, before: string): Promise<string[]> {
  return (await findWorkSessions(graph, projectKey, branch, before)).filter((s) => s.by === 'branch').map((s) => s.id);
}

const clip = (s: string, n = CONTEXT_CAP) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** As much of a PR or ticket description as is kept: the cap a PR body has as a docs chunk (github.ts). */
const DESCRIPTION_CAP = 4000;

/** A ticket's short details (state, priority, assignee), its labels and how many: redacted and capped like the body. */
const FIELD_CAP = 200;
const LABEL_CAP = 60;
const MAX_LABELS = 20;
const field = (text: string | null | undefined): string | null => (text?.trim() ? clip(redactSecrets(text.trim()), FIELD_CAP) : null);

/** A PR's or ticket's description as stored on its comments: redacted, clipped; null when it has none. */
const description = (text: string | null | undefined): string | null => (text?.trim() ? clip(redactSecrets(text.trim()), DESCRIPTION_CAP) : null);

/** A PR's comments as a thread: indexes follow creation order over all of them, so they stay put between syncs. */
export type AuthorLogins = Pick<FeedbackSyncDeps, 'botLogins' | 'agentLogins'>;

/** The comment's author kind; the login lists are GitHub's and apply to GitHub logins only (authorKindOf). */
function author(source: 'github' | 'linear', login: string, body: string, logins: AuthorLogins): Pick<ExternalRef, 'authorKind' | 'authorVerified'> {
  const a = authorKindOf({ source, login, body, botLogins: logins.botLogins, agentLogins: logins.agentLogins });
  return { authorKind: a.kind, authorVerified: a.verified };
}

export function prThread(pr: PrContext, floorMs: number, linked: string[], logins: AuthorLogins = {}): ExternalThread {
  const ordered = [...pr.comments].filter((c) => c.createdAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const authorOf = new Map(pr.comments.map((c) => [c.id, c.author]));
  const header = `PR ${pr.repo}#${pr.number} "${pr.title}" by ${pr.author} (${pr.state}${pr.headBranch ? `, branch ${pr.headBranch}` : ''})`;
  const body = description(pr.body);
  const uuidOf = (c: PrComment) => `github:${pr.repo}#${pr.number}/${c.kind}/${c.id}`;
  const files = pr.files ? pr.files.slice(0, MAX_PR_FILES) : null;
  return {
    id: `github:${pr.repo}#${pr.number}`,
    source: 'github',
    items: ordered.flatMap((c, i) => {
      if (Date.parse(c.createdAt) < floorMs) return [];
      const folded = c.kind === 'review' ? foldedInto(c, ordered) : null;
      const where = c.path ? `\nOn ${c.path}${c.line != null ? `:${c.line}` : ''}${c.diffHunk ? `\n${c.diffHunk}` : ''}` : '';
      const external: ExternalRef = {
        source: 'github', kind: c.kind, author: c.author, url: c.url, thread: `${pr.repo}#${pr.number}`, title: pr.title, threadUrl: pr.url,
        path: c.path, line: c.line, diffHunk: c.diffHunk, branch: pr.headBranch, createdAt: c.createdAt, linkedSessionIds: linked,
        description: body, threadState: pr.state,
        ...author('github', c.author, c.body, logins), threadAuthor: pr.author, isReply: !!c.inReplyTo, repliesTo: c.inReplyTo ? authorOf.get(c.inReplyTo) ?? null : null, reviewState: c.reviewState ?? null,
        ...(folded && { foldedInto: uuidOf(folded) }),
        ...(files && { prFiles: files }),
      };
      return [{ uuid: uuidOf(c), ts: c.createdAt, index: i + 1, text: c.body, context: clip(`${header}${where}`), external }];
    }),
  };
}

/** How far apart a review's summary and its inline comments are posted (GitHub submits them together). */
const REVIEW_SPAN_MS = 10 * 60_000;
/** At most this many of a PR's changed files are kept on its comments. */
const MAX_PR_FILES = 300;

/**
 * The inline comment a review's summary folds into: the same reviewer's inline comments posted with it say the same
 * thing (feedbackRules.foldsIntoInline). Null: the summary says something of its own.
 */
function foldedInto(review: PrComment, all: PrComment[]): PrComment | null {
  const at = Date.parse(review.createdAt);
  const inline = all.filter((c) => c.kind === 'review_comment' && c.author === review.author && !c.inReplyTo && Math.abs(Date.parse(c.createdAt) - at) <= REVIEW_SPAN_MS);
  return foldsIntoInline(review.body, inline.map((c) => c.body)) ? inline[0] : null;
}

/** One Linear issue's comments as a thread, each carrying the ticket: its description, state, priority, labels, assignee. */
export function linearThread(comments: LinearComment[], floorMs: number, linked: string[], logins: AuthorLogins = {}): ExternalThread {
  const ordered = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const issue = ordered[0].issue;
  const body = description(issue.description);
  const ticket = {
    state: field(issue.state),
    priority: field(issue.priority),
    labels: (issue.labels ?? []).slice(0, MAX_LABELS).map((l) => clip(redactSecrets(l), LABEL_CAP)),
    assignee: field(issue.assignee),
  };
  return {
    id: `linear:${issue.identifier}`,
    source: 'linear',
    items: ordered.flatMap((c, i) => {
      if (Date.parse(c.createdAt) < floorMs) return [];
      const external: ExternalRef = {
        source: 'linear', kind: 'linear_comment', author: c.author, url: c.url, thread: issue.identifier, title: issue.title, threadUrl: issue.url,
        path: null, line: null, diffHunk: null, branch: issue.branch, createdAt: c.createdAt, linkedSessionIds: linked,
        description: body, ticket, ...author('linear', c.author, c.body, logins),
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
    // Synced before author details were kept: this once, the whole look-back window again (authorsCursor).
    const authorsKnown = kind !== 'github' || !!(await d.cursors.getCursor(authorsCursor(p.key)));
    const [triesRaw, lastTry] = (!authorsKnown && (await d.cursors.getCursor(authorsTriesCursor(p.key)))?.split('|')) || [];
    const tries = Number(triesRaw) || 0;
    // A failed backfill is the whole look-back window: not again every cycle, only once the sync interval has passed.
    const backfill = !!since && !authorsKnown && !(lastTry && started.getTime() - Date.parse(lastTry) < d.minIntervalMs);
    const floorMs = (since && !backfill ? Date.parse(since) : started.getTime()) - lookback;
    const fetchSince = since && !backfill ? since : new Date(started.getTime() - lookback).toISOString();
    try {
      const r = kind === 'github' ? await syncRepo(p, target, cred.token, fetchSince, floorMs, d, link.githubAuthor ?? undefined) : await syncTeam(p, target, link.linearTeamName ?? target, cred.token, fetchSince, floorMs, d, since);
      await d.cursors.setCursor(cursorKey, started.toISOString());
      // Only a backfill (or a first sync, which fetches everything with author details) marks them known.
      if (!authorsKnown && (backfill || !since)) await d.cursors.setCursor(authorsCursor(p.key), started.toISOString());
      if (backfill && d.graph.pendingExternalItems && d.graph.skipPendingItem) {
        await skipMatchingPending({
          graph: { pendingExternalItems: d.graph.pendingExternalItems.bind(d.graph), skipPendingItem: d.graph.skipPendingItem.bind(d.graph) },
          activity: d.activity, botLogins: d.botLogins, agentLogins: d.agentLogins, projectKey: p.key, log: d.log,
          why: 'synced before author details were kept, so the skip rules could not see them until now',
        });
      }
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
      if (backfill) {
        await d.cursors.setCursor(authorsTriesCursor(p.key), `${tries + 1}|${started.toISOString()}`);
        // Given up: the comments keep what they have, and the skip rules work on what arrives from now on.
        if (tries + 1 >= MAX_BACKFILL_TRIES) await d.cursors.setCursor(authorsCursor(p.key), started.toISOString());
      }
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

async function syncRepo(p: SyncProject, repo: string, token: string, since: string, floorMs: number, d: FeedbackSyncDeps, author?: string): Promise<Outcome> {
  const prs = await d.fetchPrs({ repo, token, since, ...(author && { author }) });
  let added = 0;
  let threads = 0;
  for (const pr of prs) {
    if (author && pr.author.toLowerCase() !== author.toLowerCase()) continue;
    const fresh = pr.comments.filter((c) => c.createdAt && Date.parse(c.createdAt) >= floorMs);
    if (!fresh.length && pr.state === 'open') continue;
    const latest = (fresh.length ? fresh : pr.comments).map((c) => c.createdAt).sort().at(-1) ?? pr.updatedAt;
    const linked = await linkWorkSessions(d.graph, p.key, pr.headBranch, latest);
    const n = await d.graph.upsertExternalThread(p, prThread(pr, pr.state === 'open' ? floorMs : 0, linked, d));
    added += n;
    if (n) threads++;
  }
  return { added, threads, target: repo };
}

/** The issues as documents: what the ticket says is context for the work on it, whether or not anyone commented. */
async function storeTickets(p: SyncProject, issues: LinearTeamIssue[], team: string, since: string | null, d: FeedbackSyncDeps): Promise<void> {
  if (!d.docs || !d.embed || !issues.length) return;
  const ids: string[] = [];
  for (const i of issues) {
    const chunks = linearIssueDocChunks(i).map((t) => redactSecrets(t));
    const vectors = await d.embed(chunks);
    ids.push(await d.docs.upsertDoc(
      { projectKey: p.key, source: 'linear', ref: linearDocRef(i.identifier), title: `${i.identifier}: ${i.title}`, url: i.url },
      chunks.map((text, n) => ({ text, embedding: vectors[n] })),
    ));
  }
  await d.activity?.record({
    kind: 'doc_added', actor: 'linear', projectKey: p.key,
    subject: `synced ${issues.length} Linear ticket${issues.length === 1 ? '' : 's'} from ${team}`,
    why: since ? `updated since the last sync at ${since}` : 'first sync of this team',
    details: { team, tickets: issues.map((i) => ({ identifier: i.identifier, title: i.title, comments: i.comments.length })) },
    targets: ids,
  });
}

async function syncTeam(p: SyncProject, teamId: string, teamName: string, apiKey: string, since: string, floorMs: number, d: FeedbackSyncDeps, cursor: string | null = null): Promise<Outcome> {
  const issues = await d.fetchLinearIssues({ apiKey, teamId, since });
  await storeTickets(p, issues, `Linear team ${teamName}`, cursor, d);
  const comments = linearCommentsOf(issues);
  const byIssue = new Map<string, LinearComment[]>();
  for (const c of comments) byIssue.set(c.issue.id, [...(byIssue.get(c.issue.id) ?? []), c]);
  let added = 0;
  let threads = 0;
  for (const list of byIssue.values()) {
    const fresh = list.filter((c) => Date.parse(c.createdAt) >= floorMs);
    if (!fresh.length) continue;
    const latest = fresh.map((c) => c.createdAt).sort().at(-1)!;
    const linked = await linkWorkSessions(d.graph, p.key, list[0].issue.branch, latest);
    const n = await d.graph.upsertExternalThread(p, linearThread(list, floorMs, linked, d));
    added += n;
    if (n) threads++;
  }
  return { added, threads, target: `Linear team ${teamName}` };
}
