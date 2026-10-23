import { z } from 'zod';

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
  team: string;
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
      team { key }
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
  team: z.object({ key: z.string() }).nullable().optional(),
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

/** Full-text search over Linear issues. `apiKey` is a personal key, sent raw (no Bearer). */
export async function searchLinearIssues(o: SearchLinearOpts): Promise<LinearIssue[]> {
  const res = await (o.fetchImpl ?? fetch)(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: o.apiKey },
    body: JSON.stringify({ query: SEARCH, variables: { term: o.query, first: o.first ?? 10 } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`linear ${res.status}: ${(await res.text()).slice(0, ERR_BODY_CAP)}`);
  const body = Envelope.parse(await res.json());
  if (body.errors?.length) throw new Error(`linear graphql: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!body.data) throw new Error('linear graphql: response had no data');
  return body.data.searchIssues.nodes.map((n) => ({
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? '',
    url: n.url,
    state: n.state?.name ?? '',
    team: n.team?.key ?? '',
    updatedAt: n.updatedAt,
    comments: (n.comments?.nodes ?? [])
      .filter((c) => c.body && c.body.trim() !== '')
      .map((c) => ({ author: c.user?.name ?? 'unknown', body: c.body ?? '' })),
  }));
}

/** One chunk per issue: header, description, then comments; capped at 4000 chars. */
export function linearIssueToChunk(i: LinearIssue): { ref: string; text: string } {
  const comments = i.comments.map((c) => `- ${c.author}: ${c.body}`).join('\n');
  const text = `Linear ${i.identifier} [${i.team}] (${i.state}): ${i.title}\n${i.url}\n\n${i.description}${comments ? `\n\nComments:\n${comments}` : ''}`;
  return { ref: `linear:${i.identifier}`, text: text.slice(0, CHUNK_CAP) };
}
