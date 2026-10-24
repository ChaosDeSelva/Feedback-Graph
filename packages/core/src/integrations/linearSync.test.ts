import { describe, expect, test } from 'vitest';
import { IntegrationError } from './errors.ts';
import { fetchLinearComments, linearViewer, listLinearTeams } from './linear.ts';

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
