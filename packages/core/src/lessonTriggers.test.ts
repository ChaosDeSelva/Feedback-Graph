import { describe, expect, test } from 'vitest';
import { pathMatches } from './codegraph.ts';
import {
  addedLines, compilePattern, deriveTriggers, hitRank, KIND_ONLY_K, mergeTriggers, servedTriggered, diffFiles, emptyTriggers, genericTrigger, hasTriggers, matchTriggers, MAX_TRIGGER_CHARS, MAX_TRIGGERS,
  PATH_SHARE_MAX, shapedTriggers, triggered, triggerShapeProblem, triggerWhy, validateTriggers,
} from './lessonTriggers.ts';

const DIFF = [
  'diff --git a/db/migrations/0042_edge.sql b/db/migrations/0042_edge.sql',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/db/migrations/0042_edge.sql',
  '@@ -0,0 +1,2 @@',
  '+ALTER TABLE graph_edge ADD COLUMN departed_at timestamptz;',
  '+CREATE INDEX CONCURRENTLY graph_edge_departed ON graph_edge (departed_at);',
  'diff --git a/src/sync/storage.py b/src/sync/storage.py',
  '--- a/src/sync/storage.py',
  '+++ b/src/sync/storage.py',
  '@@ -1,3 +1,3 @@',
  ' import asyncio',
  '-    batch.commit()',
  '+    await asyncio.to_thread(batch.commit)',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
].join('\n');

