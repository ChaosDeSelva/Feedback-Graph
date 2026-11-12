import { afterAll, beforeAll, expect, test } from 'vitest';
import { GraphRepo } from './repo.ts';

// GraphConfig holds one node per setting (the embedding model, a re-embed under way), found by id. Two services
// MERGEing it at once on a database with no constraint could make two, and a read then took either.
const url = process.env.NEO4J_TEST_URL ?? 'bolt://127.0.0.1:7688';
let g: GraphRepo;
beforeAll(async () => {
  g = await GraphRepo.connect(url, process.env.NEO4J_TEST_USER ?? 'neo4j', process.env.NEO4J_TEST_PASSWORD ?? 'testpassword');
});
afterAll(async () => {
  await g.run('MATCH (c:GraphConfig) DETACH DELETE c');
  await g.ensureSchema();
  await g.close();
});

test('duplicate GraphConfig nodes are cleaned up at start, the newest kept, and no second one can be made', async () => {
  await g.run('DROP CONSTRAINT graph_config_id IF EXISTS');
  await g.run('MATCH (c:GraphConfig) DETACH DELETE c');
  await g.run(`CREATE (:GraphConfig {id: 'embedding', model: 'old', updatedAt: '2026-01-01T00:00:00.000Z'}),
                      (:GraphConfig {id: 'embedding', model: 'new', updatedAt: '2026-03-01T00:00:00.000Z'}),
                      (:GraphConfig {id: 'embedding', model: 'middle', updatedAt: '2026-02-01T00:00:00.000Z'}),
                      (:GraphConfig {id: 'reembedding', model: 'next'})`);
  await g.ensureSchema();
  const rows = await g.run('MATCH (c:GraphConfig) RETURN c.id AS id, c.model AS model ORDER BY id');
  expect(rows.map((r) => [r.get('id'), r.get('model')])).toEqual([['embedding', 'new'], ['reembedding', 'next']]);
  await expect(g.run(`CREATE (:GraphConfig {id: 'embedding', model: 'again'})`)).rejects.toThrow(/already exists/);
});
