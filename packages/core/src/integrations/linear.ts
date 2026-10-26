import { z } from 'zod';
import { IntegrationError } from './errors.ts';

/**
 * Linear issue search, used to find tickets related to a miss so we can learn the
 * requirements the agent never saw.
 *
 * Returned text is raw Linear content and may contain pasted secrets. Redaction is the
 * caller's job: run it through the worker's `redactSecrets` before storing or prompting.
 */

export type LinearIssue = {
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  /** The team's key (ENG) and id: the id is what a project is mapped to (IntegrationLink.linearTeamId). */
  team: string;
  teamId: string;
  updatedAt: string;
  comments: { author: string; body: string }[];
};

export type SearchLinearOpts = { query: string; apiKey: string; first?: number; fetchImpl?: typeof fetch };

const ENDPOINT = 'https://api.linear.app/graphql';
const CHUNK_CAP = 4000;
const ERR_BODY_CAP = 500;

const SEARCH = `query SearchIssues($term: String!, $first: Int) {
  searchIssues(term: $term, first: $first) {
    nodes {
      identifier
      title
      description
      url
      state { name }
      team { id key }
      updatedAt
      comments(first: 10) { nodes { body user { name } } }
    }
  }
}`;

const IssueNode = z.object({
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  url: z.string(),
  state: z.object({ name: z.string() }).nullable().optional(),
  team: z.object({ id: z.string().optional(), key: z.string() }).nullable().optional(),
  updatedAt: z.string(),
  comments: z
    .object({ nodes: z.array(z.object({ body: z.string().nullable().optional(), user: z.object({ name: z.string() }).nullable().optional() })) })
    .nullable()
    .optional(),
});

const Envelope = z.object({
  data: z.object({ searchIssues: z.object({ nodes: z.array(IssueNode) }) }).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const GqlError = z.object({ message: z.string(), extensions: z.object({ code: z.string().optional(), type: z.string().optional() }).passthrough().optional() });

/**
 * One GraphQL call. HTTP and GraphQL errors become IntegrationErrors: a rejected key is `auth`, Linear's rate limit
 * (HTTP 429, or a RATELIMITED error) is `rate_limit` with the reset time when Linear sends it. The key never appears
 * in a message.
 */
async function linearRequest(apiKey: string, query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: apiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const reset = Number(res.headers.get('x-ratelimit-requests-reset'));
  const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset).toISOString() : null;
  if (!res.ok) {
    const text = (await res.text()).slice(0, ERR_BODY_CAP);
    const limited = res.status === 429 || /RATELIMITED/.test(text);
    const kind = limited ? 'rate_limit' : res.status === 401 || res.status === 403 || /AUTHENTICATION_ERROR/i.test(text) ? 'auth' : 'other';
    throw new IntegrationError(`linear ${res.status}: ${text}`, kind, limited ? resetAt : null);
  }
  const body = z.object({ data: z.unknown().optional(), errors: z.array(GqlError).optional() }).parse(await res.json());
  if (body.errors?.length) {
    const codes = body.errors.map((e) => `${e.extensions?.code ?? ''} ${e.extensions?.type ?? ''}`).join(' ');
    const kind = /RATELIMITED/.test(codes) ? 'rate_limit' : /AUTHENTICATION|authentication/.test(codes) ? 'auth' : 'other';
    throw new IntegrationError(`linear graphql: ${body.errors.map((e) => e.message).join('; ')}`, kind, kind === 'rate_limit' ? resetAt : null);
  }
  if (body.data == null) throw new IntegrationError('linear graphql: response had no data', 'other');
  return body.data;
}

/** Full-text search over Linear issues. `apiKey` is a personal key, sent raw (no Bearer). */
export async function searchLinearIssues(o: SearchLinearOpts): Promise<LinearIssue[]> {
  const data = await linearRequest(o.apiKey, SEARCH, { term: o.query, first: o.first ?? 10 }, o.fetchImpl ?? fetch);
  const body = Envelope.parse({ data });
  if (!body.data) throw new Error('linear graphql: response had no data');
  return body.data.searchIssues.nodes.map((n) => ({
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? '',
    url: n.url,
    state: n.state?.name ?? '',
    team: n.team?.key ?? '',
    teamId: n.team?.id ?? '',
    updatedAt: n.updatedAt,
    comments: (n.comments?.nodes ?? [])
      .filter((c) => c.body && c.body.trim() !== '')
      .map((c) => ({ author: c.user?.name ?? 'unknown', body: c.body ?? '' })),
  }));
}

const VIEWER = `query Viewer { viewer { name email } organization { name } }`;

/** Who a key belongs to: one cheap call that proves the key works. */
export async function linearViewer(o: { apiKey: string; fetchImpl?: typeof fetch }): Promise<{ name: string; organization: string | null }> {
  const data = z
    .object({ viewer: z.object({ name: z.string(), email: z.string().nullable().optional() }), organization: z.object({ name: z.string() }).nullable().optional() })
    .parse(await linearRequest(o.apiKey, VIEWER, {}, o.fetchImpl ?? fetch));
  return { name: data.viewer.name, organization: data.organization?.name ?? null };
}

export type LinearTeam = { id: string; key: string; name: string };

const TEAMS = `query Teams { teams(first: 250) { nodes { id key name } } }`;

/** The teams the key can see, by name. */
export async function listLinearTeams(o: { apiKey: string; fetchImpl?: typeof fetch }): Promise<LinearTeam[]> {
  const data = z
    .object({ teams: z.object({ nodes: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })) }) })
    .parse(await linearRequest(o.apiKey, TEAMS, {}, o.fetchImpl ?? fetch));
  return [...data.teams.nodes].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A comment on an issue of a team (fetchLinearComments). `branch` is the issue's suggested git branch; `description`
 * the ticket's markdown ('' when it has none), read with its state, priority, labels and assignee for context.
 */
