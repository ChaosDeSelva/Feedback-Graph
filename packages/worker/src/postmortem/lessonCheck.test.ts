import type { HumanTurn, PostMortem } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { checkLesson, recheckLesson } from './lessonCheck.ts';

const lesson = (rule: string, extra: Partial<PostMortem['lesson']> = {}): PostMortem['lesson'] => ({
  title: 'T', rule, appliesWhen: 'changing customer search', scope: 'project', paths: [], ...extra,
});
const feedback = (text: string, ext: Partial<NonNullable<HumanTurn['external']>> | null = null): HumanTurn => ({
  uuid: 'c1', sessionId: 's', ts: '2026-10-02T10:00:00Z', index: 1, text, precedingAssistantText: '', precedingToolCalls: [],
  ...(ext ? {
    external: {
      source: 'github', kind: 'review_comment', author: 'lead', url: 'u', thread: 'acme/demo#9', title: 't', threadUrl: 'u', path: null, line: null,
      diffHunk: null, branch: null, createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: [], ...ext,
    },
  } : {}),
});

test('a scoped, concrete lesson passes untouched', () => {
  const l = lesson('Filter customer search rows in the SQL query in api/search.ts, not in memory', { paths: ['api/search.ts'] });
  expect(checkLesson(l, feedback('filtering in memory will not scale, do it in SQL'))).toEqual({ lesson: l, flags: [] });
});

test('a path outside the repository (a home-folder file) is dropped and flagged', () => {
  const r = checkLesson(lesson('Reload settings after writing them', { paths: ['~/.config/acme/settings.json', 'src/settings.ts'] }), feedback('settings did not reload'));
  expect(r.lesson.paths).toEqual(['src/settings.ts']);
  expect(r.flags.map((f) => f.name)).toEqual(['non-repo-path']);
});

test('a universal rule drawn from one nit is narrowed to the task and flagged', () => {
  const nit = checkLesson(lesson('Always treat documentation nitpicks from reviewers as mandatory requirements'), feedback('nit: the README example is out of date', {}));
  expect(nit.lesson.scope).toBe('task');
  expect(nit.flags.map((f) => f.name)).toEqual(['universal-from-nit', 'meta-lesson', 'generic']);
});

test('an APPROVED review is not a nit: a universal rule from it is kept as it is', () => {
  const approved = checkLesson(lesson('Never leave a TODO in any file', { scope: 'global' }), feedback('one LOW: a stray TODO', { reviewState: 'APPROVED' }));
  expect(approved.lesson.scope).toBe('global');
  expect(approved.flags.map((f) => f.name)).not.toContain('universal-from-nit');
  // A nit marker in an approving review is still a nit.
  const nit = checkLesson(lesson('Never leave a TODO in any file', { scope: 'global' }), feedback('nit: a stray TODO', { reviewState: 'APPROVED' }));
  expect(nit.flags.map((f) => f.name)).toContain('universal-from-nit');
});

test('a universal rule from real pushback is kept', () => {
  const r = checkLesson(lesson('Always run the migration test before calling a schema change done'), feedback("you didn't run the migrations, prod is broken"));
  expect(r.flags).toEqual([]);
  expect(r.lesson.scope).toBe('project');
});

test('a lesson about how to treat feedback rather than the work is flagged, not changed', () => {
  const r = checkLesson(lesson('Ignore unrelated feedback on pull requests'), feedback('this is wrong', {}));
  expect(r.flags.map((f) => f.name)).toEqual(['meta-lesson']);
  expect(r.lesson.scope).toBe('project');
});

test('a severity label (LOW) or the word "typo" in a review is not a nit; nit markers at the start or in a tag are', () => {
  const rule = 'Always lock the target row before an insert conditioned on its status in orders/claim.sql';
  for (const text of ['LOW severity, real gap, address before merge: the insert races the status check', 'the typo check in lint passes, but the insert races the status check']) {
    expect(checkLesson(lesson(rule), feedback(text, {})).flags, text).toEqual([]);
  }
  for (const text of ['nit: rename this', 'Minor: the comment is stale', '**nit** extra blank line', '(optional) could be a const', 'Non-blocking, but the name is odd']) {
    expect(checkLesson(lesson(rule), feedback(text, {})).flags.map((f) => f.name), text).toEqual(['universal-from-nit']);
  }
});

