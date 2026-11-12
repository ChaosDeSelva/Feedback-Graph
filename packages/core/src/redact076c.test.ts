import { describe, expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';

/** Seeded fake values: a base64 run of any length (an STS session token is 400-1,000+ characters). */
const b64 = (n: number, seed = 7) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = seed;
  return Array.from({ length: n }, () => abc[(x = (x * 1103515245 + 12345) % 2147483648) % 64]).join('');
};
const hidden = (text: string, ...secrets: string[]) => {
  const out = redactSecrets(text);
  for (const secret of secrets) for (let i = 0; i + 12 <= secret.length; i += 6) expect(out, text.slice(0, 80)).not.toContain(secret.slice(i, i + 12));
  expect(redactSecrets(out)).toBe(out);
};
const kept = (text: string) => expect(redactSecrets(text)).toBe(text);

describe('a value longer than the lookaheads read after a credential name', () => {
  const forms = [(v: string) => `aws_session_token = ${v}`, (v: string) => `aws_session_token: ${v}`, (v: string) => `aws_session_token=${v}`,
    (v: string) => `SessionToken: ${v}`, (v: string) => `The session token is ${v}`, (v: string) => `client_secret = ${v}.`, (v: string) => `refresh_token=${v}&x=1`];
  test.each(forms.flatMap((f, i) => [256, 300, 1000, 4000].map((n) => [i, n, f] as const)))('form %i, %i characters', (_i, n, form) => {
    const v = 'IQoJb3JpZ2luX2Vj' + b64(n - 16, n);
    hidden(form(v), v);
  });
  test('a long identifier, letter run or path stays', () => {
    kept(`token = ${'abcdefghij_'.repeat(30)}end`);
    kept(`refresh_token=${'x'.repeat(300)}`);
    kept(`token: ${'a/'.repeat(150)}b.ts`);
  });
});

test('Sentry and Grafana Cloud tokens are redacted through their base64 + / and = padding', () => {
  const sentry = 'sntrys' + '_eyJpYXQiOjE3MDAwMDAwMDAsInVybCI6Imh0dHBzOi8vc2VudHJ5LmlvIiwib3JnIjoiYWNtZSJ9_XkCrvkjy0fSNzYcdL8+dLli08/FhEPXv=';
  hidden(`token=${sentry}`, sentry);
  hidden(`sentry token ${sentry}`, sentry);
  const grafana = `glc_${b64(80)}==`;
  hidden(`auth.token=${grafana}`, grafana);
});

