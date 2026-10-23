import type { Store } from '@fb/core';
import { expect, test } from 'vitest';
import { openStore } from './open.ts';

const fake = (kind: Store['kind']) => ({ kind }) as Store;

test('openStore opens Neo4j by default with the Neo4j settings', async () => {
  const seen: unknown[] = [];
  const s = await openStore(
    { store: 'neo4j', neo4j: { url: 'bolt://n:7687', user: 'neo4j', password: 'pw' }, postgres: null },
    { neo4j: async (c) => (seen.push(c), fake('neo4j')), postgres: async () => expect.unreachable() },
  );
  expect(s.kind).toBe('neo4j');
  expect(seen).toEqual([{ url: 'bolt://n:7687', user: 'neo4j', password: 'pw' }]);
});

test('openStore opens Postgres with DATABASE_URL when STORE=postgres', async () => {
  const seen: unknown[] = [];
  const s = await openStore(
    { store: 'postgres', neo4j: null, postgres: { url: 'postgres://fg:pw@db/fg' } },
    { neo4j: async () => expect.unreachable(), postgres: async (c) => (seen.push(c), fake('postgres')) },
  );
  expect(s.kind).toBe('postgres');
  expect(seen).toEqual([{ url: 'postgres://fg:pw@db/fg' }]);
});

test('a connection failure never carries the password', async () => {
  const err = await openStore(
    { store: 'postgres', neo4j: null, postgres: { url: 'postgres://fg:hunter2pw@db/fg' } },
    { neo4j: async () => expect.unreachable(), postgres: async () => { throw new Error('connect failed for postgres://fg:hunter2pw@db/fg'); } },
  ).catch((e: Error) => e);
  expect(String(err)).toContain('postgres://fg:***@db/fg');
  expect(String(err)).not.toContain('hunter2pw');
});

test('a connection failure never carries a password given as ?password= either', async () => {
  const url = 'postgres://fg@db:5432/fg?password=hunter2pw';
  const err = await openStore(
    { store: 'postgres', neo4j: null, postgres: { url } },
    { neo4j: async () => expect.unreachable(), postgres: async () => { throw new Error(`connect ECONNREFUSED for ${url}`); } },
  ).catch((e: Error) => e);
  expect(String(err)).toContain('postgres://fg@db:5432/fg?password=***');
  expect(String(err)).not.toContain('hunter2pw');
});