test('meta-lessons phrased as relevance, scope or "pertains" are flagged too', () => {
  for (const rule of [
    'Verify that feedback is relevant to the current task before acting on it',
    'Strictly filter review comments to the current PR scope',
    'Check whether a comment pertains to the feature you are working on',
    'Consult detailed PR review comments before pushing',
    'Incorporate optional nitpicks from reviewers',
  ]) expect(checkLesson(lesson(rule), feedback('this is wrong', {})).flags.map((f) => f.name), rule).toContain('meta-lesson');
});

test('a platitude with nothing from the code in it is flagged; the same verb with an identifier is not', () => {
  expect(checkLesson(lesson('Always verify concurrent state interactions.'), feedback('handleRemoveAccount resends the cached list')).flags.map((f) => f.name)).toEqual(['platitude']);
  expect(checkLesson(lesson('Always verify that handleRemoveAccount does not resend the cached vendorAccountIds list'), feedback('it resends the list')).flags).toEqual([]);
});

test('a platitude in the title is read too, and assume / prioritize / cross-reference / maintain / monitor are platitude verbs', () => {
  const names = (rule: string, title = 'T') => checkLesson(lesson(rule, { title }), feedback('the list is stale')).flags.map((f) => f.name);
  // Vague: the platitude shape, or generic, which stands in for it when the rule names nothing at all.
  const vague = (rule: string, title = 'T') => names(rule, title).some((n) => n === 'platitude' || n === 'generic');
  expect(vague('Check the state carefully.', 'Always verify state changes')).toBe(true);
  for (const rule of [
    'Never assume the data is fresh.',
    'Always prioritize correctness over speed.',
    'Always cross-reference related changes.',
    'Always maintain consistency across the codebase.',
    'Always monitor for regressions after a change.',
  ]) expect(vague(rule), rule).toBe(true);
  // The same verbs naming something in the code are a rule.
  expect(names('Never assume listOrders returns rows sorted; sort by created_at in api/orders.ts')).not.toContain('platitude');
  expect(names('Read the totals from billing/invoice.ts', 'Always cross-reference the invoice totals')).not.toContain('platitude');
});

// Realistic lesson rules: the ones a post-mortem model writes when the "lesson" is really how the code is.
const FACT_LIKE = [
  'Feature flags are configured in config/flags.ts.',
  'The build uses Vite with the React plugin.',
  'Endpoints live under api/v2/routes.',
  'Remember that the payment service reads its keys from services/payments/.env.',
  'Be aware that migrations run before the server starts in docker-entrypoint.sh.',
  'Authentication is handled in middleware/auth.ts, not in the route handlers.',
  'The worker and the API share one Postgres database through packages/store-postgres.',
  'Keep in mind that the session cookie is set by the gateway (gateway/session.go), so the web app never sees it.',
];
const RULE_LIKE = [
  'Add new endpoints under api/v2/routes, not api/v1.',
  'When changing the build config, ensure vite.config.ts and the tsconfig paths stay in sync.',
  'Run pnpm typecheck before calling a TypeScript change done.',
  'If a migration renames a column, update the Neo4j repo in packages/core/src/graph too.',
  'Configure feature flags in config/flags.ts rather than in env files.',
  'Prefer the shared Modal component in ui/components over a new dialog.',
  'Never hardcode the API base URL; read it from config/env.ts.',
  'Route handlers in api/ must return JSON errors, not HTML pages.',
];

test('statements that describe the code are flagged as looking like a fact; rules that say what to do are not', () => {
  const factLike = (rule: string) => checkLesson(lesson(rule), feedback('this is wrong')).flags.some((f) => f.name === 'looks-like-a-fact');
  for (const rule of FACT_LIKE) expect(factLike(rule), rule).toBe(true);
  for (const rule of RULE_LIKE) expect(factLike(rule), rule).toBe(false);
});

