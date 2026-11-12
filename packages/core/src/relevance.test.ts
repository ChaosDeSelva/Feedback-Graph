import { expect, test } from 'vitest';
import type { FactHit, StoredFact } from './graph/facts.ts';
import { calibrateRelevance, EVERYDAY_SHARE, factOrigin, isNonMiss, mentionedPaths, MISS_CLOSE, missAdmitted, missTouches, pathAffinity, rankDocs, rankFacts, rankMisses, relevanceBand, serviceDirs, servicesInTask, SIMILARITY_FLOOR } from './relevance.ts';

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
  const files = ['src/portal/main/src/segments/users/router.ts'];
  expect(pathAffinity('src/portal/AGENTS.md', files)).toBeGreaterThan(pathAffinity('src/portal/apps/spa/main.ts', files));
  expect(pathAffinity('src/portal/apps/spa/main.ts', files)).toBeGreaterThan(1);
  expect(pathAffinity('src/catalog-index/service.go', files)).toBeLessThan(1);
  expect(pathAffinity('.', files)).toBe(1);
  expect(pathAffinity('README.md', files)).toBeGreaterThanOrEqual(1);
  expect(pathAffinity('src/catalog-index/service.go', [])).toBe(1);
});

test('rankFacts with named files puts the facts of their service first and drops what falls far below the best', () => {
  const at = (statement: string, path: string, score: number): FactHit => ({ fact: { id: statement, statement, path, relevance: 0.8, relevanceBy: 'model' } as StoredFact, score });
  const ranked = rankFacts([
    at('import uses sqlc mutations', 'src/import/AGENTS.md', 0.86),
    at('confirm the router is wired', 'src/portal/AGENTS.md', 0.8),
    at('unrelated gateway rule', 'src/api-gateway/README.md', 0.3),
  ], 5, ['src/portal/main/src/segments/users/router.ts']);
  expect(ranked.map((h) => h.fact.statement)).toEqual(['confirm the router is wired', 'import uses sqlc mutations']);
});

test('rankMisses drops non-misses and weak matches, and favours misses that name the named files\' service', () => {
  const m = (missed: string, score: number, feedbackText = '') => ({ missId: missed, missed, feedbackText, score });
  const ranked = rankMisses([
    m('The agent did not miss the feedback, it was about another PR', 0.9),
    m('Missed the exists=true filter in src/catalog-index/internal/page.go', 0.86),
    m('Missed the admin gate in src/portal/main/src/segments/settings/usage.ts', 0.8),
    m('Missed a Brotli CVE bump', 0.2),
  ], 4, ['src/portal/main/src/segments/settings/users/router.ts']);
  expect(ranked.map((x) => x.missId)).toEqual([
    'Missed the admin gate in src/portal/main/src/segments/settings/usage.ts',
    'Missed the exists=true filter in src/catalog-index/internal/page.go',
  ]);
  expect(rankMisses([m('a', 0.8), m('b', 0.4)], 4, []).map((x) => x.missId)).toEqual(['a']);
});

test('rankFacts applies the same similarity floor as misses: a nonsense task gets no facts at all', () => {
  const ranked = rankFacts([hit('every query is scoped by orgId', 0.22, 0.9), hit('routes live in src/routes', 0.18, 1)], 10);
  expect(ranked).toEqual([]);
  expect(rankFacts([hit('every query is scoped by orgId', SIMILARITY_FLOOR, 0.9)], 10)).toHaveLength(1);
});

test('servicesInTask finds the services a task names by their folder, never a generic folder like src or packages', () => {
  const dirs = serviceDirs(['src/portal/main/a.ts', 'src/catalog-index/internal/page.go', 'billing/api/charge.ts', 'packages/ui/x.tsx', 'README.md']);
  expect(dirs).toEqual(['billing', 'billing/api', 'src/catalog-index', 'src/portal']);
  expect(servicesInTask('add a members page to the portal settings', dirs)).toEqual(['src/portal']);
  expect(servicesInTask('Fix the catalog-index page offsets', dirs)).toEqual(['src/catalog-index']);
  expect(servicesInTask('refund flow in Billing', dirs)).toEqual(['billing']);
  // "src", "packages" and "ui" alone are no service: too short or too generic to name one.
  expect(servicesInTask('move the src helpers into packages', dirs)).toEqual([]);
});