export type LinearComment = {
  id: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  issue: {
    id: string;
    identifier: string;
    title: string;
    url: string;
    branch: string | null;
    description: string;
    state: string | null;
    priority: string | null;
    labels: string[];
    assignee: string | null;
  };
};

const TEAM_COMMENTS = `query TeamComments($teamId: ID!, $since: DateTimeOrDuration!, $after: String) {
  issues(first: 50, after: $after, orderBy: updatedAt, filter: { team: { id: { eq: $teamId } }, updatedAt: { gt: $since } }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title url branchName description priorityLabel updatedAt
      state { name }
      labels(first: 20) { nodes { name } }
      assignee { name displayName }
      comments(first: 100) { nodes { id body url createdAt user { name displayName } botActor { name } } }
    }
  }
}`;

const MAX_LINEAR_PAGES = 10;

const CommentsPage = z.object({
  issues: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable().optional() }),
    nodes: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        url: z.string(),
        branchName: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        priorityLabel: z.string().nullable().optional(),
        updatedAt: z.string().nullable().optional(),
        state: z.object({ name: z.string() }).nullable().optional(),
        labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullable().optional(),
        assignee: z.object({ name: z.string(), displayName: z.string().nullable().optional() }).nullable().optional(),
        comments: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              body: z.string().nullable().optional(),
              url: z.string().nullable().optional(),
              createdAt: z.string(),
              user: z.object({ name: z.string(), displayName: z.string().nullable().optional() }).nullable().optional(),
              botActor: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
            }),
          ),
        }),
      }),
    ),
  }),
});

/** A team's issue as read for context (fetchLinearIssues): the ticket and its people's comments, oldest first. */
export type LinearTeamIssue = LinearComment['issue'] & { updatedAt: string | null; comments: Omit<LinearComment, 'issue'>[] };

/**
 * The team's issues updated after `since` (ISO), with the comments people (not bots or integrations) wrote on them:
 * one GraphQL query per page of 50, at most 10 pages. Raw text: redaction is the caller's job.
 */
