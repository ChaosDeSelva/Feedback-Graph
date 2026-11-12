import { describe, expect, test } from 'vitest';
import { REDACTION_PATTERNS, redactSecrets } from './redact.ts';

/** Feedback is accepted up to 20 kB and diffs up to 900 kB, so every rule must stay linear on ~100 kB of hostile text. */
const SIZE = 100_000;
/** Milliseconds one rule may take over SIZE characters; a linear rule takes well under 20. */
const RULE_BUDGET_MS = 75;
/** Milliseconds a whole redactSecrets call may take over SIZE characters. */
const CALL_BUDGET_MS = 750;

/** The literal runs of a pattern's source: what an attacker repeats to make the pattern start over and over. */
function seeds(re: RegExp): string[] {
  const src = re.source.replace(/\(\?<[a-z]+>/gi, '(').replace(/\\[sSdDwWbBnrt]/g, ' ').replace(/\[[^\]]*\]/g, 'a1')
    .replace(/\\(.)/g, '$1').replace(/\(\?[:=!]|\(\?<[=!]/g, '(');
  const words = src.split(/[()|?*+{}^$]+|\d+,\d*/).map((w) => w.trim()).filter((w) => w.length >= 2);
  return [...words, words.join(' '), src.replace(/[()|?*+{}^$]/g, '')];
}
const GENERIC = ['a', 'a1', ' ', ':', 'a:', '-', 'a-', '.', 'a.', '/', '=', 'a=', '\n', ' \n', '"', 'a ', '--', 'aB1_', 'aB1+/', '\\n', '# ', '> '];
const SEPARATORS = ['', ' ', '\n', ':', '='];
/**
 * What follows a single prefix: a rule's gap that also matches its own separator restarts at every character. Runs of
 * line breaks end in one more line, so a rule that waits for the next line has one to try at the end.
 */
const BODIES: [body: string, end: string][] = [[' ', ''], ['\t', ''], ['a', ''], ['1', ''], ['-', ''], ['/', ''], ['=', ''], ['\n', '\nx'], ['\n ', '\nx'], ['\r\n', '\nx']];

/** A hostile input of any size: a unit repeated, or one prefix followed by a run of one character. */
type Hostile = { label: string; build: (size: number) => string };
const repeated = (unit: string): Hostile => ({ label: JSON.stringify(unit).slice(0, 60), build: (size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size) });
const prefixed = (prefix: string, [body, end]: [string, string]): Hostile => ({
  label: `${JSON.stringify(prefix).slice(0, 50)} + ${JSON.stringify(body)}...${JSON.stringify(end)}`,
  build: (size) => prefix + body.repeat(Math.max(0, Math.ceil((size - prefix.length - end.length) / body.length))) + end,
});

/** Every hostile input for a rule: its literals and the generic units repeated, and each literal or word of one before a long run. */
function hostile(re: RegExp): Hostile[] {
  const units = new Set([...seeds(re), ...GENERIC].flatMap((seed) => SEPARATORS.map((sep) => seed + sep)));
  const prefixes = new Set(seeds(re).flatMap((seed) => [seed, ...seed.split(/\s+/).filter((w) => w.length >= 2)]));
  return [...[...units].map(repeated), ...[...prefixes].flatMap((prefix) => BODIES.map((body) => prefixed(prefix, body)))];
}

/** Milliseconds of this thread's CPU time for one run: other processes on a busy host do not count against it. */
function cpuMs(run: () => unknown): number {
  const start = process.threadCpuUsage();
  run();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}
const best = (runs: number, run: () => unknown) => Math.min(...Array.from({ length: runs }, () => cpuMs(run)));

/**
 * Why `run` over the hostile input is not linear, or null. A rule's cost is measured on growing inputs, each four times
 * the last, up to a quarter of SIZE (where growth already shows): linear work grows about 4x a step, a quadratic rule
 * about 16x, a cubic one 64x. A step within its share of the budget passes; one over it fails only if it also grew more
 * than 8x, so a stray pause or a slow host cannot fail a linear rule, a fast host cannot hide a quadratic one, and a
 * cubic one is caught at a few thousand characters instead of running for hours.
 */
function superlinear(input: Hostile, run: (input: string) => unknown, budgetMs: number): string | null {
  let previous: number | null = null;
  for (const size of [SIZE / 64, SIZE / 16, SIZE / 4]) {
    const text = input.build(size);
    const allowed = budgetMs * (size / SIZE);
    let ms = cpuMs(() => run(text));
    // Near the line, the best of three, so one pause does not decide.
    if (ms > allowed && ms < 4 * allowed) ms = Math.min(ms, best(2, () => run(text)));
    if (ms > allowed && previous !== null && ms / Math.max(previous, 0.1) > 8) {
      return `${input.label}: ${ms.toFixed(0)} ms at ${size} characters, ${(ms / Math.max(previous, 0.1)).toFixed(1)}x a quarter of it`;
    }
    previous = ms;
  }
  return null;
}

describe('every redaction rule stays inside a time budget on adversarial input', () => {
  test.each(REDACTION_PATTERNS.map((re, i) => [i, re] as const))('pattern %i', (_i, re) => {
    const slow = hostile(re).map((input) => superlinear(input, (text) => text.replace(new RegExp(re.source, re.flags), ''), RULE_BUDGET_MS)).filter(Boolean);
    expect(slow, re.source).toEqual([]);
  });

  test.each([
    'untrusted comment: minisign secret key',
    'untrusted comment: minisign encrypted secret key ',
    'apikey=', 'password: ', 'curl -u ', 'mysql -p ', '<password ', 'data:\n', 'x://', '-----BEGIN ' + 'PRIVATE KEY-----\n',
    ...REDACTION_PATTERNS.map((re) => seeds(re).at(-2)!),
  ])('redactSecrets over 100 kB of %j', (unit) => {
    for (const sep of ['', ' ', '\n']) expect(superlinear(repeated(unit + sep), redactSecrets, CALL_BUDGET_MS)).toBeNull();
  });

  test.each(['curl', 'mysql', 'mysqldump', 'docker login', 'redis-cli', 'password', 'Password=', 'data:', 'untrusted comment:'])('redactSecrets over %j and a long run of one character', (prefix) => {
    for (const body of BODIES) expect(superlinear(prefixed(prefix, body), redactSecrets, CALL_BUDGET_MS)).toBeNull();
  });
});
