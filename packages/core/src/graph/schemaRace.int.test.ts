import { afterAll, expect, test } from 'vitest';
import { GraphRepo } from './repo.ts';

// The api and the worker start together and each creates the whole schema. On a new database the two creations of one
// label's rules deadlock in Neo4j, and the loser used to exit ("fatal") and be restarted by Docker.
const url = process.env.NEO4J_TEST_URL ?? 'bolt://127.0.0.1:7688';
const connect = () => GraphRepo.connect(url, process.env.NEO4J_TEST_USER ?? 'neo4j', process.env.NEO4J_TEST_PASSWORD ?? 'testpassword');
const repos: GraphRepo[] = [];
afterAll(async () => {
  // Leave the schema in place for the suites after this one.
  await repos[0]?.ensureSchema();
  await Promise.all(repos.map((r) => r.close()));
});

async function dropSchema(g: GraphRepo) {
  // Until both lists are empty: an index that turns out to back a constraint goes with that constraint.
  for (;;) {
    const constraints = await g.run('SHOW CONSTRAINTS YIELD name');
    const indexes = await g.run("SHOW INDEXES YIELD name, type, owningConstraint WHERE type <> 'LOOKUP' AND owningConstraint IS NULL");
    if (!constraints.length && !indexes.length) return;
    for (const r of constraints) await g.run(`DROP CONSTRAINT \`${r.get('name')}\` IF EXISTS`);
    for (const r of indexes) await g.run(`DROP INDEX \`${r.get('name')}\` IF EXISTS`).catch(() => {});
  }
}

test('two services creating the schema of a new database at once both start', async () => {
  repos.push(await connect(), await connect());
  const [api, worker] = repos;
  for (let round = 0; round < 3; round++) {
    await dropSchema(api);
    await expect(Promise.all([api.ensureSchema(), worker.ensureSchema()])).resolves.toBeDefined();
  }
}, 240_000);