/** Rules of the kind a team approves, each starting with an imperative the first verb list did not have. */
const TEAM_RULES = [
  'Cap the batch at 500 rows in worker/sync.ts; larger batches time out.',
  'Refresh the access token in auth/session.ts before it expires, not after a 401.',
  'Derive the tenant id from the request context in api/tenant.ts; the body is untrusted.',
  'Coalesce null counts to 0 in reports/totals.sql, since the chart reads them as numbers.',
  'Reuse the shared retry helper in lib/retry.ts instead of a new loop.',
  'Drop the cached map in codegraph/cache.ts when the HEAD changes.',
  'Keep the migration numbers contiguous in db/migrations.',
  'Pass the abort signal through to fetchAll in api/client.ts.',
  'Carry the run id on every Activity entry the import writes.',
  'Fix the off-by-one in pager.ts at the source, not in the caller.',
  'Debounce search input in ui/Search.tsx; each keystroke hits the API.',
  'Batch the inserts in store/bulk.ts so a big import is one round trip.',
  'Bump LESSON_CHECKS_VERSION when a check changes, so stored flags are recomputed.',
  'Only cap the page size in api/list.ts, never the total that is reported.',
  'Memoize the selector in ui/state.ts; it is called on every render.',
  'Strip the trailing slash from the base URL in config/env.ts.',
  'Invalidate the project cache when a folder is selected.',
  'Gate the admin routes behind OWNER_ROUTES in api/app.ts.',
  'Emit one Activity entry per project, not one per item.',
  'Prefix temp tables with tmp_ in db/etl.sql so cleanup finds them.',
  'In api/search.ts cap the result set at 100 rows.',
];

test("a rule that starts with an imperative is a rule, not a fact (the team's kind of rules)", () => {
  const factLike = (rule: string) => checkLesson(lesson(rule), feedback('this is wrong')).flags.some((f) => f.name === 'looks-like-a-fact');
  for (const rule of TEAM_RULES) expect(factLike(rule), rule).toBe(false);
  // Still facts: a statement whose subject is a thing, though its verb is one a rule could start with.
  for (const rule of ['The poller caps each batch at 500 rows.', 'The session cache is refreshed every ten minutes.', 'Drops in the mirror are rare and logged by sync/mirror.ts.']) {
    expect(factLike(rule), rule).toBe(true);
  }
});

test('a rule field holding the scope word takes the title as the rule and is flagged', () => {
  const r = checkLesson(lesson('task', { title: 'Assert the timezone offset, not its name, in session tests' }), feedback('this fails in CI'));
  expect(r.lesson.rule).toBe('Assert the timezone offset, not its name, in session tests');
  expect(r.flags.map((f) => f.name)).toEqual(['broken-rule']);
});

test('a statement about the codebase with nothing to do is flagged as looking like a fact', () => {
  const r = checkLesson(lesson('The app_frontend.organizations mirror lags fifteen minutes behind the source table.'), feedback('the mirror lags'));
  expect(r.flags.map((f) => f.name)).toEqual(['looks-like-a-fact']);
  expect(checkLesson(lesson('Read organizations from the source table, not the mirror, because the mirror lags fifteen minutes'), feedback('the mirror lags')).flags).toEqual([]);
  // The model can say so itself.
  expect(checkLesson(lesson('Read from the source table in sync/orgs.ts, not the mirror'), feedback('x'), { factLike: true }).flags.map((f) => f.name)).toEqual(['looks-like-a-fact']);
});

test('a comment that is only an approval, a status table or an echo is flagged as not pushback', () => {
  const rule = 'Lock the target row before an insert conditioned on its status in orders/claim.sql';
  for (const text of ['Approving - details inline', 'LGTM, one thing inline', 'We reached the same conclusions as the first reviewer.', '| finding | status |\n|---|---|\n| race | fixed |\n| naming | resolved |']) {
    expect(checkLesson(lesson(rule), feedback(text, {})).flags.map((f) => f.name), text).toEqual(['not-pushback']);
  }
});

