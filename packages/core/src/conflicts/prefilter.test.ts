import { describe, expect, test } from 'vitest';
import { conflictPrefilter, needsJudge, normalizeStatement, JUDGE_MIN_COSINE, type PrefilterSignal, type PrefilterSide } from './prefilter.ts';

const side = (text: string, assertedAt?: string, about?: string): PrefilterSide => ({ text, assertedAt, about });
const signals = (a: PrefilterSide | string, b: PrefilterSide | string) =>
  conflictPrefilter(typeof a === 'string' ? side(a) : a, typeof b === 'string' ? side(b) : b).signals;
const families = (a: PrefilterSide | string, b: PrefilterSide | string) => signals(a, b).map((s) => s.family);
/** The same signals with the sides swapped. */
const mirrored = (ss: PrefilterSignal[]) => ss.map((s) => ({ ...s, a: s.b, b: s.a })).map(({ why: _why, ...s }) => s);
const withoutWhy = (ss: PrefilterSignal[]) => ss.map(({ why: _why, ...s }) => s);

// Anchors: 2026-11-04 is a Wednesday.
const NOV4 = '2026-11-04T10:00:00Z';
const NOV16 = '2026-11-16T10:00:00Z';

describe('same', () => {
  test('texts equal after normalisation are a duplicate, with no signals', () => {
    expect(conflictPrefilter(side('The retry timeout is 30 s.'), side('the  retry timeout is 30 s'))).toEqual({ same: true, signals: [] });
    expect(conflictPrefilter(side('We won’t use “Redis”.'), side("We won't use \"Redis\""))).toEqual({ same: true, signals: [] });
  });

  test('a paraphrase is not the same text', () => {
    const r = conflictPrefilter(side('Every schema change needs a migration review before merge.'), side('Schema changes must get a migration review before they merge.'));
    expect(r).toEqual({ same: false, signals: [] });
  });

  test('normalizeStatement folds case, quotes, punctuation and whitespace but keeps contractions and percent', () => {
    expect(normalizeStatement('  “We WON’T” ship — 30%, ok?  ')).toBe("we won't ship 30% ok");
    expect(normalizeStatement("'quoted' words")).toBe('quoted words');
  });
});

