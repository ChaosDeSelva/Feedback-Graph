import { expect, test } from 'vitest';
import type { FactHit, StoredFact } from './graph/facts.ts';
import { calibrateRelevance, EVERYDAY_SHARE, factOrigin, isNonMiss, pathAffinity, rankFacts, rankMisses, relevanceBand, serviceDirs, servicesInTask, SIMILARITY_FLOOR } from './relevance.ts';

const hit = (statement: string, score: number, relevance: number | null): FactHit => ({
  fact: { id: statement, statement, relevance, relevanceBy: relevance === null ? null : 'model' } as StoredFact,
  score,
});

test('rankFacts weighs similarity by relevance, so an everyday fact beats a slightly closer setup fact', () => {
  const ranked = rankFacts([hit('setup the linter in your editor', 0.79, 0.1), hit('every query is scoped by orgId', 0.78, 0.9)], 5);
  expect(ranked.map((h) => h.fact.statement)).toEqual(['every query is scoped by orgId']);
});

test('rankFacts keeps a low-relevance fact when the task is very close to it (a setup task)', () => {
  const ranked = rankFacts([hit('how to configure the deploy tool', 0.85, 0.1), hit('every query is scoped by orgId', 0.79, 0.9)], 5);
  expect(ranked.map((h) => h.fact.statement).sort()).toEqual(['every query is scoped by orgId', 'how to configure the deploy tool']);
});

test('rankFacts ranks unscored facts as middling, keeps n, and preserves raw similarity', () => {
  const ranked = rankFacts([hit('a', 0.8, null), hit('b', 0.8, 1), hit('c', 0.8, 0.5), hit('d', 0.5, 1)], 2);
  expect(ranked.map((h) => h.fact.statement)).toEqual(['b', 'a']);
  expect(ranked[0].score).toBeCloseTo(0.8);
  expect(ranked[1].score).toBeCloseTo(0.8);
});

test('relevanceBand names the three bands, and unscored', () => {
  expect([0.9, 0.8, 0.5, 0.4, 0.39, 0, null].map(relevanceBand)).toEqual(['everyday', 'everyday', 'sometimes', 'sometimes', 'rare', 'rare', 'unscored']);
});

test('factOrigin: as recorded, else a document by its docId and a manifest fact by its reason', () => {
  expect(factOrigin({ origin: 'manifest', docId: null, why: 'w' })).toBe('manifest');
  expect(factOrigin({ docId: 'doc:demo:upload:a.md', why: 'w' })).toBe('document');
  expect(factOrigin({ docId: null, why: 'Read directly from package.json; no model involved.' })).toBe('manifest');
  expect(factOrigin({ docId: null, why: 'callers rely on it' })).toBe('model');
});

test('the everyday band starts where the rubric says it does (0.8), so a 0.7 "some changes" fact is not everyday', () => {
  expect(relevanceBand(0.8)).toBe('everyday');
  expect(relevanceBand(0.7)).toBe('sometimes');
});

test('isNonMiss spots a post-mortem that concluded there was no miss', () => {
  expect(isNonMiss('The agent did not miss the feedback, as the feedback was directed at a different pull request')).toBe(true);
  expect(isNonMiss("The agent didn't miss anything: the comment was about another file")).toBe(true);
  expect(isNonMiss('No miss: the reviewer was asking a question')).toBe(true);
  expect(isNonMiss('This was not a miss by the agent')).toBe(true);
  expect(isNonMiss('The agent did not update the unit tests for the new route')).toBe(false);
  expect(isNonMiss('The agent missed the tenant check')).toBe(false);
});

test('pathAffinity favours paths in the named files\' folders and service, and disfavours another service', () => {
  const files = ['src/webapp/core/src/features/users/router.ts'];
  expect(pathAffinity('src/webapp/AGENTS.md', files)).toBeGreaterThan(pathAffinity('src/webapp/apps/spa/main.ts', files));
  expect(pathAffinity('src/webapp/apps/spa/main.ts', files)).toBeGreaterThan(1);
  expect(pathAffinity('src/context-graph/service.go', files)).toBeLessThan(1);
  expect(pathAffinity('.', files)).toBe(1);
  expect(pathAffinity('README.md', files)).toBeGreaterThanOrEqual(1);
  expect(pathAffinity('src/context-graph/service.go', [])).toBe(1);
});

test('rankFacts with named files puts the facts of their service first and drops what falls far below the best', () => {
  const at = (statement: string, path: string, score: number): FactHit => ({ fact: { id: statement, statement, path, relevance: 0.8, relevanceBy: 'model' } as StoredFact, score });
  const ranked = rankFacts([
    at('ingest uses sqlc mutations', 'src/ingest/AGENTS.md', 0.86),
    at('confirm the router is wired', 'src/webapp/AGENTS.md', 0.8),
    at('unrelated gateway rule', 'src/llm-gateway/README.md', 0.3),
  ], 5, ['src/webapp/core/src/features/users/router.ts']);
  expect(ranked.map((h) => h.fact.statement)).toEqual(['confirm the router is wired', 'ingest uses sqlc mutations']);
});