test('the model saying the lesson is about process, or an agent reviewing its own PR, is flagged', () => {
  const rule = 'Lock the target row before an insert conditioned on its status in orders/claim.sql';
  expect(checkLesson(lesson(rule), feedback('x'), { about: 'process' }).flags.map((f) => f.name)).toEqual(['meta-lesson']);
  const self = checkLesson(lesson(rule), feedback('[claude] the insert races the check', { author: 'dev', threadAuthor: 'dev', authorKind: 'agent' }));
  expect(self.flags.map((f) => f.name)).toEqual(['self-review']);
});

test('a re-check of a stored lesson only flags: it never changes the lesson', () => {
  const stored = lesson('Always treat documentation nitpicks as mandatory', { paths: ['src/webapp/AGENTS.md', 'acme/shop#12', 'handleUpload', 'src/upload.ts'] });
  const flags = recheckLesson(stored, 'nit: the README example is out of date');
  expect(flags.map((f) => f.name)).toEqual(['bad-path', 'universal-from-nit', 'meta-lesson', 'generic']);
  expect(flags[0].why).toContain('src/webapp/AGENTS.md');
  expect(flags[0].why).not.toContain('src/upload.ts');
});

describe('generic: a rule that names nothing concrete, built from process verbs', () => {
  const generic = (rule: string) => checkLesson(lesson(rule), feedback('this broke the upload flow')).flags.filter((f) => f.name === 'generic');
  test.each([
    'Check for existing patterns',
    'Always check for existing patterns in the codebase before implementing new functionality to ensure consistency.',
    'Consult PR review comments',
    'Prioritize stylistic feedback',
    'Follow explicit instructions',
    'Treat doc nitpicks as mandatory',
    'Always profile',
    'Test concurrency edge cases',
    'Verify the full sequence',
    'Make sure to test all edge cases thoroughly before marking the task as complete.',
  ])('flagged: %s', (rule) => {
    const flags = generic(rule);
    expect(flags).toHaveLength(1);
    expect(flags[0].why).toMatch(/names no file, function, value or command/);
  });

  test.each([
    'Remove must not resend the cached vendorAccountIds list',
    'Derive the lookup ctx from the request deadline, not a pre-made 500 ms ctx',
    'A CONCURRENTLY index migration must drop an INVALID index before retrying',
    'Close the database connection before returning from the upload handler',
    'Run pnpm -r typecheck after changing a shared type',
    'Filter customer search rows in the SQL query in api/search.ts, not in memory',
  ])('not flagged: %s', (rule) => {
    expect(generic(rule)).toEqual([]);
  });

  test('it replaces the narrower platitude flag, and the recheck flags a stored generic lesson too', () => {
    const names = checkLesson(lesson('Always verify the full sequence'), feedback('x')).flags.map((f) => f.name);
    expect(names).toContain('generic');
    expect(names).not.toContain('platitude');
    expect(recheckLesson(lesson('Verify the full sequence'), '').map((f) => f.name)).toContain('generic');
  });
});

describe('bundled: two unrelated misses in one lesson', () => {
  const bundled = (rule: string) => checkLesson(lesson(rule), feedback('two things here')).flags.filter((f) => f.name === 'bundled');
  test.each([
    'Pass the request deadline to lookupVendor in vendor/client.go; also rename the retry flag in cmd/sync/main.go',
    'Escape the CSV header in export/csv.ts. Also, add the missing index in migrations/0042_orders.sql',
    'Use toJson for jsonb parameters in store/orders.ts; validate the upload size in web/upload.ts',
    'Retry the S3 upload on a 503; also rename fetchRows to loadRows',
  ])('flagged: %s', (rule) => {
    const flags = bundled(rule);
    expect(flags).toHaveLength(1);
    expect(flags[0].why).toMatch(/split/);
  });

  test.each([
    'Use toJson for jsonb parameters; never pass JSON.stringify output',
    'Drop the INVALID index before retrying; otherwise the CONCURRENTLY build fails again',
    'Validate the upload size in web/upload.ts and return 413 from web/upload.ts',
    'Read the deadline from ctx in vendor/client.go; pass it to lookupVendor in vendor/client.go',
    'Filter customer search rows in the SQL query in api/search.ts, not in memory',
  ])('not flagged: %s', (rule) => {
    expect(bundled(rule)).toEqual([]);
  });
});