describe('numbers with units', () => {
  test('different values in the same dimension signal, with both sides as written', () => {
    expect(signals('The retry timeout for the ledger client is 30 seconds.', "The ledger client's retry timeout is 60 seconds.")).toEqual([
      { family: 'number', key: 'time', a: ['30 seconds'], b: ['60 seconds'], why: 'numbers differ: 30 seconds vs 60 seconds' },
    ]);
  });

  test('equal values in different units do not', () => {
    expect(signals('The retry timeout is 30s.', 'The retry timeout is 30 seconds.')).toEqual([]);
    expect(signals('Wait 1 minute.', 'Wait 60 seconds.')).toEqual([]);
    expect(signals('Wait an hour.', 'Wait 60 minutes.')).toEqual([]);
    expect(signals('A 30-second timeout.', 'The timeout is 30000 ms.')).toEqual([]);
    expect(signals('Uploads up to 2 MB.', 'Uploads up to 2000 kb.')).toEqual([]);
  });

  test('spelled-out numbers and hyphenated units are read', () => {
    expect(signals('Import jobs time out after 120 seconds.', 'Import jobs time out after five minutes.')).toMatchObject([{ key: 'time', b: ['five minutes'] }]);
    expect(signals('Keep twenty-five days of logs.', 'Keep 30 days of logs.')).toMatchObject([{ key: 'time', a: ['twenty-five days'] }]);
    expect(signals('A 30-second timeout.', 'A 45 second timeout.')).toMatchObject([{ key: 'time', a: ['30-second'] }]);
  });

  test('counts compare by the noun they count, singular and plural alike', () => {
    expect(signals('We cap each import batch at 500 rows.', 'The import batch cap is 2,000 rows.')).toMatchObject([{ key: 'count:row', a: ['500 rows'], b: ['2,000 rows'] }]);
    expect(signals('Retry at most 3 times.', 'It retries 5 times.')).toMatchObject([{ key: 'count:time' }]);
    expect(signals('Run 3 replicas.', 'Run 3 replicas behind the balancer.')).toEqual([]);
    expect(signals('We run 1 replica.', 'We run 2 replicas.')).toMatchObject([{ key: 'count:replica' }]);
    expect(signals('Keep 2k entries.', 'Keep 2000 entries.')).toEqual([]);
  });

  test('different dimensions, or a dimension on one side only, do not signal', () => {
    expect(signals('The timeout is 30 seconds.', 'The upload limit is 60 MB.')).toEqual([]);
    expect(signals('Run 3 replicas.', 'Retry 5 times.')).toEqual([]);
    expect(signals('The timeout is 30 seconds.', 'The timeout is configurable.')).toEqual([]);
  });

  test('a side holding both values does not conflict with either', () => {
    expect(signals('Reads time out after 30 s and writes after 60 s.', 'Writes time out after 60 seconds.')).toEqual([]);
    expect(signals('Reads time out after 30 s and writes after 60 s.', 'Writes time out after 90 seconds.')).toMatchObject([{ key: 'time' }]);
  });

  test('percentages and money', () => {
    expect(signals('Error budget is 2%.', 'Error budget is 5 percent.')).toMatchObject([{ key: 'percent' }]);
    expect(signals('Error budget is 2%.', 'Error budget is 2 percent.')).toEqual([]);
    expect(signals('The plan costs $20 a seat.', 'The plan costs $25 a seat.')).toMatchObject([{ key: 'money:$', a: ['$20'], b: ['$25'] }]);
  });

  test('an article counts only with a unit; bare numbers and stop words count nothing', () => {
    expect(signals('Use a cache.', 'Use 2 caches.')).toEqual([]);
    expect(signals('Go with option 3 and 4.', 'Go with option 5 and 6.')).toEqual([]);
    expect(signals('Set it to 30.', 'Set it to 60.')).toEqual([]);
  });

  test('numbers glued to letters are not quantities', () => {
    expect(signals('Build for x86 targets.', 'Build for arm64 targets.')).toEqual([]);
  });
});