test('rankMisses drops non-misses and weak matches, and favours misses that name the named files\' service', () => {
  const m = (missed: string, score: number, feedbackText = '') => ({ missId: missed, missed, feedbackText, score });
  const ranked = rankMisses([
    m('The agent did not miss the feedback, it was about another PR', 0.9),
    m('Missed the exists=true filter in src/context-graph/internal/page.go', 0.86),
    m('Missed the admin gate in src/webapp/core/src/features/settings/usage.ts', 0.8),
    m('Missed a Brotli CVE bump', 0.2),
  ], 4, ['src/webapp/core/src/features/settings/users/router.ts']);
  expect(ranked.map((x) => x.missId)).toEqual([
    'Missed the admin gate in src/webapp/core/src/features/settings/usage.ts',
    'Missed the exists=true filter in src/context-graph/internal/page.go',
  ]);
  expect(rankMisses([m('a', 0.8), m('b', 0.4)], 4, []).map((x) => x.missId)).toEqual(['a']);
});

test('rankFacts applies the same similarity floor as misses: a nonsense task gets no facts at all', () => {
  const ranked = rankFacts([hit('every query is scoped by orgId', 0.22, 0.9), hit('routes live in src/routes', 0.18, 1)], 10);
  expect(ranked).toEqual([]);
  expect(rankFacts([hit('every query is scoped by orgId', SIMILARITY_FLOOR, 0.9)], 10)).toHaveLength(1);
});

test('servicesInTask finds the services a task names by their folder, never a generic folder like src or packages', () => {
  const dirs = serviceDirs(['src/webapp/core/a.ts', 'src/context-graph/internal/page.go', 'billing/api/charge.ts', 'packages/ui/x.tsx', 'README.md']);
  expect(dirs).toEqual(['billing', 'billing/api', 'src/context-graph', 'src/webapp']);
  expect(servicesInTask('add a members page to the webapp settings', dirs)).toEqual(['src/webapp']);
  expect(servicesInTask('Fix the context-graph page offsets', dirs)).toEqual(['src/context-graph']);
  expect(servicesInTask('refund flow in Billing', dirs)).toEqual(['billing']);
  // "src", "packages" and "ui" alone are no service: too short or too generic to name one.
  expect(servicesInTask('move the src helpers into packages', dirs)).toEqual([]);
});

test('with no files named, the services the task names rank their facts and misses up and other services\' down', () => {
  const at = (statement: string, path: string, score: number): FactHit => ({ fact: { id: statement, statement, path, relevance: 0.8, relevanceBy: 'model' } as StoredFact, score });
  const facts = [at('graph pages are byte offsets', 'src/context-graph/AGENTS.md', 0.86), at('settings pages use SettingsState', 'src/webapp/core/settings.ts', 0.82)];
  expect(rankFacts(facts, 5).map((h) => h.fact.id)[0]).toBe('graph pages are byte offsets');
  expect(rankFacts(facts, 5, [], ['src/webapp']).map((h) => h.fact.id)[0]).toBe('settings pages use SettingsState');
  const m = (missed: string, score: number) => ({ missId: missed, missed, feedbackText: '', score });
  const misses = [m('Missed the filter in src/context-graph/internal/page.go', 0.86), m('Missed the admin gate in src/webapp/core/usage.ts', 0.82)];
  expect(rankMisses(misses, 4, [], ['src/webapp'])[0].missId).toMatch(/webapp/);
  // Named files win over words: the services are only a guess.
  expect(rankMisses(misses, 4, ['src/context-graph/internal/x.go'], ['src/webapp'])[0].missId).toMatch(/context-graph/);
});

