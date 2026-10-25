import { describe, expect, test } from 'vitest';
import { IntegrationError } from './errors.ts';
import { fetchLinearComments, fetchLinearIssues, linearIssueDocChunks, linearViewer, listLinearTeams, ticketIdsIn } from './linear.ts';

function stub(answers: (body: any) => Response) {
  const bodies: any[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    return answers(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

const issue = (id: string, comments: object[], extra: object = {}) => ({
  id,
  identifier: `ENG-${id}`,
  title: `Issue ${id}`,
  url: `https://linear.app/acme/issue/ENG-${id}`,
  branchName: `jo/eng-${id}`,
  comments: { nodes: comments },
  ...extra,
});
const comment = (id: string, createdAt: string, o: object = {}) => ({ id, body: `comment ${id}`, url: `https://linear.app/c/${id}`, createdAt, user: { name: 'Pat', displayName: 'pat' }, botActor: null, ...o });

describe('linearViewer', () => {
  test('returns the name and workspace', async () => {
    const { fetchImpl } = stub(() => Response.json({ data: { viewer: { name: 'Pat', email: 'p@x' }, organization: { name: 'Acme' } } }));
    expect(await linearViewer({ apiKey: 'k', fetchImpl })).toEqual({ name: 'Pat', organization: 'Acme' });
  });

  test('a rejected key is an auth error without the key in it', async () => {
    const { fetchImpl } = stub(() => Response.json({ errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] }, { status: 400 }));
    const err = await linearViewer({ apiKey: 'lin_api_sekrit', fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('lin_api_sekrit');
  });

  test('a rate limit says when it lifts', async () => {
    const reset = Date.now() + 60_000;
    const { fetchImpl } = stub(() => Response.json({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, { headers: { 'x-ratelimit-requests-reset': String(reset) } }));
    const err = await linearViewer({ apiKey: 'k', fetchImpl }).catch((e) => e);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAt).toBe(new Date(reset).toISOString());
  });
});

test('listLinearTeams sorts teams by name', async () => {
  const { fetchImpl } = stub(() => Response.json({ data: { teams: { nodes: [{ id: '2', key: 'WEB', name: 'Web' }, { id: '1', key: 'API', name: 'Api' }] } } }));
  expect((await listLinearTeams({ apiKey: 'k', fetchImpl })).map((t) => t.key)).toEqual(['API', 'WEB']);
});

describe('fetchLinearComments', () => {
  test('pages through the team issues updated since the cursor, keeps people, drops bots and empties, oldest first', async () => {
    const { fetchImpl, bodies } = stub((b) =>
      Response.json({
        data: {
          issues: b.variables.after
            ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue('2', [comment('c3', '2026-10-02T00:00:00Z')])] }
            : {
                pageInfo: { hasNextPage: true, endCursor: 'cur1' },
                nodes: [issue('1', [
                  comment('c2', '2026-10-03T00:00:00Z'),
                  comment('bot', '2026-10-03T00:00:00Z', { user: null, botActor: { name: 'GitHub' } }),
                  comment('empty', '2026-10-03T00:00:00Z', { body: '  ' }),
                ])],
              },
        },
      }),
    );
    const out = await fetchLinearComments({ apiKey: 'k', teamId: 'team-1', since: '2026-10-01T00:00:00Z', fetchImpl });
    expect(out.map((c) => c.id)).toEqual(['c3', 'c2']);
    expect(out[1]).toMatchObject({ author: 'pat', issue: { identifier: 'ENG-1', branch: 'jo/eng-1', title: 'Issue 1' } });
    expect(bodies[0].variables).toEqual({ teamId: 'team-1', since: '2026-10-01T00:00:00Z', after: null });
    expect(bodies[1].variables.after).toBe('cur1');
  });

  test('reads the ticket itself: description, state, priority, labels and assignee', async () => {
    const ticket = {
      description: '## Goal\nPrices are integers in cents.',
      state: { name: 'In Progress' },
      priorityLabel: 'High',
      labels: { nodes: [{ name: 'billing' }, { name: 'bug' }] },
      assignee: { name: 'Jo Smith', displayName: 'jo' },
    };
    const { fetchImpl, bodies } = stub(() =>
      Response.json({
        data: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [issue('1', [comment('c1', '2026-10-02T00:00:00Z')], ticket), issue('2', [comment('c2', '2026-10-03T00:00:00Z')], { description: null, state: null, priorityLabel: null, labels: null, assignee: null })],
          },
        },
      }),
    );
    const [one, two] = await fetchLinearComments({ apiKey: 'k', teamId: 'team-1', since: '2026-10-01T00:00:00Z', fetchImpl });
    expect(one.issue).toMatchObject({ description: '## Goal\nPrices are integers in cents.', state: 'In Progress', priority: 'High', labels: ['billing', 'bug'], assignee: 'jo' });
    expect(two.issue).toMatchObject({ description: '', state: null, priority: null, labels: [], assignee: null });
    expect(bodies[0].query).toMatch(/description/);
    expect(bodies[0].query).toMatch(/priorityLabel/);
    expect(bodies[0].query).toMatch(/assignee \{/);
  });
});

describe('fetchLinearIssues', () => {
  test("one query per page reads each issue with its people's comments, issues without comments too", async () => {
    const { fetchImpl, bodies } = stub((b) =>
      Response.json({
        data: {
          issues: b.variables.after
            ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue('2', [], { updatedAt: '2026-10-04T00:00:00Z' })] }
            : {
                pageInfo: { hasNextPage: true, endCursor: 'cur1' },
                nodes: [issue('1', [comment('c1', '2026-10-03T00:00:00Z'), comment('bot', '2026-10-03T00:00:00Z', { user: null, botActor: { name: 'GitHub' } })], { updatedAt: '2026-10-03T00:00:00Z', state: { name: 'Todo' }, labels: { nodes: [{ name: 'bug' }] } })],
              },
        },
      }),
    );
    const out = await fetchLinearIssues({ apiKey: 'k', teamId: 'team-1', since: '2026-10-01T00:00:00Z', fetchImpl });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].query).toMatch(/updatedAt/);
    expect(out.map((i) => i.identifier)).toEqual(['ENG-1', 'ENG-2']);
    expect(out[0]).toMatchObject({ title: 'Issue 1', url: 'https://linear.app/acme/issue/ENG-1', state: 'Todo', labels: ['bug'], updatedAt: '2026-10-03T00:00:00Z' });
    expect(out[0].comments.map((c) => c.id)).toEqual(['c1']);
    expect(out[1].comments).toEqual([]);
  });
});