describe('dates', () => {
  test('an absolute date and a month that do not overlap signal, with the year from the anchor', () => {
    const ss = signals(side('We ship the importer on 12 December.', NOV4), side('The importer ships in January.', NOV16));
    expect(ss).toEqual([{
      family: 'date', key: 'date', a: ['12 December'], b: ['January'],
      why: 'dates differ: 12 December (2026-12-12) vs January (2027-01-01..2027-01-31)',
    }]);
  });

  test('a date inside the other side\'s range does not', () => {
    expect(signals(side('We ship on 12 December.', NOV4), side('We ship in December.', NOV16))).toEqual([]);
    expect(signals(side('We ship on 12 December.', NOV4), side('We ship mid-December.', NOV16))).toEqual([]);
    expect(signals(side('We ship on 12 December.', NOV4), side('We ship by the end of the year.', NOV16))).toEqual([]);
    expect(signals(side('We ship on December 12th, 2026.', NOV4), side('Ship date: 2026-12-12.', NOV16))).toEqual([]);
  });

  test('"by" a date covers every day up to it', () => {
    expect(signals(side('Ship by 12 December.', NOV4), side('Ship on 1 December.', NOV4))).toEqual([]);
    expect(signals(side('Ship on 12 December.', NOV4), side('Ship on 1 December.', NOV4))).toMatchObject([{ family: 'date' }]);
  });

  test('parts of a month and quarters', () => {
    expect(signals(side('Ship in early March.', NOV4), side('Ship in late March.', NOV4))).toMatchObject([{ family: 'date' }]);
    expect(signals(side('Ship in Q1.', NOV4), side('Ship on 20 February.', NOV4))).toEqual([]);
    expect(signals(side('Ship in Q1 2027.', NOV4), side('Ship in Q2 2027.', NOV4))).toMatchObject([{ family: 'date', a: ['Q1 2027'], b: ['Q2 2027'] }]);
    expect(signals(side('Ship by end of Q1.', NOV4), side('Ship in January.', NOV4))).toEqual([]);
  });

  test('relative dates resolve against each side\'s own anchor', () => {
    // "tomorrow" said on 4 and on 16 November are different days.
    expect(signals(side('Cutover is tomorrow.', NOV4), side('Cutover is tomorrow.', NOV16))).toEqual([]); // the same text: a duplicate, not a date check
    expect(signals(side('The cutover is tomorrow.', NOV4), side('Cutover happens tomorrow.', NOV16))).toMatchObject([{ family: 'date' }]);
    expect(signals(side('The cutover is tomorrow.', NOV4), side('Cutover is on 5 November.', NOV16))).toEqual([]);
    expect(signals(side('Freeze starts next week.', NOV4), side('Freeze starts on 10 November.', NOV16))).toEqual([]);
    expect(signals(side('Freeze starts in two weeks.', NOV4), side('Freeze starts on 18 November.', NOV4))).toEqual([]);
    expect(signals(side('Freeze starts in 2 weeks.', NOV4), side('Freeze starts on 25 November.', NOV4))).toMatchObject([{ family: 'date' }]);
    expect(signals(side('Freeze starts next month.', NOV4), side('Freeze starts this month.', NOV4))).toMatchObject([{ family: 'date' }]);
  });

  test('weekdays: "next Friday" is next week\'s, "on Friday" the first one after; "Fridays" recur and are not dates', () => {
    expect(signals(side('Ship it next Friday.', NOV4), side('Ship it on 13 November.', NOV4))).toEqual([]);
    expect(signals(side('Ship it on Friday.', NOV4), side('Ship it on 6 November.', NOV4))).toEqual([]);
    expect(signals(side('Ship it next Friday.', NOV4), side('Ship it on Friday.', NOV4))).toMatchObject([{ family: 'date', a: ['next Friday'], b: ['on Friday'] }]);
    expect(families(side('We deploy on Fridays.', NOV4), side('We deploy on Tuesdays.', NOV4))).not.toContain('date');
  });

  test('a side with no anchor borrows the other\'s; with neither, relative dates are skipped and yearless dates share one year', () => {
    expect(signals(side('Ship on 12 December.', NOV4), side('Ship in January.'))).toMatchObject([{ family: 'date' }]);
    expect(signals('Ship tomorrow.', 'Ship next week.')).toEqual([]);
    expect(signals('Ship in March.', 'Ship in May.')).toMatchObject([{ family: 'date', a: ['March'], b: ['May'] }]);
  });

  test('"may" and "march" as ordinary words are not months', () => {
    expect(signals('We may ship it.', 'We march on with the plan.')).toEqual([]);
    expect(signals('We may ship in June.', 'We may ship in June or July.')).toEqual([]);
  });

  test('a date on one side only does not signal', () => {
    expect(signals(side('Ship on 12 December.', NOV4), side('Ship when it is ready.', NOV4))).toEqual([]);
  });
});

