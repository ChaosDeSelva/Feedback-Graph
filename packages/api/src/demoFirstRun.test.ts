import { expect, test } from 'vitest';
import type { Lesson } from '@fb/core';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';
import { run, type CliIO } from './cli.ts';
import { DEMO_CORPUS, DEMO_PROBE } from './demo.ts';

// The first run with no history (setup.sh --demo): after fg demo seed, two commands show a lesson served and a
// violation caught, through the same MCP tools an agent calls, with no agent session.
const repo = { listCandidates: async () => [], stats: async () => [], decide: async () => {} } as unknown as ApiRepo;
const API = 'api-demo-first-run-token-0123456789abcdef01';
const OP = 'operator-demo-first-run-token-0123456789abc';
const seeded: Lesson[] = DEMO_CORPUS.lessons.map((l) => ({ id: `lesson:demo:${l.slug}`, projectKey: 'demo-shop', origin: 'demo-shop', title: `[demo] ${l.title}`, rule: l.rule, appliesWhen: l.appliesWhen, scope: 'project', paths: l.paths, status: 'approved', source: 'demo', cause: null, missId: null, createdAt: 't', decidedAt: 't' }));
let judged = 0;
const context: ContextDeps = {
  roots: [{ host: '/Users/me/feedback-graph/examples', container: '/projects/examples' }], exists: () => true, embed: async (t) => t.map(() => [1]),
  k: { searchLessons: async () => seeded.map((lesson) => ({ lesson, score: .9 })), relatedMisses: async () => [], missesNaming: async () => [], createManualFeedback: async () => 'f', recordPreDoneCheck: async () => {} },
  judge: async () => { judged++; return []; },
};
const app = createApp(repo, { auth: { token: API, operator: { token: OP, allow: ['demo'] } }, context });
const fg = async (...argv: string[]) => {
  const out: string[] = [], err: string[] = [];
  const io: CliIO = { env: { FG_OPERATOR_TOKEN: OP, FEEDBACK_GRAPH_URL: 'http://localhost:8787' }, out: (l) => { out.push(l); }, err: (l) => { err.push(l); }, sleep: async () => {},
    fetch: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch };
  const code = await run(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('fg demo context shows the lessons an agent is given before editing the demo routes', async () => {
  const r = await fg('demo', 'context');
  expect(r.code).toBe(0);
  expect(r.out).toContain('Routes read data only through db.scoped(orgId)');
  expect(r.out).toContain('No console.log in the isolated probe module');
});

test('fg demo check catches the console.log the seeded lesson forbids, citing the diff line, with no model call', async () => {
  const r = await fg('demo', 'check');
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/1 possible gap/);
  expect(r.out).toContain('No console.log in the isolated probe module');
  expect(r.out).toContain(DEMO_PROBE.diff.split('\n').find((l) => l.startsWith('+console'))!);
  expect(judged).toBe(0);
});

test('fg demo check exits 1 when it checked nothing: another project, or no lesson seeded', async () => {
  const unknown = await fg('demo', 'check', '--project', 'nope');
  expect(unknown.code).toBe(1);
  expect(unknown.err).toMatch(/no gap was found/);
  const saved = context.k.searchLessons;
  context.k.searchLessons = async () => [];
  try {
    const none = await fg('demo', 'check');
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/no gap was found, so the demo showed nothing \(run fg demo seed first\)/);
  } finally { context.k.searchLessons = saved; }
});

test('fg demo with another verb says which ones it takes', async () => {
  const r = await fg('demo', 'show');
  expect(r.code).toBe(2);
  expect(r.err).toMatch(/fg demo seed\|remove\|context\|check/);
});
