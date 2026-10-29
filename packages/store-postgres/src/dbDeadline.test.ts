import { expect, test, vi } from 'vitest';
import { withStoreDeadline } from '@fb/core';

const server = vi.hoisted(() => ({ timeout: 30000, statements: [] as string[] }));
vi.mock('pg', () => {
  class Client {
    async query(sql: string) {
      server.statements.push(sql);
      const match = /^SET statement_timeout = (\d+)$/.exec(sql);
      if (match) server.timeout = Number(match[1]);
      return { rows: [{ timeout: server.timeout }] };
    }
  }
  class Pool {
    client: Client;
    constructor(options: { Client: new () => Client }) { this.client = new options.Client(); }
    on() {}
    query(sql: string) { return this.client.query(sql); }
    async end() {}
  }
  return { default: { Client, Pool, types: { getTypeParser: () => (value: string) => value } } };
});
import { openDb } from './db.ts';

test('the same pooled client resets a short request timeout before later background work', async () => {
  const db = openDb({ url: 'postgres://unused/test' });
  const request = await withStoreDeadline({ signal: new AbortController().signal, expiresAt: Date.now() + 100 }, () => db.pool.query('SELECT request_work'));
  expect(request.rows[0].timeout).toBeGreaterThan(0);
  expect(request.rows[0].timeout).toBeLessThanOrEqual(100);
  const background = await db.pool.query('SELECT background_work');
  expect(background.rows[0].timeout).toBe(30000);
  expect(server.statements.at(-2)).toBe('SET statement_timeout = 30000');
  await db.pool.end();
});

test('expired requests still cannot query while rollback remains available', async () => {
  const db = openDb({ url: 'postgres://unused/test' });
  await withStoreDeadline({ signal: new AbortController().signal, expiresAt: Date.now() - 1 }, async () => {
    await expect(db.pool.query('UPDATE forbidden')).rejects.toThrow('deadline');
    await expect(db.pool.query('ROLLBACK')).resolves.toBeDefined();
  });
  expect(server.statements).not.toContain('UPDATE forbidden');
  expect(server.statements.at(-1)).toBe('ROLLBACK');
  await db.pool.end();
});
