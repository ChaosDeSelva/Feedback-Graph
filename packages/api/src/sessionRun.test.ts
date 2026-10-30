import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
const repo = { listCandidates: async () => [], stats: async () => [], candidateDetail: async () => null, decide: async () => {} } as unknown as ApiRepo;

test('real session registration needs a run and refuses retagging', async () => {
  const claims: unknown[] = [];
  const app = createApp(repo, { auth: { operator: { token: 'o'.repeat(32), allow: [] } }, sessions: { projects: () => [], inScope: () => true, store: {
    list: async () => ({ sessions: [], next: null }), detail: async () => null, requestRebuild: async () => false,
    claimRun: async (id, run) => { claims.push([id, run]); return id !== 'existing'; },
  } } });
  const send = (id: string, labelled: boolean) => app.request(`/api/sessions/${id}/run`, {
    method: 'POST', headers: { authorization: `Bearer ${'o'.repeat(32)}`, 'x-fg-run-key': 'session-registration-private-key-123456789', 'content-type': 'application/json', ...(labelled && { 'x-fg-run': 'test-1', 'x-fg-sandbox': '1' }) }, body: '{}',
  });
  expect((await send('new-session', false)).status).toBe(400);
  expect(claims).toEqual([]);
  expect((await send('new-session', true)).status).toBe(204);
  expect(claims).toEqual([['new-session', { id: 'test-1', sandbox: true }]]);
  expect((await send('existing', true)).status).toBe(409);
});