describe('the shape of a trigger', () => {
  test('the compiled patterns and symbols are a bounded cache', () => {
    for (let i = 0; i < 5003; i++) compilePattern(`p${i}`);
    expect(compilePattern('p1')!.test('P1')).toBe(true);
    const many = { paths: [], patterns: [], symbols: Array.from({ length: 5003 }, (_, i) => `NAME_${i}`) };
    expect(matchTriggers(many, { files: [], text: 'NAME_5002' })).toEqual({ kind: 'symbol', trigger: 'NAME_5002', on: null });
  });

  test('a pattern compiles case-insensitively, once; an invalid one is null', () => {
    expect(compilePattern('create\\s+index')!.test('CREATE INDEX x')).toBe(true);
    expect(compilePattern('create\\s+index')).toBe(compilePattern('create\\s+index'));
    expect(compilePattern('([')).toBeNull();
    expect(compilePattern('([')).toBeNull();
  });

  test('what the owner may write: no empty, over-long, uncompilable, slow or match-everything pattern, no phrase, no path out of the repo', () => {
    expect(triggerShapeProblem('pattern', '  ')).toBe('empty');
    expect(triggerShapeProblem('symbol', 'x'.repeat(MAX_TRIGGER_CHARS + 1))).toMatch(/longer than/);
    expect(triggerShapeProblem('pattern', '([')).toBe('not a valid regular expression');
    expect(triggerShapeProblem('pattern', '(?<=a)b')).toMatch(/not supported in a trigger \(a lookaround\)/);
    expect(triggerShapeProblem('pattern', '(a)\\1')).toMatch(/not supported in a trigger \(a backreference\)/);
    // Legacy octal escapes JavaScript reads by rules of its own (`\00` is NUL, `[\1]` is U+0001): refused, not misread.
    for (const p of ['\\00', '\\01x', '[\\1]', '[\\8]', 'a[^\\7]']) expect(triggerShapeProblem('pattern', p)).toMatch(/a legacy octal escape/);
    expect(triggerShapeProblem('pattern', 'a\\0b')).toBeNull();
    expect(triggerShapeProblem('pattern', '((a{40}){40}){40}')).toMatch(/too complex/);
    expect(triggerShapeProblem('path', `src/${'*a'.repeat(7)}`)).toMatch(/more than 6 wildcards/);
    expect(triggerShapeProblem('path', `${'**/'.repeat(12)}x`)).toBeNull();
    expect(triggerShapeProblem('pattern', 'x*')).toMatch(/empty line/);
    expect(triggerShapeProblem('pattern', 'CREATE\\s+INDEX')).toBeNull();
    expect(triggerShapeProblem('symbol', 'two words')).toMatch(/one name/);
    expect(triggerShapeProblem('symbol', 'asyncio.to_thread')).toBeNull();
    expect(triggerShapeProblem('path', '/etc/passwd')).toMatch(/not a repository path/);
    expect(triggerShapeProblem('path', '../up/x.ts')).toMatch(/not a repository path/);
    expect(triggerShapeProblem('path', 'https://x.test/a')).toMatch(/not a repository path/);
    expect(triggerShapeProblem('path', '**/*.sql')).toBeNull();
  });

  test('an everyday word, ordinary code, a glob for every file or for most of the repository is generic', () => {
    expect(genericTrigger('symbol', 'id')).toMatch(/too short/);
    expect(genericTrigger('symbol', 'Query')).toMatch(/everyday word/);
    expect(genericTrigger('symbol', 'EXPORT_ENABLED_TEAM_IDS')).toBeNull();
    // A word from the feedback is not a name from the code, however rare; a name has the shape of one.
    for (const word of ['Exports', 'enabled', 'order-card']) expect(genericTrigger('symbol', word)).toBe('a word, not a name from the code');
    for (const name of ['asyncio.to_thread', 'FlushBatch', 'db.$primary', '${label}', 'claude-opus-5-5', '--dry-run', 'parse()']) expect(genericTrigger('symbol', name)).toBeNull();
    for (const prose of ['.*log.*response.*body', 'count query', '6017', 'gh\\s+pr\\s+list']) expect(genericTrigger('pattern', prose)).toBe('only words, no name from the code');
    for (const code of ['EXPLAIN\\s*\\(ANALYZE', '-p=1', 'read\\(ids=', 'Read/Write', 'time\\.sleep']) expect(genericTrigger('pattern', code)).toBeNull();
    expect(genericTrigger('pattern', '\\bindex\\b')).toMatch(/ordinary code \("index"\)/);
    expect(genericTrigger('pattern', 'await')).toMatch(/ordinary code/);
    expect(genericTrigger('pattern', 'CREATE\\s+(UNIQUE\\s+)?INDEX')).toBeNull();
    expect(genericTrigger('pattern', '([')).toBe('not a valid regular expression');
    expect(genericTrigger('path', '**/*')).toBe('a glob for every file');
    expect(genericTrigger('path', '**')).toBe('a glob for every file');
    const repo = [...Array.from({ length: 80 }, (_, i) => `src/m${i}.ts`), ...Array.from({ length: 20 }, (_, i) => `db/q${i}.sql`)];
    expect(genericTrigger('path', '**/*.ts', repo)).toMatch(/80% of the repository's files/);
    expect(genericTrigger('path', 'db/**', repo)).toBeNull();
    // Too few files to judge breadth by share.
    expect(genericTrigger('path', '**/*.ts', repo.slice(0, 10))).toBeNull();
    expect(PATH_SHARE_MAX).toBeLessThan(1);
  });
});

describe('validateTriggers keeps what matches the miss and names something specific', () => {
  const ev = { files: ['db/migrations/0040_user.sql', 'src/api/users.ts'], text: 'The user lookup query changed:\n```\nCREATE INDEX users_org ON users (org_id);\n```\nUse asyncio.to_thread for the batch.' };

  test('each kind against its own evidence', () => {
    const r = validateTriggers({
      paths: ['db/migrations/**/*.sql', 'docs/**', './src/api/'],
      patterns: ['CREATE\\s+INDEX', 'DROP\\s+TABLE'],
      symbols: ['asyncio.to_thread', 'to_threads', 'index'],
    }, ev);
    expect(r.triggers).toEqual({ paths: ['db/migrations/**/*.sql', 'src/api'], patterns: ['CREATE\\s+INDEX'], symbols: ['asyncio.to_thread'] });
    expect(r.dropped).toEqual([
      { kind: 'path', value: 'docs/**', why: 'matches none of the files of the miss' },
      { kind: 'pattern', value: 'DROP\\s+TABLE', why: 'matches no line of the miss' },
      { kind: 'symbol', value: 'to_threads', why: 'not named in the miss' },
      { kind: 'symbol', value: 'index', why: 'an everyday word, not a name' },
    ]);
  });

  test('a pattern written as the code itself is kept as that literal text', () => {
    const r = validateTriggers({ patterns: ['MESSAGES[reason].one', 'parse(x'] }, { files: [], text: 'MESSAGES[reason].one throws; so does parse(x' });
    expect(r.triggers.patterns).toEqual(['MESSAGES\\[reason\\]\\.one', 'parse\\(x']);
    expect(matchTriggers(r.triggers, { files: [], added: [{ path: 'a.ts', text: 'return MESSAGES[reason].one;' }] })?.trigger).toBe('MESSAGES\\[reason\\]\\.one');
  });

  test('nothing proposed, a list missing, a value that is not a string or repeated: none, and nothing dropped', () => {
    expect(validateTriggers(null, ev)).toEqual({ triggers: emptyTriggers(), dropped: [] });
    expect(validateTriggers({ symbols: ['asyncio.to_thread', 'asyncio.to_thread', 7 as unknown as string, ' '] }, ev).triggers).toEqual({ paths: [], patterns: [], symbols: ['asyncio.to_thread'] });
  });

  test('a path that cannot be a repository path is dropped as written', () => {
    expect(validateTriggers({ paths: ['/etc/hosts'] }, ev).dropped).toEqual([{ kind: 'path', value: '/etc/hosts', why: 'not a repository path or glob' }]);
  });

  test(`at most ${MAX_TRIGGERS} of each kind`, () => {
    const names = Array.from({ length: MAX_TRIGGERS + 2 }, (_, i) => `NAME_${i}`);
    const r = validateTriggers({ symbols: names }, { files: [], text: names.join(' ') });
    expect(r.triggers.symbols).toHaveLength(MAX_TRIGGERS);
    expect(r.dropped.map((d) => d.why)).toEqual([`more than ${MAX_TRIGGERS}`, `more than ${MAX_TRIGGERS}`]);
  });

  test('a path judged too broad by the repository listing is dropped', () => {
    const repo = Array.from({ length: 60 }, (_, i) => `src/m${i}.ts`);
    expect(validateTriggers({ paths: ['**/*.ts'] }, { files: ['src/m1.ts'], text: '', repoFiles: repo }).dropped[0].why).toMatch(/100% of the repository/);
  });
});

describe('reading a diff', () => {
  test('the added lines, each with its file; a deleted file adds nothing', () => {
    expect(addedLines(DIFF)).toEqual([
      { path: 'db/migrations/0042_edge.sql', text: 'ALTER TABLE graph_edge ADD COLUMN departed_at timestamptz;' },
      { path: 'db/migrations/0042_edge.sql', text: 'CREATE INDEX CONCURRENTLY graph_edge_departed ON graph_edge (departed_at);' },
      { path: 'src/sync/storage.py', text: '    await asyncio.to_thread(batch.commit)' },
    ]);
    // A diff with no headers still has its added lines, on no file.
    expect(addedLines('+x = 1')).toEqual([{ path: '', text: 'x = 1' }]);
    expect(addedLines('diff --git weird\n+y')).toEqual([{ path: '', text: 'y' }]);
  });

  test('the files a diff changes', () => {
    expect(diffFiles(DIFF)).toEqual(['db/migrations/0042_edge.sql', 'src/sync/storage.py', 'old.txt']);
    expect(diffFiles('')).toEqual([]);
  });
});

describe('matchTriggers', () => {
  const t = { paths: ['deploy/**/*.yaml'], patterns: ['CREATE\\s+INDEX'], symbols: ['asyncio.to_thread'] };
  const added = addedLines(DIFF);

  test('none, or empty: nothing fires', () => {
    expect(matchTriggers(null, { files: ['a.ts'] })).toBeNull();
    expect(matchTriggers(undefined, { files: ['a.ts'] })).toBeNull();
    expect(matchTriggers(emptyTriggers(), { files: ['a.ts'], text: 'anything' })).toBeNull();
    expect(hasTriggers(emptyTriggers())).toBe(false);
    expect(hasTriggers(t)).toBe(true);
  });

  test('a path on a named file comes first, then an added line, then the task', () => {
    expect(matchTriggers(t, { files: ['deploy/charts/api.yaml'], added, text: 'asyncio.to_thread' })).toEqual({ kind: 'path', trigger: 'deploy/**/*.yaml', on: 'deploy/charts/api.yaml' });
    expect(matchTriggers(t, { files: ['src/x.ts'], added })).toEqual({ kind: 'pattern', trigger: 'CREATE\\s+INDEX', on: 'db/migrations/0042_edge.sql' });
    expect(matchTriggers({ ...t, patterns: [] }, { files: [], added })).toEqual({ kind: 'symbol', trigger: 'asyncio.to_thread', on: 'src/sync/storage.py' });
    expect(matchTriggers(t, { files: [], text: 'move the write off the loop with asyncio.to_thread' })).toEqual({ kind: 'symbol', trigger: 'asyncio.to_thread', on: null });
    expect(matchTriggers(t, { files: [], added: [{ path: '', text: 'create index x' }] })).toEqual({ kind: 'pattern', trigger: 'CREATE\\s+INDEX', on: '(a file the diff does not name)' });
  });

  test('a symbol fires only as a whole name; a pattern that does not compile never fires', () => {
    expect(matchTriggers({ paths: [], patterns: ['(['], symbols: ['to_thread'] }, { files: [], added: [{ path: 'a.py', text: 'run_to_threads()' }], text: 'to_threadx' })).toBeNull();
  });

  test('why it was served, in words', () => {
    expect(triggerWhy({ kind: 'path', trigger: 'deploy/**/*.yaml', on: 'deploy/a.yaml' })).toBe('trigger path `deploy/**/*.yaml` matched deploy/a.yaml');
    expect(triggerWhy({ kind: 'pattern', trigger: 'a`b', on: 'x.sql' })).toBe("trigger pattern `a'b` matched an added line in x.sql");
    expect(triggerWhy({ kind: 'symbol', trigger: 'X_Y', on: null })).toBe('trigger symbol `X_Y` is in the task');
  });

  test('triggered: the items whose triggers fire, in order, each with its hit', () => {
    const items = [{ lesson: { triggers: t }, id: 1 }, { lesson: { triggers: null }, id: 2 }, { lesson: { triggers: { ...t, paths: ['src/**'] } }, id: 3 }];
    expect(triggered(items, { files: ['src/a.ts'] }).map((x) => [x.id, x.trigger.trigger])).toEqual([[3, 'src/**']]);
  });
});

describe('deriveTriggers: no model', () => {
  const repo = [...Array.from({ length: 60 }, (_, i) => `src/app/m${i}.ts`), 'db/migrations/0040_users.sql', 'deploy/k8s/api.yaml', 'docs/search.md'];

  test("the miss's files widened to their folder and extension; a deep folder to everything under it, a shallow one not at all", () => {
    expect(deriveTriggers({ rule: 'r', appliesWhen: 'w', evidence: '', files: ['db/migrations/0040_users.sql', 'src/sync/agent', 'deploy/charts', 'Makefile', '/abs/x.ts'], repoFiles: repo }).paths)
      .toEqual(['db/migrations/*.sql', 'src/sync/agent/**']);
  });

  test('a kind of file the lesson\'s own words name, never one the feedback mentions in passing or inside a path', () => {
    const kinds = (rule: string, evidence = '') => deriveTriggers({ rule, appliesWhen: '', evidence, files: [], repoFiles: repo }).paths;
    expect(kinds('Every SQL query change needs EXPLAIN evidence')).toEqual(['**/*.sql']);
    expect(kinds('Keep each Kubernetes manifest in one place')).toEqual(['**/*.yaml', '**/*.yml']);
    expect(kinds('State the gate in the docs exactly')).toEqual(['**/*.md']);
    expect(kinds('Write migrations that run twice')).toEqual(['**/migrations/**']);
    expect(kinds('Pin the base image in each Dockerfile; never `latest`')).toEqual(['**/Dockerfile*']);
    expect(kinds('Reference IPs from gke.tf in Terraform')).toEqual(['**/*.tf']);
    expect(kinds('Paginate gh pr list in GitHub Actions workflows')).toEqual(['.github/workflows/**']);
    expect(kinds('Version every protobuf message')).toEqual(['**/*.proto']);
    expect(kinds('Quote variables in shell scripts')).toEqual(['**/*.sh']);
    expect(kinds('Give each test binary its own database in *_test.go files')).toEqual(['**/*_test.go']);
    // In passing, in a path, or "documentation" (docstrings as often as files): none.
    expect(kinds('Keep QA captures local', 'Committed docs/qa/capture-manifest.json with SQL')).toEqual([]);
    expect(kinds('Name tools in prose when documenting them')).toEqual([]);
    // A kind matching most of the repository is no trigger.
    expect(deriveTriggers({ rule: 'Every SQL change', appliesWhen: '', evidence: '', files: [], repoFiles: repo.map((f) => f.replace(/\.ts$/, '.sql')) }).paths).toEqual([]);
  });

  test('a kind of file named only in the "applies when" needs a file of that kind in the miss', () => {
    const when = (appliesWhen: string, files: string[]) => deriveTriggers({ rule: 'Pass cents to chargeCard from the /checkout route', appliesWhen, evidence: '', files, repoFiles: repo }).paths;
    // A "when" the writer copied from an example, on a lesson about a route: no `**/*.sql`.
    expect(when('changing a SQL query or an index', ['src/web/routes.ts'])).toEqual(['src/web/*.ts']);
    expect(when('changing a SQL query or an index', ['db/migrations/0040_users.sql'])).toEqual(['db/migrations/*.sql', '**/*.sql']);
    expect(when('editing migrations', ['db/migrations/0040_users.sql'])).toEqual(['db/migrations/*.sql', '**/migrations/**']);
  });

  test('names shaped like code, from the words and the quoted code; a backticked phrase as a literal pattern; never a file, a word or an acronym', () => {
    const t = deriveTriggers({
      rule: 'Wrap each `FlushBatch` commit in asyncio.to_thread', appliesWhen: 'writing to the object store from async code',
      evidence: 'Set `safe-to-evict: "false"` with --dry-run=false; bind DRY_RUN; call parse_payload(x) in api/handler.py; `README.md`; `ok`; JSON and YAML; see https://x.test/a',
      files: [],
    });
    expect(t.symbols).toEqual(['FlushBatch', 'asyncio.to_thread', '--dry-run', 'DRY_RUN', 'parse_payload']);
    expect(t.patterns).toEqual(['safe-to-evict: "false"']);
  });

  test('no symbol from a product or proper name or a word in capitals: those fire on any line that mentions them', () => {
    const symbols = (rule: string, evidence = '') => deriveTriggers({ rule, appliesWhen: '', evidence, files: [] }).symbols;
    expect(symbols('Pin GitHub Actions to a commit SHA')).toEqual([]);
    expect(symbols('Never use any in TypeScript code')).toEqual([]);
    expect(symbols('Run EXPLAIN on PostgreSQL queries')).toEqual([]);
    expect(symbols('Resolve the TODO before merging', 'FIXME: this is still wrong, see the FIXME in JavaScript and macOS builds')).toEqual([]);
    // Code-shaped names stay: camelCase, snake_case and CONSTANTS, dotted members, calls.
    expect(symbols('Pass cents to chargeCard; pin STRIPE_API_VERSION; call stripe.refunds.create', 'Check the result of getUser() for null'))
      .toEqual(['chargeCard', 'STRIPE_API_VERSION', 'stripe.refunds.create', 'getUser']);
  });

  test('at most eight of a kind', () => {
    const names = Array.from({ length: 12 }, (_, i) => `NAME_${i}`).join(' ');
    expect(deriveTriggers({ rule: names, appliesWhen: '', evidence: '', files: [] }).symbols).toHaveLength(MAX_TRIGGERS);
  });

  test('mergeTriggers: the derived first, then the model\'s, once each, at most eight', () => {
    const many = Array.from({ length: 9 }, (_, i) => `N_${i}`);
    expect(mergeTriggers({ paths: ['a/*.ts'], patterns: [], symbols: ['N_0'] }, { paths: ['a/*.ts', 'b/**'], patterns: ['X\\('], symbols: many }))
      .toEqual({ paths: ['a/*.ts', 'b/**'], patterns: ['X\\('], symbols: many.slice(0, 8) });
  });
});

describe('serving the fired lessons', () => {
  const hit = (kind: 'path' | 'pattern' | 'symbol', trigger: string) => ({ kind, trigger, on: 'x' });
  test('the most specific hit first: a name or line, then a glob in a folder, then a kind of file anywhere', () => {
    expect([hitRank(hit('symbol', 'X_Y')), hitRank(hit('pattern', 'a\\(')), hitRank(hit('path', 'db/*.sql')), hitRank(hit('path', '**/*.sql'))]).toEqual([0, 0, 1, 2]);
  });

  test(`at most k, and at most ${KIND_ONLY_K} served by a kind of file alone`, () => {
    const fired = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `k${i}`, trigger: hit('path', '**/*.yaml') })),
      { id: 'dir', trigger: hit('path', 'deploy/*.yaml') },
      { id: 'name', trigger: hit('symbol', 'DRY_RUN') },
    ];
    expect(servedTriggered(fired, 6).map((x) => x.id)).toEqual(['name', 'dir', 'k0', 'k1', 'k2']);
    expect(servedTriggered(fired, 2).map((x) => x.id)).toEqual(['name', 'dir']);
  });
});