test('with no files named, the services the task names rank their facts and misses up and other services\' down', () => {
  const at = (statement: string, path: string, score: number): FactHit => ({ fact: { id: statement, statement, path, relevance: 0.8, relevanceBy: 'model' } as StoredFact, score });
  const facts = [at('graph pages are byte offsets', 'src/catalog-index/AGENTS.md', 0.86), at('settings pages use SettingsStore', 'src/portal/main/settings.ts', 0.82)];
  expect(rankFacts(facts, 5).map((h) => h.fact.id)[0]).toBe('graph pages are byte offsets');
  expect(rankFacts(facts, 5, [], ['src/portal']).map((h) => h.fact.id)[0]).toBe('settings pages use SettingsStore');
  const m = (missed: string, score: number) => ({ missId: missed, missed, feedbackText: '', score });
  const misses = [m('Missed the filter in src/catalog-index/internal/page.go', 0.86), m('Missed the admin gate in src/portal/main/usage.ts', 0.82)];
  expect(rankMisses(misses, 4, [], ['src/portal'])[0].missId).toMatch(/portal/);
  // Named files win over words: the services are only a guess.
  expect(rankMisses(misses, 4, ['src/catalog-index/internal/x.go'], ['src/portal'])[0].missId).toMatch(/catalog-index/);
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

test('0.7.6 slashed pieces of a key in a task are not file paths', () => {
  expect(mentionedPaths('the key MIIEvQ/kL9mN2pQ+x7Ab/Zq9 and Ab3d/eF5g leaked, blob aB3cD4/eF5gH6=')).toEqual([]);
  expect(mentionedPaths('deploy with https://admin:[REDACTED]@internal.example.com/x and fix src/a.ts')).toEqual(['src/a.ts']);
  expect(mentionedPaths('fix src/api/orders.ts, src/Components/Button2, apps/web/OAuth2Client.tsx and v1/users/123'))
    .toEqual(['src/api/orders.ts', 'src/Components/Button2', 'apps/web/OAuth2Client.tsx', 'v1/users/123']);
});

test('rankDocs: under the floor is never served; a chunk about a named file outranks a closer one elsewhere', () => {
  const doc = (ref: string, score: number, text = 'notes') => ({ ref, title: ref, text, score });
  expect(rankDocs([doc('guide', 0.779)], 5)).toEqual([]);
  const ranked = rankDocs([doc('ops', 0.9, 'see services/billing/run.sh'), doc('api', 0.84, 'the handler in services/api/orders.ts')], 5, ['services/api/orders.ts']);
  expect(ranked.map((d) => d.ref)).toEqual(['api', 'ops']);
  // the reported score stays the similarity; rankingScore is the weighted one
  expect(ranked[0].score).toBe(0.84);
  expect(ranked[0].rankingScore).toBeGreaterThan(ranked[1].rankingScore);
  // a doc naming no path is neutral
  expect(rankDocs([doc('plain', 0.9)], 5)[0].rankingScore).toBe(0.9);
});

test('rankDocs: services named in the task weigh a chunk without named files; far below the best, n and the rank floor cut', () => {
  const doc = (ref: string, score: number, text: string) => ({ ref, title: ref, text, score });
  const docs = [doc('billing', 0.9, 'billing/src/charge.ts'), doc('web', 0.86, 'webapp/src/page.tsx')];
  expect(rankDocs(docs, 5, [], ['webapp']).map((d) => d.ref)).toEqual(['web', 'billing']);
  expect(rankDocs(docs, 1).map((d) => d.ref)).toEqual(['billing']);
  expect(rankDocs([doc('a', 1, 'x'), doc('b', 0.5, 'y')], 5, [], [], 0.4).map((d) => d.ref)).toEqual(['a']);
  expect(rankDocs([doc('a', 0.85, 'x')], 5, [], [], 0.78, 0.9)).toEqual([]);
  // an out-of-range similarity is clamped
  expect(rankDocs([doc('a', 1.7, 'x')], 5)[0]).toMatchObject({ score: 1, rankingScore: 1 });
});

test('pathAffinity: a named file at the top of the repo (or one folder down) does not count against a path elsewhere', () => {
  expect(pathAffinity('services/api/x.ts', ['README.md'])).toBe(1);
  expect(pathAffinity('services/api/x.ts', ['scripts/run.sh'])).toBe(1);
  expect(pathAffinity('services/api/x.ts', ['web/app/y.ts'])).toBe(0.75);
});

test('factOrigin reads a fact with no reason recorded as the model\'s; a non-finite similarity scores 0', () => {
  expect(factOrigin({})).toBe('model');
  expect(factOrigin({ why: null })).toBe('model');
  expect(rankFacts([hit('everyday', Number.NaN, 0.9)], 5, [], [], 0)[0]).toMatchObject({ score: 0, rankingScore: 0 });
  // an unscored fact counts as middling, not as rare
  expect(rankFacts([hit('unscored', 0.79, null)], 5)).toHaveLength(1);
});

test('missTouches: a miss shares a file with the named ones (the same file, from a subfolder too, or one in its folder)', () => {
  expect(missTouches(['src/db/pool.ts'], ['src/db/pool.ts'])).toBe(true);
  expect(missTouches(['db/pool.ts'], ['src/db/pool.ts'])).toBe(true);
  expect(missTouches(['./src/db/pool.ts'], ['src/db/client.ts'])).toBe(true);
  expect(missTouches(['src/catalog/internal/pricingrules'], ['src/catalog/internal/pricingrules/read.go'])).toBe(true);
  expect(missTouches(['src\\db\\pool.ts'], ['src/db/other.ts'])).toBe(true);
  expect(missTouches(['src/db/pool.ts'], ['src/api/users.ts'])).toBe(false);
  // A folder holding the named file's folder is not the same folder.
  expect(missTouches(['src/db'], ['src/db/sub/x.ts'])).toBe(false);
  expect(missTouches([], ['src/db/pool.ts'])).toBe(false);
});

test(`missAdmitted: a past miss is served or judged when it shares a file with the work or is at least ${MISS_CLOSE} close to it`, () => {
  const m = (missed: string, score: number) => ({ missed, feedbackText: '', score });
  expect(missAdmitted(m('leaked a client in src/db/pool.ts', 0.5), ['src/db/pool.ts'])).toBe(true);
  expect(missAdmitted(m('leaked a client in src/db/pool.ts', 0.84), ['src/api/users.ts'])).toBe(false);
  expect(missAdmitted(m('leaked a client', 0.84), [])).toBe(false);
  expect(missAdmitted(m('leaked a client', MISS_CLOSE), [])).toBe(true);
  // The bar is the caller's to set (MISS_MIN_SIMILARITY).
  expect(missAdmitted(m('leaked a client', 0.8), [], 0.78)).toBe(true);
  expect(MISS_CLOSE).toBeGreaterThan(SIMILARITY_FLOOR);
});