test('everyday is the minority of a realistic set: a generous model\'s scores are calibrated by kind and by share', () => {
  // As a model scored one shard in 0.6.2: 11 of 16 at 0.8 or more ("62% of facts are everyday").
  const facts = [
    { kind: 'convention', path: '.', statement: 'All database access goes through the repository layer in src/db; route handlers never query directly.', relevance: 0.95 },
    { kind: 'invariant', path: 'src/api/auth.ts', statement: 'Every API route calls requireOrg() so queries are scoped to the caller\'s organisation.', relevance: 0.95 },
    { kind: 'architecture', path: '.', statement: 'The webapp talks to the data pipeline only through the events topic, never its database.', relevance: 0.9 },
    { kind: 'api', path: 'src/api/orders.ts', statement: 'createOrder returns 409 when the cart changed since checkout started.', relevance: 0.85 },
    { kind: 'gotcha', path: 'src/lib/date.ts', statement: 'parseDate treats bare dates as UTC, not local time.', relevance: 0.8 },
    { kind: 'config', path: 'src/config.ts', statement: 'FEATURE_FLAGS_URL defaults to the staging flag service.', relevance: 0.8 },
    { kind: 'data_model', path: 'src/db/schema.ts', statement: 'Orders hold money as integer cents, never floats.', relevance: 0.9 },
    { kind: 'convention', path: 'src/ui/Button.tsx', statement: 'Buttons take the variant prop, not className overrides.', relevance: 0.85 },
    { kind: 'api', path: 'src/api/users.ts', statement: 'GET /users pages with a cursor, not offsets.', relevance: 0.8 },
    { kind: 'security', path: 'src/api/upload.ts', statement: 'Uploaded file names go through safeName before storage.', relevance: 0.85 },
    { kind: 'gotcha', path: 'src/jobs/retry.ts', statement: 'Retries reuse the request id, so handlers must be idempotent.', relevance: 0.6 },
    { kind: 'command', path: 'Makefile', statement: 'make seed loads demo data.', relevance: 0.5 },
    { kind: 'config', path: 'docker-compose.yml', statement: 'Postgres listens on 5433 locally.', relevance: 0.3 },
    { kind: 'api', path: 'src/api/search.ts', statement: 'search() caps results at 50.', relevance: 0.5 },
    { kind: 'convention', path: 'src/lib/log.ts', statement: 'Use log.child per request.', relevance: 0.7 },
    { kind: 'architecture', path: 'src/worker/main.ts', statement: 'The worker polls for jobs every 5 seconds.', relevance: 0.8 },
  ];
  const share = (xs: { relevance?: number | null }[]) => xs.filter((f) => relevanceBand(f.relevance ?? null) === 'everyday').length / xs.length;
  expect(share(facts)).toBeGreaterThan(0.6);
  const out = calibrateRelevance(facts);
  expect(share(out)).toBeLessThanOrEqual(EVERYDAY_SHARE);
  expect(share(out)).toBeLessThan(0.5);
  // What every change needs stays everyday: the layering rule, the org scoping, the module boundary, money as cents.
  expect(out.filter((f) => relevanceBand(f.relevance) === 'everyday').map((f) => f.statement.slice(0, 20))).toEqual([
    'All database access ', 'Every API route call', 'The webapp talks to ', 'Orders hold money as',
  ]);
  // One endpoint's behaviour is needed for some changes, not most: "sometimes", never dropped to rare.
  expect(relevanceBand(out.find((f) => f.statement.startsWith('createOrder'))!.relevance)).toBe('sometimes');
  // Facts under everyday are left as they were, and calibrating again changes nothing.
  expect(out.filter((_, i) => facts[i].relevance < 0.8).map((f) => f.relevance)).toEqual(facts.filter((f) => f.relevance < 0.8).map((f) => f.relevance));
  expect(calibrateRelevance(out)).toEqual(out);
  // Unscored facts stay unscored; a small set keeps its one everyday fact.
  expect(calibrateRelevance([{ kind: 'api', path: 'a.ts', relevance: null }])).toEqual([{ kind: 'api', path: 'a.ts', relevance: null }]);
  expect(calibrateRelevance([{ kind: 'invariant', path: '.', relevance: 0.9 }, { kind: 'api', path: 'a.ts', relevance: 0.5 }]).map((f) => f.relevance)).toEqual([0.9, 0.5]);
});

test('the empirical similarity floor drops facts and misses just below .78', () => {
  expect(rankFacts([hit('irrelevant', 0.779, 1)], 10)).toEqual([]);
  expect(rankMisses([{ missed: 'irrelevant', feedbackText: '', score: 0.779 }], 4)).toEqual([]);
  expect(rankMisses([{ missed: 'relevant', feedbackText: '', score: 0.78 }], 4)).toHaveLength(1);
});


test('an embedder-calibrated floor is explicit and preserves scores; the semantic default stays 0.78', () => {
  const fact = hit('lexical match', 0.2, 1);
  const miss = { missed: 'lexical miss', feedbackText: 'check the migration', score: 0.2 };
  expect(rankFacts([fact], 5)).toEqual([]);
  expect(rankMisses([miss], 5)).toEqual([]);
  expect(rankFacts([fact], 5, [], [], 0.05)[0].score).toBe(0.2);
  expect(rankMisses([miss], 5, [], [], 0.05)[0].score).toBe(0.2);
  expect(rankFacts([hit('below lexical gate', 0.04, 1)], 5, [], [], 0.05)).toEqual([]);
});

test('serves raw similarity separately from the task-weighted score without mutating source hits', () => {
  const original = { fact: { id: 'x', path: 'src/a.ts', relevance: .4 } as never, score: .82 };
  const [ranked] = rankFacts([original], 1);
  expect(ranked.score).toBe(.82);
  expect(ranked.rankingScore).toBeCloseTo(.82 * (.55 + .45 * .4));
  expect(original).not.toHaveProperty('rankingScore');
  const [miss] = rankMisses([{ missed: 'services/billing/src/b.ts omitted validation', feedbackText: '', score: .82 }], 1, ['services/auth/src/a.ts']);
  expect(miss.score).toBe(.82);
  expect(miss.rankingScore).toBeLessThan(.82);
});