describe('no trigger can stall the api (sweep 4 S1): matching is linear in the text', () => {
  const N = 900_000;
  /** The ones reported, which took seconds to minutes on a line of 30 to 2,000 characters, and their worst inputs. */
  const PATTERNS: [string, (n: number) => string][] = [
    ['((\\w)+)+Q_Z', (n) => `${'a'.repeat(n)} Q_Z`],
    ['\\w*\\w*\\w*\\w*\\w*\\w*\\w*Q_Z', (n) => `${'abcdef0123'.repeat(n / 10)} Q_Z`],
    ['(SELECT|select|Select)+\\s', (n) => 'SELECT'.repeat(n / 6)],
    ['.*log.*response.*body', (n) => 'log response '.repeat(n / 13)],
    ['.*resp\\.Body.*Close', (n) => 'resp.Body '.repeat(n / 10)],
    ['(a+)+$', (n) => `${'a'.repeat(n)}!`],
    ['(a|aa)*b', (n) => 'a'.repeat(n)],
    ['(x+x+)+y', (n) => 'x'.repeat(n)],
    ['^(\\w+\\s?)+$', (n) => `${'word '.repeat(n / 5)}!`],
    ['\\bfoo(_\\w+)*\\b\\(', (n) => `${'foo_bar'.repeat(n / 7)}`],
  ];

  /** The work (MatchBudget units) and time of one task's words of n characters against the pattern alone. */
  const run = (pattern: string, text: string) => {
    const budget = { left: Number.MAX_SAFE_INTEGER };
    const t0 = performance.now();
    const hit = matchTriggers({ paths: [], patterns: [pattern], symbols: [] }, { files: [], text }, budget);
    return { hit, work: Number.MAX_SAFE_INTEGER - budget.left, ms: performance.now() - t0 };
  };

  test.each(PATTERNS)('%s: accepted, and linear on 900 kB', (pattern, worst) => {
    expect(triggerShapeProblem('pattern', pattern)).toBeNull();
    const half = run(pattern, worst(N / 2));
    const full = run(pattern, worst(N));
    expect(full.hit).toEqual(half.hit);
    expect(full.work).toBeLessThanOrEqual(2 * half.work + 10_000);
    expect(full.work).toBeLessThan(4 * N);
    // Generous for a loaded machine; a backtracking engine takes hours here.
    expect(full.ms).toBeLessThan(5000);
  });

  test('random patterns: every accepted one is linear on 900 kB of its own characters', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    const atoms = ['a', 'b', '\\w', '\\s', '.', '[ab]', '(a|ab)', '(a+)', '(?:b|a)', '\\b', '_x'];
    const quants = ['', '*', '+', '?', '{1,5}', '{2,}'];
    let accepted = 0;
    for (let k = 0; k < 60; k++) {
      let p = '';
      for (let j = 0; j < 2 + rnd(5); j++) p += atoms[rnd(atoms.length)] + (p.endsWith('\\b') ? '' : quants[rnd(quants.length)]);
      p = `(${p})${quants[1 + rnd(quants.length - 1)]}c_d`;
      if (triggerShapeProblem('pattern', p)) continue;
      accepted++;
      const text = (n: number) => 'ab a_xb '.repeat(n / 8) + 'c_';
      const half = run(p, text(N / 2));
      const full = run(p, text(N));
      expect(full.work, p).toBeLessThanOrEqual(2 * half.work + 100_000);
      expect(full.ms, p).toBeLessThan(5000);
    }
    expect(accepted).toBeGreaterThan(30);
  });

  test('path globs: a run of wildcards and repeated **/ match a 900 kB path in linear time', () => {
    for (const [glob, path] of [
      [`src/${'*a'.repeat(19)}*b`, `src/${'a'.repeat(N)}`],
      [`${'**/'.repeat(12)}x`, 'a/'.repeat(N / 2)],
      ['src/***/**/**/*.ts', `src/${'a/'.repeat(N / 2)}b.py`],
    ]) {
      const t0 = performance.now();
      expect(pathMatches(glob, path)).toBe(false);
      expect(performance.now() - t0, glob).toBeLessThan(5000);
    }
    // Merging runs keeps what a glob means.
    expect(pathMatches('src/***/x.ts', 'src/a/b/x.ts')).toBe(true);
    expect(pathMatches('src/**/**/x.ts', 'src/x.ts')).toBe(true);
    expect(pathMatches('a****/b', 'a.c/b')).toBe(true);
    expect(pathMatches('src/*/*.ts', 'src/x.ts')).toBe(false);
  });

  test('one change spends one budget across all lessons: past it no further pattern fires', () => {
    const budget = { left: 10_000, exhausted: false };
    const items = Array.from({ length: 20 }, () => ({ lesson: { triggers: { paths: [], patterns: ['(\\w+_)+Z_Q'], symbols: [] } } }));
    const fired = triggered(items, { files: [], added: [{ path: 'a.ts', text: `${'ab_'.repeat(600)}Z_Q` }] }, budget);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.length).toBeLessThan(20);
    expect(budget.exhausted).toBe(true);
  });

  test('validateTriggers checks a model\'s pattern against long miss text in linear time', () => {
    const t0 = performance.now();
    const r = validateTriggers({ patterns: ['(SELECT|select|Select)+\\s', '((\\w)+)+Q_Z'] }, { files: [], text: `${'SELECT'.repeat(330)}\nSELECT * FROM syncs\n${'a'.repeat(1990)} fooQ_Z` });
    expect(r.triggers.patterns).toEqual(['(SELECT|select|Select)+\\s', '((\\w)+)+Q_Z']);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test('what is synced or imported is only what a trigger may be', () => {
    expect(shapedTriggers({ paths: [' db/*.sql ', `src/${'*a'.repeat(9)}`], patterns: ['(?=x)y', 'CREATE\\s+INDEX'], symbols: ['a b', 'FlushBatch'] }))
      .toEqual({ paths: ['db/*.sql'], patterns: ['CREATE\\s+INDEX'], symbols: ['FlushBatch'] });
  });
});

describe('secrets never become triggers (sweep 4 NEW-3, NEW-8)', () => {
  test('deriveTriggers widens no secret file and takes no [REDACTED] for a name', () => {
    const t = deriveTriggers({
      rule: 'Load the Stripe key from the environment, never hardcode it in src/pay.ts.', appliesWhen: 'changing payment code',
      evidence: 'Agent wrote STRIPE_KEY=[REDACTED] in config/prod.env and `[REDACTED]` in src/pay.ts',
      files: ['config/prod.env', 'certs/server.key', 'deploy/k8s/secrets', 'src/pay.ts'],
    });
    expect(t.paths).toEqual(['src/*.ts']);
    expect([...t.symbols, ...t.patterns].filter((v) => v.includes('REDACTED'))).toEqual([]);
    expect(t.symbols).toContain('STRIPE_KEY');
  });

  test('validateTriggers keeps no glob only a secret file of the miss matches', () => {
    const r = validateTriggers({ paths: ['config/*.env', 'src/*.ts'] }, { files: ['config/prod.env', 'src/pay.ts'], text: '' });
    expect(r.triggers.paths).toEqual(['src/*.ts']);
  });
});