export async function fetchLinearIssues(o: { apiKey: string; teamId: string; since: string; fetchImpl?: typeof fetch }): Promise<LinearTeamIssue[]> {
  const out: LinearTeamIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_LINEAR_PAGES; page++) {
    const data = CommentsPage.parse(await linearRequest(o.apiKey, TEAM_COMMENTS, { teamId: o.teamId, since: o.since, after }, o.fetchImpl ?? fetch));
    for (const i of data.issues.nodes) {
      out.push({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        url: i.url,
        branch: i.branchName ?? null,
        description: i.description ?? '',
        state: i.state?.name ?? null,
        priority: i.priorityLabel ?? null,
        labels: (i.labels?.nodes ?? []).map((l) => l.name),
        assignee: i.assignee ? i.assignee.displayName || i.assignee.name : null,
        updatedAt: i.updatedAt ?? null,
        comments: i.comments.nodes
          .filter((c) => c.user && !c.botActor && c.body?.trim())
          .map((c) => ({ id: c.id, author: c.user!.displayName || c.user!.name, body: c.body!, url: c.url ?? i.url, createdAt: c.createdAt }))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      });
    }
    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
    after = data.issues.pageInfo.endCursor;
  }
  return out;
}

/** The issues' comments as feedback (one per comment, carrying its ticket), oldest first. */
export function linearCommentsOf(issues: LinearTeamIssue[]): LinearComment[] {
  return issues
    .flatMap(({ comments, updatedAt: _u, ...issue }) => comments.map((c) => ({ ...c, issue })))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Comments by people (not bots or integrations) on the team's issues updated after `since` (ISO), oldest first, at
 * most 10 pages of 50 issues. Raw text: redaction is the caller's job.
 */
export async function fetchLinearComments(o: { apiKey: string; teamId: string; since: string; fetchImpl?: typeof fetch }): Promise<LinearComment[]> {
  return linearCommentsOf(await fetchLinearIssues(o));
}

/** The latest comments of an issue kept as context: older ones are in the Inbox threads already. */
const MAX_DOC_COMMENTS = 30;

/**
 * An issue as a document's chunks: the ticket (identifier, state, priority, labels, title, url, description), then one
 * chunk per comment (the latest 30), each naming the ticket so a search hit says where it is from. Capped at 4000 chars.
 */
export function linearIssueDocChunks(i: LinearTeamIssue): string[] {
  const details = [i.state, i.priority, ...i.labels].filter(Boolean).join(', ');
  const head = `Linear ${i.identifier}${details ? ` (${details})` : ''}: ${i.title}\n${i.url}${i.assignee ? `\nAssignee: ${i.assignee}` : ''}${i.description.trim() ? `\n\n${i.description.trim()}` : ''}`;
  return [
    head.slice(0, CHUNK_CAP),
    ...i.comments.slice(-MAX_DOC_COMMENTS).map((c) => `comment by ${c.author} on Linear ${i.identifier} (${i.title}):\n${c.body}`.slice(0, CHUNK_CAP)),
  ];
}

/** Linear identifiers such as ENG-123 (a team key of 2 to 10 letters and digits, starting with two letters). */
const TICKET_ID = /\b([A-Za-z]{2}[A-Za-z0-9]{0,8})-(\d{1,6})\b/g;
const MAX_TICKET_IDS = 20;

/**
 * The ticket identifiers a pull request names in its title, body or branch (jo/eng-45-fix is ENG-45), upper-cased, in
 * order, at most 20. Anything shaped like one counts ("UTF-8"): a link is made only to a stored Linear issue with that
 * identifier (DocsStore.linkedDocs), so a lookalike links nothing.
 */
export function ticketIdsIn(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(TICKET_ID)) if (out.size < MAX_TICKET_IDS) out.add(`${m[1].toUpperCase()}-${m[2]}`);
  return [...out];
}

/** One chunk per issue: header, description, then comments; capped at 4000 chars. */
export function linearIssueToChunk(i: LinearIssue): { ref: string; text: string } {
  const comments = i.comments.map((c) => `- ${c.author}: ${c.body}`).join('\n');
  const text = `Linear ${i.identifier} [${i.team}] (${i.state}): ${i.title}\n${i.url}\n\n${i.description}${comments ? `\n\nComments:\n${comments}` : ''}`;
  return { ref: `linear:${i.identifier}`, text: text.slice(0, CHUNK_CAP) };
}
