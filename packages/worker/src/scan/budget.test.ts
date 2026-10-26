import { ProviderUnavailableError, type JsonTask, type LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { extractShardFacts, type ShardTask } from './scan.ts';
import { lowValueBudget, lowValueRule, shardBudget, shardFactBudget } from './shard.ts';

/** An agent answering each call in turn (the last answer repeats), recording what it was asked. */
function agent(...answers: unknown[]) {
  const asked: JsonTask[] = [];
  const llm: LlmProvider = { id: 'claude-cli', agentic: true, json: async (t) => { asked.push(t); return answers[Math.min(asked.length - 1, answers.length - 1)]; } };
  return { llm, asked };
}
const fact = (path: string, statement: string, relevance = 0.6) => ({ kind: 'convention', statement, path, lines: null, why: 'w', relevance });
const files = (dir: string, n: number, name = (i: number) => `f${i}.ts`) => Array.from({ length: n }, (_, i) => ({ path: `${dir}/${name(i)}`, hash: 'h', size: 1 }));
const task = (fs: { path: string; hash: string; size: number }[], root = 'packages/api'): ShardTask => ({ key: root, roots: [root], scope: { prefixes: [root], except: [] }, files: fs });
const range = (system: string) => system.match(/Return (\d+) to (\d+) facts/)!.slice(1).map(Number);

test('tests and fixtures get a reduced budget in code: a sample of them is listed, they count at a small share, and facts beyond it are dropped', async () => {
  const core = files('packages/api/src', 40);
  const tests = files('packages/api/test', 200, (i) => `t${i}.test.ts`);
  const answer = {
    facts: [
      ...core.slice(0, 15).map((f, i) => fact(f.path, `core ${i}`)),
      ...tests.slice(0, 12).map((f, i) => fact(f.path, `test ${i}`, i / 20)),
    ],
    unreached: [],
  };
  const { llm, asked } = agent(answer);
  const r = await extractShardFacts(llm, '/repo', task([...core, ...tests]));
  const budget = shardFactBudget(40, 200);
  expect(budget).toBeLessThan(shardBudget(240));
  expect(range(asked[0].system)[1]).toBe(budget);
  // 0.6.2 listed every test file and asked for facts as if they were source.
  const listedTests = asked[0].user.split('\n').filter((l) => l.startsWith('packages/api/test/'));
  expect(listedTests.length).toBeGreaterThan(0);
  expect(listedTests.length).toBeLessThanOrEqual(20);
  expect(asked[0].user).toMatch(/200 files/);
  const testFacts = r.facts.filter((f) => f.path.startsWith('packages/api/test/'));
  expect(testFacts).toHaveLength(lowValueBudget(200));
  // The most relevant ones are kept, and what the cap hid is said.
  expect(testFacts.map((f) => f.statement).sort()).toEqual(Array.from({ length: lowValueBudget(200) }, (_, i) => `test ${11 - i}`).sort());
  expect(r.hidden).toEqual({ lowValue: 12 - lowValueBudget(200), overBudget: 0 });
});

test('a shard of only archived files gets a small budget and a shorter run', async () => {
  const attic = files('attic/old-api', 300);
  const { llm, asked } = agent({ facts: [], unreached: [] });
  await extractShardFacts(llm, '/repo', task(attic, 'attic'));
  expect(range(asked[0].system)[1]).toBe(lowValueBudget(300));
  expect(asked[0].timeoutMs).toBeLessThan(30 * 60_000);
  const { llm: big, asked: bigAsked } = agent({ facts: Array.from({ length: 12 }, (_, i) => fact('packages/api/src/f0.ts', `s${i}`)), unreached: [] });
  await extractShardFacts(big, '/repo', task(files('packages/api/src', 100)));
  expect(bigAsked[0].timeoutMs).toBe(30 * 60_000);
});

test('real source under an archive- or spec-like name gets the source budget, not the low-value one', async () => {
  const feature = files('src/features/archive', 100);
  const { llm, asked } = agent({ facts: [], unreached: [] });
  await extractShardFacts(llm, '/repo', task(feature, 'src/features/archive'));
  expect(range(asked[0].system)[1]).toBe(shardBudget(100));
  // A library named spec, with its manifest: the shard is told by the whole repo's listing.
  const lib = files('packages/spec/src', 100);
  const { llm: l2, asked: a2 } = agent({ facts: [], unreached: [] });
  await extractShardFacts(l2, '/repo', { ...task(lib, 'packages/spec'), lowValue: lowValueRule(['packages/spec/package.json', ...lib.map((f) => f.path)]) });
  expect(range(a2[0].system)[1]).toBe(shardBudget(100));
});

test('the budget floor is enforced in code: an agent that returns too few facts is asked once more, about the directories short of their minimum', async () => {
  const a = files('packages/api/src/a', 40);
  const b = files('packages/api/src/b', 30);
  const budget = shardBudget(70);
  const first = { facts: a.slice(0, 3).map((f, i) => fact(f.path, `a ${i}`)), unreached: [] };
  const more = { facts: [...b.slice(0, 8).map((f, i) => fact(f.path, `b ${i}`)), fact(a[0].path, 'a 0'), ...a.slice(3, 6).map((f, i) => fact(f.path, `a more ${i}`))], unreached: [] };
  const { llm, asked } = agent(first, more);
  const r = await extractShardFacts(llm, '/repo', task([...a, ...b]));
  expect(asked).toHaveLength(2);
  expect(asked[1].user).toContain('packages/api/src/b');
  expect(asked[1].system).toMatch(/a 0/);
  expect(asked[1].system).toMatch(/at least \d+ more facts/);
  expect(asked[1].user).toMatch(/^## packages\/api\/src\/b \(30 files\): at least \d+ more facts? from here$/m);
  expect(budget).toBeGreaterThan(30);
  // The restated fact is not counted twice.
  expect(r.facts.filter((f) => f.statement === 'a 0')).toHaveLength(1);
  expect(r.facts).toHaveLength(3 + 8 + 3);
  expect(r.toppedUp).toBe(true);

  // Enough facts the first time: one call.
  const { llm: enough, asked: once } = agent({ facts: [...a.slice(0, 10), ...b.slice(0, 10)].map((f, i) => fact(f.path, `s ${i}`)), unreached: [] });
  expect((await extractShardFacts(enough, '/repo', task([...a, ...b]))).toppedUp).toBe(false);
  expect(once).toHaveLength(1);
  // A small shard has no floor: three facts from six files are fine.
  const { llm: small, asked: smallAsked } = agent({ facts: [fact('packages/api/src/f0.ts', 'one')], unreached: [] });
  await extractShardFacts(small, '/repo', task(files('packages/api/src', 6)));
  expect(smallAsked).toHaveLength(1);
});

test('the budget ceiling is enforced in code: the most relevant facts are kept, and how many were cut is said', async () => {
  const fs = files('packages/api/src', 60);
  const budget = shardBudget(60);
  const { llm } = agent({ facts: fs.slice(0, 50).map((f, i) => fact(f.path, `s ${i}`, i / 50)), unreached: [] });
  const r = await extractShardFacts(llm, '/repo', task(fs));
  expect(r.facts).toHaveLength(budget);
  expect(Math.min(...r.facts.map((f) => f.relevance ?? 0))).toBeCloseTo((50 - budget) / 50);
  expect(r.hidden).toEqual({ lowValue: 0, overBudget: 50 - budget });
});

test('a top-up that fails keeps the first pass: its facts are returned, the failure is logged, and the top-up has a short timeout', async () => {
  const a = files('packages/api/src/a', 40);
  const b = files('packages/api/src/b', 30);
  const first = { facts: a.slice(0, 3).map((f, i) => fact(f.path, `a ${i}`)), unreached: ['packages/api/src/b'] };
  const asked: JsonTask[] = [];
  const llm: LlmProvider = {
    id: 'claude-cli', agentic: true,
    json: async (t) => {
      asked.push(t);
      if (asked.length === 1) return first;
      throw new Error('the model timed out after 300s');
    },
  };
  const logged: string[] = [];
  const r = await extractShardFacts(llm, '/repo', task([...a, ...b]), { log: (m) => logged.push(m) });
  expect(asked).toHaveLength(2);
  expect(asked[1].timeoutMs).toBeLessThanOrEqual(10 * 60_000);
  expect(asked[1].timeoutMs).toBeLessThan(asked[0].timeoutMs!);
  expect(r.facts.map((f) => f.statement).sort()).toEqual(['a 0', 'a 1', 'a 2']);
  expect(r.unreached).toEqual(['packages/api/src/b']);
  expect(r.toppedUp).toBe(false);
  expect(logged.join('\n')).toMatch(/top-up.*packages\/api.*timed out/i);

  // Bad JSON twice (askJson's strict retry included) is the same: the first pass stands.
  const bad = agent(first, 'not json at all');
  const r2 = await extractShardFacts(bad.llm, '/repo', task([...a, ...b]));
  expect(r2.facts).toHaveLength(3);
  expect(bad.asked).toHaveLength(3);
});

test('a top-up stopped by the provider being unavailable still stops the scan', async () => {
  const a = files('packages/api/src/a', 40);
  let n = 0;
  const llm: LlmProvider = {
    id: 'claude-cli', agentic: true,
    json: async () => {
      if (n++ === 0) return { facts: [fact(a[0].path, 'a 0')], unreached: [] };
      throw new ProviderUnavailableError('usage limit reached');
    },
  };
  await expect(extractShardFacts(llm, '/repo', task(a))).rejects.toThrow(/usage limit/);
});
