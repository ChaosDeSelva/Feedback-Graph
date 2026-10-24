import { z } from 'zod';
import { IntegrationError } from './errors.ts';

/**
 * GitHub PR discussion as project context. Review comments are where humans state
 * requirements and push back, so they are the richest signal for "what was really wanted".
 *
 * Text returned here (titles, bodies, comments) is raw GitHub content and may contain
 * secrets someone pasted into a PR. Redaction is the caller's job: run it through the
 * worker's `redactSecrets` before storing or sending it to a model.
 */

export type PrComment = {
  /** GitHub's id of the comment or review (unique within its kind). */
  id: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  url: string;
  createdAt: string;
  kind: 'review_comment' | 'issue_comment' | 'review';
  /** The diff lines a review comment is attached to (the end of GitHub's diff_hunk); null for other kinds. */
  diffHunk: string | null;
};

export type PrContext = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  updatedAt: string;
  /** The PR's head branch (where the work was done); null when GitHub did not say. */
  headBranch: string | null;
  body: string;
  comments: PrComment[];
};

export type FetchPrOpts = { repo: string; token: string; since?: string; maxPrs?: number; fetchImpl?: typeof fetch };

const API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PROJECT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_PAGES = 10;
const CHUNK_CAP = 4000;
const ERR_BODY_CAP = 500;
const HUNK_CAP = 1500;

function validRepo(repo: string): boolean {
  return REPO_RE.test(repo) && !repo.split('/')[1].split('').every((c) => c === '.');
}

/** Parse `GITHUB_REPOS`, e.g. `demo-shop=acme/demo-shop,other_app=me/other-app`. */
export function parseGithubRepos(spec: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of spec.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const project = eq < 0 ? '' : entry.slice(0, eq).trim();
    const repo = eq < 0 ? '' : entry.slice(eq + 1).trim();
    if (!PROJECT_RE.test(project) || !validRepo(repo)) {
      throw new Error(`GITHUB_REPOS: malformed entry ${JSON.stringify(entry)}, expected project=owner/repo`);
    }
    out.set(project, repo);
  }
  return out;
}

const User = z.object({ login: z.string(), type: z.string().optional() }).nullable();

const PullSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  user: User,
  state: z.string(),
  merged_at: z.string().nullable().optional(),
  updated_at: z.string(),
  body: z.string().nullable().optional(),
  head: z.object({ ref: z.string() }).nullable().optional(),
});

const Id = z.union([z.number(), z.string()]).optional();

const ReviewCommentSchema = z.object({
  id: Id,
  diff_hunk: z.string().nullable().optional(),
  user: User,
  body: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  original_line: z.number().nullable().optional(),
  html_url: z.string(),
  created_at: z.string(),
});

const IssueCommentSchema = z.object({
  id: Id,
  user: User,
  body: z.string().nullable().optional(),
  html_url: z.string(),
  created_at: z.string(),
});

const ReviewSchema = z.object({
  id: Id,
  user: User,
  body: z.string().nullable().optional(),
  html_url: z.string().optional(),
  submitted_at: z.string().nullable().optional(),
});

type GhUser = z.infer<typeof User>;

function isBot(u: GhUser): boolean {
  return !!u && (u.type === 'Bot' || u.login.endsWith('[bot]'));
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

async function ghFetch(url: string, token: string, fetchImpl: typeof fetch): Promise<Response> {
  if (!url.startsWith(`${API}/`)) throw new Error(`github: refusing to follow a link outside ${API}`);
  const res = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'feedback-graph',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return res;
  const text = (await res.text()).slice(0, ERR_BODY_CAP);
  const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(text)));
  if (limited) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const retryAfter = Number(res.headers.get('retry-after'));
    const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString()
      : Number.isFinite(retryAfter) && retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000).toISOString() : null;
    throw new IntegrationError(`github ${res.status} rate limit exceeded${at ? `; resets at ${at}` : ''}: ${text}`, 'rate_limit', at);
  }
  if (res.status === 401) throw new IntegrationError(`github 401: the token was rejected (revoked, expired or mistyped): ${text}`, 'auth');
  if (res.status === 403) throw new IntegrationError(`github 403: the token cannot read this (check its repository access and permissions): ${text}`, 'auth');
  if (res.status === 404) throw new IntegrationError(`github 404: not found, or not visible to this token: ${text}`, 'not_found');
  throw new IntegrationError(`github ${res.status}: ${text}`, 'other');
}

/** Walk `Link: rel="next"` pages (capped), yielding each page's parsed items. */
async function* pages<T>(url: string, schema: z.ZodType<T>, token: string, fetchImpl: typeof fetch): AsyncGenerator<T[]> {
  let next: string | null = url;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const res = await ghFetch(next, token, fetchImpl);
    yield z.array(schema).parse(await res.json());
    next = nextLink(res.headers.get('link'));
  }
}

async function all<T>(url: string, schema: z.ZodType<T>, token: string, fetchImpl: typeof fetch): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pages(url, schema, token, fetchImpl)) out.push(...page);
  return out;
}

const keep = (u: GhUser, body: string | null | undefined): body is string => !isBot(u) && !!body && body.trim() !== '';