describe('credential families', () => {
  const pw = 'Xq7#Lm2vR9tZpK4w';
  test.each([
    ['redis requirepass', `requirepass ${pw}`],
    ['redis masterauth, quoted', `masterauth "${pw}"`],
    ['redis CONFIG SET', `CONFIG SET requirepass ${pw}`],
    ['a YAML anchor before the value', `secret_key: &sk ${pw}`],
    ['a YAML tag before a quoted value', `api_token: !!str "${pw}"`],
    ['a key nested under what it is for', `encryption:\n  algorithm: aes-256-gcm\n  key: 6u1eL0xHGn9QaqOIrsRj4t+X/4+nqnLpmmFHNUHYspE=`, '6u1eL0xHGn9QaqOIrsRj4t+X/4+nqnLpmmFHNUHYspE='],
    ['ALTER ROLE … PASSWORD', `ALTER ROLE app_rw PASSWORD '${pw}';`],
    ['IDENTIFIED BY', `ALTER USER 'app'@'%' IDENTIFIED BY '${pw}';`],
    ['SET PASSWORD FOR', `SET PASSWORD FOR 'root'@'localhost' = '${pw}';`],
    ['a backticked flag', `run \`--token jJJFeRwbwXakSJrJnQNn6foCyxSD2YoYItq6\` once`, 'jJJFeRwbwXakSJrJnQNn6foCyxSD2YoYItq6'],
    ['a Terraform variable default', `variable "db_password" {\n  type = string\n  default = "${pw}"\n}`],
    ['a Kubernetes env name/value pair', `        - name: JWT_SECRET\n          value: "${pw}"`],
    ['an ECS env name/value pair', `{"name": "DB_PASSWORD", "value": "${pw}"}`],
    ['Makefile ?=', `DEPLOY_TOKEN ?= ${pw}`],
    ['Makefile ::=', `ADMIN_PASSWORD ::= ${pw}`],
    ['JavaScript ??=', `token ??= "${pw}";`],
    ['fish with a vendor NAME_KEY', 'set -gx MISTRAL_KEY QJeWKT17Y6q9K0su' + 'F9Nz7fqodGbBCN9i', 'QJeWKT17Y6q9K0suF9Nz7fqodGbBCN9i'],
    ['an OpenVPN auth block', `<auth-user-pass>\nvpnuser\n${pw}\n</auth-user-pass>`],
    ['escaped JSON inside JSON', `"config": "{\\"apiKey\\":\\"dbWiIqc0eEJMzgQ5GOr7DEfdEPeWMf9X\\",\\"region\\":\\"eu\\"}"`, 'dbWiIqc0eEJMzgQ5GOr7DEfdEPeWMf9X'],
    ['a quoted flag value starting with symbols', `--api-key '&*${pw}'`],
    ['letters in parts after a password name', 'spring.datasource.password=lVqgjkIfyGT_qHRt', 'lVqgjkIfyGT_qHRt'],
  ])('%s', (_name, text, secret = pw) => hidden(text, secret));

  test('a BIP-39 phrase given to a name for one', () => {
    const phrase = 'accident arena arctic argue adjust asset artwork anxiety abstract again angry above';
    hidden(`MNEMONIC="${phrase}"`, phrase);
    hidden(`seed phrase: "${phrase}"`, phrase);
    kept('mnemonic: "test test test test test test test test test test test junk"');
    kept('The mnemonic is used to derive every account and must be kept offline at all times.');
  });

  test('a JWT whose JSON has blanks is redacted whole', () => {
    const jwt = `${Buffer.from('{"alg": "HS256", "typ": "JWT"}').toString('base64url')}.${Buffer.from('{"sub": "x0ECUDwn", "iat": 1700000000}').toString('base64url')}.Li95atNTxy_jsDLc0_yLzgHxgsTU1bLajz9GKnpF1OE`;
    hidden(`token: ${jwt}`, jwt);
    const spaced = `${Buffer.from('{ "alg" : "RS256" }').toString('base64url')}.${Buffer.from('{ "sub" : "0phQPXBD" }').toString('base64url')}.Li95atNTxy_jsDLc0_yLzgHxgsTU1bLajz9GKnpF1OE`;
    hidden(`id=${spaced}`, spaced);
    kept('eyebrow.eyelid.eyeball and everything.everyone.everywhere');
  });

  test('vendor shapes: Adyen, Algolia, Terraform Cloud, RubyGems', () => {
    const adyen = `AQE${'glbm1tJKcJl0HnUnZSaNXjjrqssBkWyhW+6w9kZkJU11pmGBk3noGNbZ+/BHD/wteW7ByxkxlsfVsEYnfoo3==-'}${b64(43)}=-uZSjv3Fg0uF8KZ2c`;
    hidden(`new Client("${adyen}", Environment.TEST);`, adyen);
    hidden("algoliasearch('GV7KCXZM74', '6a4fbd759ba45efc" + "30384c2ad8e68a13');", '6a4fbd759ba45efc30384c2ad8e68a13');
    const tfc = `T36IfMPc2hPQrt.atlasv1.${b64(67).replace(/[+/]/g, 'x')}`;
    hidden(`credentials "app.terraform.io" { token = ${tfc} }`, tfc);
    hidden('gem push --key rubygems' + '_bf2b08853e7fc5871d65d09561337c607d953ad3c2ac3503', 'bf2b08853e7fc5871d65d09561337c607d953ad3c2ac3503');
    kept('rubygems_version = "3.4.10"');
  });

  test('a session cookie written bare, and a Netscape cookie-file line', () => {
    const sid = 's%3Ae4wGFVeOZ7KEffEvhdNaguuNUbW1wtbA.0131P2Uu1rVm2Q9QXVrhI5VO4SAxcFAnc8zp8uLl6GD';
    hidden(`connect.sid=${sid}`, sid);
    hidden(`curl -b connect.sid=${sid} https://x`, sid);
    hidden('PHPSESSID=vtyl8q7s9ppvxff8gkq2oqpa0b; path=/', 'vtyl8q7s9ppvxff8gkq2oqpa0b');
    hidden('#HttpOnly_.github.com\tTRUE\t/\tTRUE\t1767225600\tuser_session\t795f2802c88865383567875701e18e5bb866e271a7904cf34b0bedb358d9a838', '795f2802c88865383567875701e18e5bb866e271a7904cf34b0bedb358d9a838');
    for (const line of ['session=requests.Session()', 'sessionid=12345', '.example.com\tTRUE\t/\tFALSE\t0\ttheme\tdark', 'session_id=user_id']) kept(line);
  });

  test('a 0x private key after a name for a signing key; a hash, topic or slot stays', () => {
    const key = '2531180384761711a5d3f92468ec033d1026ce88755c0be28b3fb319c18b1e09';
    for (const text of [`my wallet private key 0x${key} (do not share)`, `PRIVKEY: 0x${key}`, `deployerKey: 0x${key}`, `const pk = '0x${key}';`, `signer key 0x${key}`]) hidden(text, key);
    for (const text of [`tx hash 0x${key}`, `blockHash: 0x${key}`, `storage key: 0x${key}`, `cacheKey: 0x${key}`]) kept(text);
  });

  test('code and prose near the new forms stay', () => {
    for (const line of ['requirepass foobared', 'masterauth <master-password>', 'secret_key: &default_secret_key', 'encryption:\n  key: ${ENCRYPTION_KEY}', 'cache:\n  key: user_profile_v2',
      "ALTER ROLE app_rw WITH LOGIN;", "ALTER USER 'app'@'%' IDENTIFIED BY PASSWORD '*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9';", 'CREATE LOGIN svc WITH PASSWORD = @password;',
      'Pass `--token <TOKEN>` to authenticate.', 'adds `--secret id=npmrc,env=NPM_TOKEN` when', 'variable "db_password" {\n  type      = string\n  sensitive = true\n}',
      '- name: DB_PASSWORD\n  value: $(DB_PASSWORD)', 'put_secret(name="demo-secret", data="next-value")', 'DEPLOY_TOKEN ?= $(shell cat .token)', 'password ??= getPassword();',
      '"{\\"nextPageToken\\":\\"CAoQAA\\"}"', 'set -gx CACHE_KEY user_profile']) kept(line);
    expect(redactSecrets('(`--password=Secret123!`) are')).toBe('(`--password=[REDACTED]`) are');
  });
});
