import { fileURLToPath } from 'node:url';
import { execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { expect, test, vi } from 'vitest';

// scripts/loop-replay.ts wipes the store it is given, so a bad option must stop it before it connects: these point it at
// a port nothing listens on, and a run that got as far as connecting would fail with a connection error instead.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });
const script = fileURLToPath(new URL('../../../scripts/loop-replay.ts', import.meta.url));
const PG = 'postgres://fg:fg@127.0.0.1:1/fg_replay_test';
const replay = (...args: string[]) => execResult(process.execPath, [script, ...args], { env: { PATH: process.env.PATH } });

test.each([
  [['--horizon-days', 'abc'], /--horizon-days abc: a number of days above 0, or none/],
  [['--horizon-days', '-3'], /--horizon-days -3/],
  [['--types', 'foo'], /unknown decision type foo/],
  [['--freeze-split', 'x.json', '--heldout-share', 'abc'], /--heldout-share abc: a share from 0 to 1/],
  [['--heldout-share', '0.3'], /--heldout-share goes with --freeze-split/],
  [['--t0', 'yesterday'], /--t0 yesterday is not a time/],
  [['--typo', 'x'], /unknown option --typo/],
])('loop-replay %j refuses before it touches the database', async (extra, message) => {
  const r = await replay('--store', 'postgres', '--url', PG, '--demo', ...extra);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(message);
  expect(r.stderr).not.toMatch(/ECONNREFUSED|cannot open/);
});

test("loop-replay refuses an install's bolt ports: 7687 inside the container, 7689 published by default", async () => {
  for (const url of ['bolt://127.0.0.1', 'bolt://127.0.0.1:7687', 'bolt://127.0.0.1:7689']) {
    const r = await replay('--store', 'neo4j', '--url', url, '--demo');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing bolt port 76(87|89): an install's own Neo4j listens there/);
  }
});
