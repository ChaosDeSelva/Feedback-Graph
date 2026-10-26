import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('the scan queue finds a project\'s file requests by project and request time, not by reading every file of it', () => {
  expect(SCHEMA).toContain('CREATE INDEX codefile_project_requested IF NOT EXISTS FOR (n:CodeFile) ON (n.projectKey, n.scanRequestedAt)');
});

test('every label the store looks up by project has an index (or unique constraint) that starts with projectKey', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const looked = new Set([...sources.matchAll(/\(\w+:([A-Z]\w*) \{projectKey:/g)].map((m) => m[1]));
  expect(looked.has('Feedback') && looked.has('ScanJob') && looked.has('Doc')).toBe(true);
  const indexed = new Set(SCHEMA.flatMap((s) => {
    const m = /FOR \(n:(\w+)\) (?:ON \(n\.(\w+)|REQUIRE n\.(\w+))/.exec(s);
    return m && (m[2] ?? m[3]) === 'projectKey' ? [m[1]] : [];
  }));
  expect([...looked].filter((l) => !indexed.has(l)).sort()).toEqual([]);
});

test('any other schema error still stops startup', async () => {
  const g = new GraphRepo({} as Driver);
  g.run = async () => { throw neoError('Neo.ClientError.Security.Unauthorized'); };
  await expect(g.ensureSchema()).rejects.toThrow();
});

test('a run id has one owner: claiming it twice at once still makes one RunOwner node', () => {
  expect(SCHEMA).toContain('CREATE CONSTRAINT run_owner_run IF NOT EXISTS FOR (n:RunOwner) REQUIRE n.run IS UNIQUE');
});