describe('versions', () => {
  test('one product at different versions signals', () => {
    expect(signals('The build agents run Node 20.', 'The build agents run Node 22.')).toEqual([
      { family: 'version', key: 'node', a: ['Node 20'], b: ['Node 22'], why: 'versions differ: Node 20 vs Node 22' },
    ]);
    expect(signals('We are on Python 3.11 for the agents.', 'We are on Python 3.12 for the agents.')).toMatchObject([{ key: 'python' }]);
    expect(signals('Pin node@20.', 'Pin Node.js 22.')).toMatchObject([{ key: 'node' }]);
    expect(signals('Release v1.2.3 is out.', 'Release v1.4.0 is out.')).toMatchObject([{ family: 'version' }]);
    expect(signals('The schema is at 2.4.1.', 'The schema is at 2.5.0.')).toMatchObject([{ key: 'version' }]);
  });

  test('compatible versions, other products, or a version on one side only do not', () => {
    expect(signals('The build agents run Node 20.', 'The build agents run Node 20.11.')).toEqual([]);
    expect(signals('The build agents run Node 20.', 'The build agents run Node 20.x.')).toEqual([]);
    expect(signals('The build agents run Node 20.', 'The database is Postgres 16.')).toEqual([]);
    expect(signals('The build agents run Node 20.', 'The build agents run Node.')).toEqual([]);
  });

  test('a number after a name followed by what it counts is a count, not a version', () => {
    // "Wait 30 seconds" and "Postgres 16 clusters" are not versions of "Wait" or "Postgres".
    expect(families('Wait 30 seconds.', 'Wait 60 seconds.')).toEqual(['number']);
    expect(families('Postgres 16 clusters run here.', 'Postgres 17 clusters run here.')).toEqual(['number']);
  });

  test('a version is not also read as a quantity, nor a date as a version', () => {
    expect(families('Node 20 for the agents.', 'Node 22 for the agents.')).toEqual(['version']);
    expect(families(side('Ship on December 12.', NOV4), side('Ship on December 20.', NOV4))).toEqual(['date']);
  });
});

describe('negation', () => {
  test('one side negating a predicate the other states signals, either way round', () => {
    const ss = signals('We will use Redis for the session cache.', "We won't use Redis for the session cache; the in-process store is enough.");
    expect(ss).toEqual([{
      family: 'negation', key: 'use redis', a: ['will use redis'], b: ["we won't use redis"],
      why: 'one side negates "use redis": "will use redis" vs "we won\'t use redis"',
    }]);
    expect(withoutWhy(signals("We won't use Redis for the session cache.", 'We will use Redis for the session cache.'))).toEqual(mirrored(signals('We will use Redis for the session cache.', "We won't use Redis for the session cache.")));
  });

  test('the negators: not, n\'t, never, no longer, cannot; inflections of the verb match', () => {
    expect(families('The service uses Redis.', 'The service does not use Redis.')).toEqual(['negation']);
    expect(families('We deploy on Fridays.', 'We never deploy on Fridays.')).toEqual(['negation']);
    expect(families('We are using Redis for sessions.', 'We no longer use Redis for sessions.')).toEqual(['negation']);
    expect(families('Agents can push to main.', 'Agents cannot push to main.')).toEqual(['negation']);
    expect(families('We must ship the importer.', 'We must not ship the importer.')).toEqual(['negation']);
    expect(families('A review is required.', 'A review is not required.')).toEqual(['negation']);
    expect(families('The importer is shipped.', "The importer isn't shipped.")).toEqual(['negation']);
  });

  test('both sides negating, or different predicates, do not signal', () => {
    expect(signals("We won't use Redis.", 'We will not use Redis for anything.')).toEqual([]);
    expect(families('We will use Redis.', "We won't use Memcached.")).not.toContain('negation');
    expect(signals('We will use Redis.', "We won't deploy on Fridays.")).toEqual([]);
  });

  test('a negation in another clause does not reach the predicate', () => {
    expect(signals('We will use Redis.', "It isn't fast, but we use Redis.")).toEqual([]);
  });

  test('a bare verb with no object needs a modal on the other side', () => {
    expect(families('We will ship.', "We won't ship.")).toEqual(['negation']);
    expect(signals('Ship it.', "We won't ship.")).toEqual([]);
  });
});

