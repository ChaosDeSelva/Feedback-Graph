import neo4j from 'neo4j-driver';
import { expect, test, vi } from 'vitest';
import { markTestsPending } from './codegraph.ts';

test('large TESTS graphs are marked in bounded transactions', async () => {
  const remaining = [250, 250, 73];
  const run = vi.fn(async (_query: string, params: Record<string, unknown>) => {
    expect(neo4j.integer.toNumber(params.limit as ReturnType<typeof neo4j.int>)).toBe(250);
    const marked = remaining.shift() ?? 0;
    return [{ get: (name: string) => name === 'marked' ? neo4j.int(marked) : null }] as never;
  });
  await markTestsPending({ run } as never, 'shop', '2026-11-05T12:00:00.000Z');
  expect(run).toHaveBeenCalledTimes(3);
  for (const [query, params] of run.mock.calls) {
    expect(query).toMatch(/WHERE r\.pendingRemoval IS NULL[\s\S]*WITH r LIMIT \$limit/);
    expect(params).toMatchObject({ key: 'shop', now: '2026-11-05T12:00:00.000Z' });
  }
});