describe('linearIssueDocChunks', () => {
  const base = {
    id: 'i1', identifier: 'ENG-7', title: 'Keep cents', url: 'https://linear.app/acme/issue/ENG-7', branch: 'jo/eng-7-keep-cents', description: 'Prices are integers in cents.',
    state: 'In Progress', priority: 'High', labels: ['billing'], assignee: 'jo', updatedAt: '2026-10-03T00:00:00Z',
  };

  test('the ticket, then its comments, each chunk naming the ticket', () => {
    const chunks = linearIssueDocChunks({ ...base, comments: [{ id: 'c1', author: 'pat', body: 'Totals must round half up.', url: 'u', createdAt: '2026-10-03T00:00:00Z' }] });
    expect(chunks[0]).toMatch(/^Linear ENG-7 \(In Progress, High, billing\): Keep cents\n/);
    expect(chunks[0]).toContain('Prices are integers in cents.');
    expect(chunks[1]).toBe('comment by pat on Linear ENG-7 (Keep cents):\nTotals must round half up.');
  });

  test('a long description is capped, and at most 30 comments are kept, the latest', () => {
    const comments = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, author: 'pat', body: `note ${i}`, url: 'u', createdAt: `2026-10-03T00:${String(i).padStart(2, '0')}:00Z` }));
    const chunks = linearIssueDocChunks({ ...base, description: 'x'.repeat(9000), comments });
    expect(chunks[0].length).toBeLessThanOrEqual(4000);
    expect(chunks).toHaveLength(31);
    expect(chunks.at(-1)).toContain('note 39');
    expect(chunks[1]).toContain('note 10');
  });
});

describe('ticketIdsIn', () => {
  test('finds Linear identifiers in a PR title, body and branch, upper-cased and deduplicated', () => {
    expect(ticketIdsIn('Keep cents (ENG-12)', 'Fixes ENG-12 and web-7.\nSee https://linear.app/acme/issue/OPS-3/x', 'jo/eng-45-keep-cents')).toEqual(['ENG-12', 'WEB-7', 'OPS-3', 'ENG-45']);
  });

  test('anything shaped like an identifier is listed: a link needs a stored Linear issue with it, so UTF-8 links nothing', () => {
    expect(ticketIdsIn('Bump to UTF-8 output')).toEqual(['UTF-8']);
    expect(ticketIdsIn('2026-10-25 release', 'v1-2', 'a-1')).toEqual([]);
  });

  test('at most 20', () => {
    expect(ticketIdsIn(Array.from({ length: 30 }, (_, i) => `ENG-${i}`).join(' '))).toHaveLength(20);
  });
});
