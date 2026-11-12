import { describe, expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';

/**
 * One command or label followed by a long run of one character: rules that put two quantifiers able to match the same
 * character side by side (\s+ before a gap that also takes spaces, a value and its lookahead both taking blanks) split
 * such a run in n² or n³ ways. Sizes are where the old rules took seconds; the fixed ones take a few milliseconds.
 */
const BUDGET_MS = 250;
const SHAPES: [string, string, string, string, number][] = [
  ['curl -u', 'curl', ' ', 'x', 50_000],
  ['curl --user', 'curl', '\t', '', 50_000],
  ['mysql -p', 'mysql', '\t', 'x', 50_000],
  ['mysqldump --password=', 'mysqldump', ' ', '', 50_000],
  ['Password= then a line break', 'Password=', ' ', '\nx', 3_000],
  ['a typed assignment', 'password: a', ' ', '', 20_000],
  ['htpasswd -b', 'htpasswd -b', ' ', 'x', 50_000],
  ['mongosh -p', 'mongosh', ' ', 'x', 50_000],
  ['net user', 'net user', ' ', '', 50_000],
  ['a here-string after a login', 'login ', '<<< ', '', 50_000],
  ['a command that takes a password', 'cqlsh', ' -p', ' x', 50_000],
  ['a cookie header', 'Cookie: ', 'a=b; ', '', 50_000],
  ['a header named for a credential', 'X-', 'a-', ': key', 50_000],
  ['a token after a credential word', 'token', ' a', ' x', 50_000],
  ['a Secret data: block of empty lines', 'data:', '\n', '', 3_000],
  ['a Secret data: block of blank lines', 'data:', '\n ', '', 3_000],
  ['a long value after a name that ends in punctuation', 'token=', 'a', '.(', 50_000],
  ['credential names inside one long value', 'x ', 'token=', '(', 50_000],
  ['a name/value pair and a run of blanks', 'name: "DB_PASSWORD"', ' ', 'x', 50_000],
  ['a mapping and many sibling keys', 'encryption:\n', '  a: b\n', '  x', 20_000],
  ['a recovery-phrase label and words', 'mnemonic: ', 'abc ', 'x', 50_000],
  ['a JWT-like run', '', '-ey', 'x', 50_000],
  ['a signing-key name and blanks', 'private key', ' ', 'x', 50_000],
  ['a Terraform variable block', 'variable "token" {', ' ', '', 50_000],
  ['bare session cookies', '', 'a.sess=', 'x', 50_000],
];

/** Milliseconds of this thread's CPU time for one run: other processes on a busy host do not count against it. */
function cpuMs(run: () => unknown): number {
  const start = process.threadCpuUsage();
  run();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}

describe('a rule stays linear on one prefix and a long run of one character', () => {
  test.each(SHAPES)('%s', (_name, prefix, body, suffix, size) => {
    const at = (n: number) => prefix + body.repeat(n) + suffix;
    const full = at(size);
    let ms = cpuMs(() => redactSecrets(full));
    if (ms <= BUDGET_MS) return;
    // Over budget: fail only if it also grows faster than linearly (about 4x from a quarter of the run; a quadratic
    // rule about 16x), so a slow host or a stray pause cannot fail a linear rule.
    ms = Math.min(ms, cpuMs(() => redactSecrets(full)));
    const quarter = at(Math.floor(size / 4));
    const growth = ms / Math.max(Math.min(cpuMs(() => redactSecrets(quarter)), cpuMs(() => redactSecrets(quarter))), 0.1);
    expect(ms > BUDGET_MS && growth > 8, `${ms.toFixed(0)} ms, ${growth.toFixed(1)}x a quarter of the run`).toBe(false);
  });
});

test('the commands are still read with any run of blanks before their flags', () => {
  for (const [text, secret] of [
    ['curl  \t -sS -u admin:Wq8rT2zLm5 https://h', 'Wq8rT2zLm5'],
    ['curl   --user admin:Wq8rT2zLm5 https://h', 'Wq8rT2zLm5'],
    ['mysql \t -u root -pWq8rT2zLm5 db', 'Wq8rT2zLm5'],
    ['mysqldump   --password=Wq8rT2zLm5 db', 'Wq8rT2zLm5'],
    ['Server=db;Password=Wq8rT2zLm5;\nUser Id=sa', 'Wq8rT2zLm5'],
    ['Server=db; Password = Wq8rT2zLm5 \nnext', 'Wq8rT2zLm5'],
    ['api_key: str  =  "Wq8rT2zLm5"', 'Wq8rT2zLm5'],
    ['token: string | null = "Wq8rT2zLm5"', 'Wq8rT2zLm5'],
    ['kind: Secret\ndata:  \n\n  username: YWRtaW4=\n  password:   V3E4clQyekxtNQ==  \n', 'V3E4clQyekxtNQ=='],
  ]) expect(redactSecrets(text), text).not.toContain(secret);
});
