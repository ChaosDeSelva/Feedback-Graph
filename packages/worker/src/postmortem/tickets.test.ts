import { expect, test } from 'vitest';
import { projectLinkedTickets } from './tickets.ts';

test('a ticket is the project\'s when it holds it, its PRs name it, or it is from a team whose tickets it holds', async () => {
  const asked: unknown[] = [];
  const docs = {
    projectTickets: async (q: { projectKey: string; ids: string[] }) => { asked.push(q); return ['ABC-1']; },
    listDocs: async () => [{ source: 'linear', ref: 'linear:TEAM-9' }, { source: 'github', ref: 'github:o/r#3' }] as never,
  };
  expect(await projectLinkedTickets(docs, 'demo', ['ABC-1', 'TEAM-42', 'OTHER-1', 'GITHUB'])).toEqual(['ABC-1', 'TEAM-42']);
  expect(asked).toEqual([{ projectKey: 'demo', ids: ['ABC-1', 'TEAM-42', 'OTHER-1', 'GITHUB'] }]);
});