async function commentsFor(repo: string, n: number, token: string, fetchImpl: typeof fetch): Promise<PrComment[]> {
  const base = `${API}/repos/${repo}`;
  const [review, issue, reviews] = await Promise.all([
    all(`${base}/pulls/${n}/comments?per_page=100`, ReviewCommentSchema, token, fetchImpl),
    all(`${base}/issues/${n}/comments?per_page=100`, IssueCommentSchema, token, fetchImpl),
    all(`${base}/pulls/${n}/reviews?per_page=100`, ReviewSchema, token, fetchImpl),
  ]);
  const out: PrComment[] = [];
  const idOf = (id: string | number | undefined, url: string) => (id === undefined ? commentId(url, out.length) : String(id));
  for (const c of review) {
    if (!keep(c.user, c.body)) continue;
    const diffHunk = c.diff_hunk ? c.diff_hunk.slice(-HUNK_CAP) : null;
    out.push({ id: idOf(c.id, c.html_url), author: c.user?.login ?? 'ghost', body: c.body, path: c.path ?? null, line: c.line ?? c.original_line ?? null, url: c.html_url, createdAt: c.created_at, kind: 'review_comment', diffHunk });
  }
  for (const c of issue) {
    if (!keep(c.user, c.body)) continue;
    out.push({ id: idOf(c.id, c.html_url), author: c.user?.login ?? 'ghost', body: c.body, path: null, line: null, url: c.html_url, createdAt: c.created_at, kind: 'issue_comment', diffHunk: null });
  }
  for (const r of reviews) {
    if (!keep(r.user, r.body)) continue;
    out.push({ id: idOf(r.id, r.html_url ?? ''), author: r.user?.login ?? 'ghost', body: r.body, path: null, line: null, url: r.html_url ?? '', createdAt: r.submitted_at ?? '', kind: 'review', diffHunk: null });
  }
  return out;
}

/**
 * Recently updated PRs (newest first) with their review comments, conversation comments,
 * and review bodies. Stops at `since` (ISO time) or `maxPrs` (default 30). Bot authors and
 * empty bodies are dropped. Output is unredacted; see the module comment.
 */
/** Safety cap for one incremental sync; at a 6-hour interval no real repository gets near it. */
export const INCREMENTAL_MAX_PRS = 1000;

export async function fetchPullRequestContext(o: FetchPrOpts): Promise<PrContext[]> {
  if (!validRepo(o.repo)) throw new Error(`github: malformed repo ${JSON.stringify(o.repo)}, expected owner/repo`);
  const fetchImpl = o.fetchImpl ?? fetch;
  // A first sync takes the most recent PRs; an incremental one must take everything since the cursor,
  // because the caller moves the cursor forward afterwards and anything skipped would never come back.
  const maxPrs = Math.max(1, o.maxPrs ?? (o.since ? INCREMENTAL_MAX_PRS : 30));
  const sinceMs = o.since ? Date.parse(o.since) : Number.NEGATIVE_INFINITY;
  if (Number.isNaN(sinceMs)) throw new Error(`github: invalid since ${JSON.stringify(o.since)}`);
  const perPage = Math.min(maxPrs, 100);
  const listUrl = `${API}/repos/${o.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}`;

  const picked: z.infer<typeof PullSchema>[] = [];
  let seen = 0;
  outer: for await (const page of pages(listUrl, PullSchema, o.token, fetchImpl)) {
    for (const p of page) {
      if (Date.parse(p.updated_at) < sinceMs || seen >= maxPrs) break outer;
      seen++;
      if (!isBot(p.user)) picked.push(p);
    }
    if (seen >= maxPrs) break;
  }

  const out: PrContext[] = [];
  for (const p of picked) {
    out.push({
      repo: o.repo,
      number: p.number,
      title: p.title,
      url: p.html_url,
      author: p.user?.login ?? 'ghost',
      state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
      updatedAt: p.updated_at,
      headBranch: p.head?.ref ?? null,
      body: p.body ?? '',
      comments: await commentsFor(o.repo, p.number, o.token, fetchImpl),
    });
  }
  return out;
}

const cap = (s: string) => s.slice(0, CHUNK_CAP);

function commentId(url: string, index: number): string {
  const m = url.match(/#(?:discussion_r|issuecomment-|pullrequestreview-)(\d+)$/);
  return m ? m[1] : String(index);
}

/** The account a token belongs to (GET /user): one cheap call that proves the token works. */
export async function githubViewer(o: { token: string; fetchImpl?: typeof fetch }): Promise<{ login: string }> {
  const res = await ghFetch(`${API}/user`, o.token, o.fetchImpl ?? fetch);
  return z.object({ login: z.string() }).parse(await res.json());
}

/** "owner/repo" for a github.com remote as normalizeRemote writes it (github.com/owner/repo); null for any other. */
export function githubRepoOfRemote(remote: string | null | undefined): string | null {
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(remote ?? '');
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  return validRepo(repo) ? repo : null;
}

/** One chunk for the PR (title + body) and one per comment, each capped at 4000 chars. */
export function prContextToChunks(pr: PrContext): { ref: string; text: string }[] {
  const ref = `github:${pr.repo}#${pr.number}`;
  const chunks = [{ ref, text: cap(`PR ${pr.repo}#${pr.number} (${pr.state}) by ${pr.author}: ${pr.title}\n\n${pr.body}`) }];
  pr.comments.forEach((c, i) => {
    const where = c.path ? ` on ${c.path}${c.line != null ? `:${c.line}` : ''}` : '';
    const label = c.kind === 'review_comment' ? 'review comment' : c.kind === 'review' ? 'review' : 'comment';
    chunks.push({
      ref: `${ref}/comment/${commentId(c.url, i)}`,
      text: cap(`${label} by ${c.author}${where} on PR ${pr.repo}#${pr.number} (${pr.title}):\n${c.body}`),
    });
  });
  return chunks;
}