describe('named alternatives', () => {
  test('two members of one group under the same subject signal', () => {
    expect(signals(side('The audit log lives in Postgres.', undefined, 'audit log storage'), side("We're keeping the audit log in MySQL.", undefined, 'the audit log'))).toEqual([
      { family: 'alternative', key: 'database', a: ['Postgres'], b: ['MySQL'], why: 'different database: Postgres vs MySQL' },
    ]);
    expect(families('The importer runs on Kubernetes.', 'The importer runs on Nomad.')).toEqual(['alternative']);
    expect(families('Tests run on Vitest.', 'Tests run on Jest.')).toEqual(['alternative']);
  });

  test('different subjects, the same member, or a side naming both do not', () => {
    expect(signals(side('The audit log lives in Postgres.', undefined, 'audit log'), side('Analytics live in MySQL.', undefined, 'analytics store'))).toEqual([]);
    expect(signals('The audit log lives in PostgreSQL.', 'The audit log is kept in Postgres.')).toEqual([]);
    expect(signals('We moved from MySQL to Postgres.', 'The audit log lives in Postgres.')).toEqual([]);
    expect(signals('The audit log lives in Postgres.', 'The importer runs on Kubernetes.')).toEqual([]);
  });

  test('names that are also ordinary words count only when capitalised', () => {
    expect(signals('The UI is built with React.', 'The UI is built with Vue.')).toMatchObject([{ key: 'ui framework' }]);
    expect(signals('Services react to events.', 'The UI is built with Vue.')).toEqual([]);
  });

  test('"X instead of Y" against a side relying on Y signals; against one choosing X, or also setting Y aside, it does not', () => {
    expect(signals('Use batching instead of streaming for the importer.', 'The importer relies on streaming.')).toMatchObject([
      { family: 'alternative', key: 'batching / streaming', a: ['batching instead of streaming'], b: ['streaming'] },
    ]);
    expect(withoutWhy(signals('The importer relies on streaming.', 'Use batching instead of streaming for the importer.'))).toEqual(
      mirrored(signals('Use batching instead of streaming for the importer.', 'The importer relies on streaming.')),
    );
    expect(signals('Use batching instead of streaming.', 'Batching beats streaming here.')).toEqual([]);
    expect(signals('Use batching instead of streaming.', 'We prefer batching over streaming.')).toEqual([]);
  });
});

test('every family on the same pair, and the pair the other way round, mirror each other', () => {
  const a = side('We will use Redis on Node 20, with a 30 s timeout, shipping 12 December, on Kubernetes.', NOV4);
  const b = side("We won't use Redis on Node 22, with a 60 s timeout, shipping in January, on Nomad.", NOV16);
  const ab = signals(a, b);
  expect(ab.map((s) => s.family).sort()).toEqual(['alternative', 'date', 'negation', 'number', 'version']);
  expect(withoutWhy(signals(b, a))).toEqual(expect.arrayContaining(mirrored(ab)));
});

describe('needsJudge', () => {
  const r = (same: boolean, n: number) => ({ same, signals: Array.from({ length: n }, () => ({ family: 'number' as const, key: 'time', a: [], b: [], why: '' })) });
  test('a signal, or a close embedding, sends a pair to the judge', () => {
    expect(needsJudge(r(false, 1), 0.72)).toBe(true);
    expect(needsJudge(r(false, 0), JUDGE_MIN_COSINE)).toBe(true);
  });
  test('a duplicate, or a pair with neither, does not', () => {
    expect(needsJudge(r(true, 0), 0.99)).toBe(false);
    expect(needsJudge(r(false, 0), JUDGE_MIN_COSINE - 0.01)).toBe(false);
  });
});

test('numbers in different units say the amounts in the base unit too, so a judge need not convert them', () => {
  expect(conflictPrefilter({ text: 'Import jobs time out after five minutes.' }, { text: 'Import jobs time out after 120 seconds.' }).signals.map((s) => s.why))
    .toEqual(['numbers differ: five minutes vs 120 seconds (300 vs 120 seconds)']);
  expect(conflictPrefilter({ text: 'The timeout is 30 seconds.' }, { text: 'The timeout is 60 seconds.' }).signals.map((s) => s.why)).toEqual(['numbers differ: 30 seconds vs 60 seconds']);
});
