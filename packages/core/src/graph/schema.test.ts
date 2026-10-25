import type { Driver } from 'neo4j-driver';
import { expect, test } from 'vitest';
import { GraphRepo } from './repo.ts';
import { SCHEMA } from './schema.ts';

const neoError = (code: string) => Object.assign(new Error(`An equivalent index already exists`), { code });

test('a schema rule the other service created at the same moment is not a startup failure', async () => {
  const g = new GraphRepo({} as Driver);
  const ran: string[] = [];
  g.run = async (s: string) => {
    ran.push(s);
    if (s === SCHEMA[1]) throw neoError('Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists');
    return [];
  };
  await expect(g.ensureSchema()).resolves.toBeUndefined();
  expect(ran).toHaveLength(SCHEMA.length);
});

test('map files are found by project and inMap together (the scanner adds many files that are not in the map)', () => {
  expect(SCHEMA).toContain('CREATE INDEX codefile_project_inmap IF NOT EXISTS FOR (n:CodeFile) ON (n.projectKey, n.inMap)');
  expect(SCHEMA).toContain('CREATE INDEX codefile_project_inindex IF NOT EXISTS FOR (n:CodeFile) ON (n.projectKey, n.inIndex)');
});

test('any other schema error still stops startup', async () => {
  const g = new GraphRepo({} as Driver);
  g.run = async () => { throw neoError('Neo.ClientError.Security.Unauthorized'); };
  await expect(g.ensureSchema()).rejects.toThrow();
});
