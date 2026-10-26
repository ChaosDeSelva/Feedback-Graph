import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { holdsCredential, redactSecrets, redactStoredFact, redactStoredRow, redactTokens } from './redact.ts';

test.each([
  ['openai project key', 'use this sk-p' + 'roj-AbCdEf0123456789_xyzXYZ-0123456789abcdef ok'],
  ['openai key', 'key sk-0123456789abcdefghijABCDEFGHIJ'],
  ['anthropic key', 'sk-' + 'ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'],
  ['stripe live', 'sk_l' + 'ive_51HxxxxxxxxxxxxxxxxxxxXX'],
  ['stripe restricted', 'rk_t' + 'est_51Hxxxxxxxxxxxxxxxxxxxx'],
  ['github pat', 'gh' + 'p_0123456789abcdefghijABCDEFGHIJ0123'],
  ['github fine-grained', 'githu' + 'b_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
  ['slack', 'xo' + 'xb-123456789012-abcdefghijkl'],
  ['aws access key', 'AK' + 'IAIOSFODNN7EXAMPLE'],
  ['google api key', 'AI' + 'zaSyA0123456789abcdefghijklmnopqrstu'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123_-xyz'],
  ['bearer', 'Authorization: Bearer abcdef0123456789abcdef0123'],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'],
  ['env assignment', 'DB_PASSWORD=hunter2EXAMPLE'],
  ['exported env secret', 'export STRIPE_SECRET_KEY="sk0123456789abcdefEXAMPLE"'],
  ['json password', '{"password": "correct-horse-EXAMPLE"}'],
  ['yaml token', 'api_token: "abcdefEXAMPLE42"'],
  ['url credentials', 'postgres://admin:s3cretEXAMPLE@db.internal:5432/app'],
  ['gitlab token', 'glp' + 'at-0123456789abcdefABCD'],
  ['hugging face token', 'h' + 'f_0123456789abcdefghijABCDEFGHIJklmn'],
  ['npm token', 'np' + 'm_0123456789abcdefghijABCDEFGHIJ012345'],
  ['linear key', 'lin_' + 'api_0123456789abcdefghijABCDEFGHIJ0123456789'],
])('%s is redacted', (_name, input) => {
  const out = redactSecrets(input);
  expect(out).toContain('[REDACTED]');
  expect(out).not.toMatch(/0123456789abcdef|EXAMPLE|MIIabc|abcDEF123|xxxxxxxx|AAAAAAAAAAAA/);
});

test('ordinary text is untouched', () => {
  const s = 'so is the only thing left prod sk_live_ ? also task-1234 and sk-learn';
  expect(redactSecrets(s)).toBe(s);
});

test('code that names a secret without holding one is untouched', () => {
  for (const s of [
    'password: z.string().min(8)',
    'const token = await getToken();',
    'NEO4J_PASSWORD: ${NEO4J_PASSWORD:?set it}',
    'API_KEY=$OPENAI_API_KEY',
    'see https://example.com/path@v2 and user@example.com',
  ]) expect(redactSecrets(s)).toBe(s);
});

test('the name of a redacted setting stays readable', () => {
  expect(redactSecrets('DB_PASSWORD=hunter2EXAMPLE')).toBe('DB_PASSWORD=[REDACTED]');
  expect(redactSecrets('postgres://admin:s3cretEXAMPLE@db:5432')).toBe('postgres://admin:[REDACTED]@db:5432');
});

test('redactDeep blanks values whose key names a secret, wherever they are nested', async () => {
  const { redactDeep } = await import('./redact.ts');
  expect(redactDeep({ password: 'hunter2xyz', nested: { apiKey: 'abcdefgh', clientSecret: 'zzzzzzzz' }, tokens: 5, title: 'password reset flow' })).toEqual({
    password: '[REDACTED]', nested: { apiKey: '[REDACTED]', clientSecret: '[REDACTED]' }, tokens: 5, title: 'password reset flow',
  });
});

test('a Feedback Graph Cloud token is redacted', () => {
  const t = `fgc_pat_0123456789abcdef_${'Zz09-_'.repeat(7)}a`;
  expect(redactSecrets(`token ${t} here`)).toBe('token [REDACTED] here');
});

// A fake secret value: long, mixed, nothing like a real token's prefix. Each line below must lose it.
const V = 'Q9x' + 'w'.repeat(12) + '7Zk';

test.each([
  ['ts const', `const AWS_SECRET_ACCESS_KEY = "${V}";`],
  ['ts export const', `export const stripeSecret = '${V}';`],
  ['ts let with a type', `let apiKey: string = "${V}"`],
  ['js var', `var GITHUB_TOKEN = \`${V}\`;`],
  ['ts object property', `  clientSecret: "${V}",`],
  ['ts this member', `this.authToken = '${V}';`],
  ['python module constant', `DB_PASSWORD = "${V}"`],
  ['python self member', `        self.password = '${V}'`],
  ['python typed', `api_key: str = "${V}"`],
  ['python keyword argument', `client = Client(api_key="${V}", region="eu")`],
  ['python dict', `creds = {"secret_key": "${V}"}`],
  ['go short assignment', `\tapiToken := "${V}"`],
  ['go const', `const signingKey = "${V}"`],
  ['go struct field', `\tPassword: "${V}",`],
  ['ruby', `config.secret_key_base = '${V}'`],
  ['php', `$dbPassword = "${V}";`],
  ['java', `private static final String PRIVATE_KEY = "${V}";`],
  ['yaml quoted', `  client_secret: "${V}"`],
  ['yaml unquoted', `  password: ${V}`],
  ['yaml dashed key', `api-key: ${V}`],
  ['json', `{ "accessToken": "${V}", "user": "acme" }`],
  ['env file', `JWT_SECRET=${V}`],
  ['shell export', `export SLACK_BOT_TOKEN="${V}"`],
  ['shell inline', `API_TOKEN=${V} pnpm start`],
  ['docker -e', `docker run -e DB_PASSWORD=${V} -p 5432:5432 postgres`],
  ['docker --env', `docker run --env=AUTH_TOKEN=${V} web`],
  ['cli flag', `mysql --user=root --password=${V} app`],
  ['cli flag with space', `deploy --token ${V} --env prod`],
  ['ini', `secret = ${V}`],
  ['curl header', `curl -H "X-Api-Key: ${V}" https://api.example.com`],
])('a secret in a %s line is redacted', (_name, line) => {
  const out = redactSecrets(line);
  expect(out).not.toContain(V);
  expect(out).toContain('[REDACTED]');
});

test('the name of a redacted code assignment stays readable', () => {
  expect(redactSecrets(`const AWS_SECRET_ACCESS_KEY = "${V}";`)).toBe('const AWS_SECRET_ACCESS_KEY = "[REDACTED]";');
  expect(redactSecrets(`\tapiToken := "${V}"`)).toBe('\tapiToken := "[REDACTED]"');
  expect(redactSecrets(`docker run -e DB_PASSWORD=${V} postgres`)).toBe('docker run -e DB_PASSWORD=[REDACTED] postgres');
});

test.each([
  'const tokenizer = new Tokenizer();',
  'const token = await getToken();',
  'let password: string;',
  'password: string | null;',
  'function login(user: string, password: string): Promise<Token> {',
  'const passwordHash = await bcrypt.hash(password, 10);',
  'const TOKEN_URL = "https://auth.example.com/oauth/token";',
  'const PASSWORD_MIN_LENGTH = 12;',
  'const ACCESS_TOKEN_KEY = "access_token";',
  "localStorage.setItem('auth-token', token);",
  'if (password === confirmPassword) return;',
  'api_key = os.environ["ACME_API_KEY"]',
  'self.password = password',
  'password = getpass.getpass("Password: ")',
  'token := os.Getenv("ACME_TOKEN")',
  'secret: ${{ secrets.DEPLOY_KEY }}',
  'password: "${DB_PASSWORD}"',
  'token: <your-token-here>',
  'export API_TOKEN="$ACME_TOKEN"',
  'docker run -e DB_PASSWORD -p 5432:5432 postgres',
  'const isTokenValid = (t: string) => t.length > 0;',
  'tokens: 1200, maxTokens: 4096',
  'secretName: db-credentials-v2',
  'passwordField: "password"',
  'type Secret = { name: string; value: string };',
  'The token budget is 4096 per call.',
  'Rotate the API key every 90 days.',
  'password reset emails expire after 24 hours',
])('ordinary code is untouched: %s', (s) => {
  expect(redactSecrets(s)).toBe(s);
});

test.each([
  ['the admin password is hunter2', 'hunter2'],
  ['The staging password is "Tr0ub4dor&3".', 'Tr0ub4dor'],
  ['pw: s3cr3t!x for the shared box', 's3cr3t'],
  ['wifi pwd: guest2026, ask at the desk', 'guest2026'],
  ['the api key is 7f3a9c2e1b, rotate it monthly', '7f3a9c2e1b'],
  ['The access key is 9fK2mQ7xL1 for the uploads bucket.', '9fK2mQ7xL1'],
  ['the secret is Zx9!qPw2 until Friday', 'Zx9!qPw2'],
  ['the db password was S3cure#Pass', 'S3cure#Pass'],
  ['The passphrase is blue-Horse-42.', 'blue-Horse-42'],
  ['The root password is Summer2026!', 'Summer2026'],
  ['the private key is 0x4f3a9c2e1b7d', '0x4f3a9c2e1b7d'],
  ['credentials are root:Pa55word9 on the test box', 'Pa55word9'],
  ['the token is a1b2c3d4e5f6a7b8', 'a1b2c3d4e5f6a7b8'],
  ['Deploy token was set to a1b2c3d4e5f6.', 'a1b2c3d4e5f6'],
  ['our api key is now k3y-for-acme', 'k3y-for-acme'],
])('a credential in prose is redacted: %s', (line, secret) => {
  const out = redactSecrets(line);
  expect(out).not.toContain(secret);
  expect(out).toContain('[REDACTED]');
});

test.each([
  'The password is hashed with bcrypt before it is stored.',
  'the token is valid for one hour',
  'The key is the project folder name.',
  'The secret is to cache the code map.',
  'the password is required and must be 12 characters',
  'The API key is read from ACME_API_KEY at start.',
])('prose about credentials that holds none is untouched: %s', (s) => {
  expect(redactSecrets(s)).toBe(s);
});

test('a large source file is redacted quickly', () => {
  const line = 'const fooBarBazQux = computeSomething(alpha_beta_gamma, delta.epsilon.zeta, "plain text value here"); // tokens: 42\n';
  const text = line.repeat(20_000);
  const t0 = performance.now();
  redactSecrets(text);
  expect(performance.now() - t0).toBeLessThan(2000);
});

test('known token shapes are redacted anywhere in a line', () => {
  for (const t of ['AS' + 'IA' + 'Z'.repeat(16), 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43), 'sh' + 'pat_' + 'f'.repeat(32), 'dop' + '_v1_' + 'e'.repeat(64)]) {
    expect(redactSecrets(`value ${t} end`)).toBe('value [REDACTED] end');
  }
});

// Facts are scanned from code, so their prose is full of database, cache, config and map keys, and of sentences about
// how a token or password is handled. None of it is a credential; v2's prose rule redacted it and closed the facts.
test.each([
  'The primary key is user_id2.',
  'Partition key is tenant_id1 for all tables',
  'The cache key is v2:users list',
  'key is config/app2.yml',
  'foreign key is account_id9',
  'The sort key was updatedAt2 until migration 0031.',
  'The cache key is now tenantId42 plus the route.',
  'The release key is v2026.10 for the tag.',
  'key = user_id2 in the join',
  'the key is 7f3a9c2e1b, rotate it monthly',
  'the token is refreshed every 5m',
  'the secret is stored in Vault',
  'password is required',
  'password is hashed with bcrypt',
  'token is a JWT',
  "key is the user's email",
  'The token is user_session2 in localStorage.',
  'The token is authToken2 in the Redux store.',
  'token is set to expire_at2 in the session row',
  'The password is v1.2.3-compatible.',
  'Pin is v18.20.4 in .nvmrc',
  'The secret is https://vault.example.com/v1/kv/web',
  'The token is sha256 hashed before storage.',
  'The password is hashed with argon2id before it is saved.',
  'The token is 40-char hex.',
  'The token is 1209600 seconds at most.',
])('a fact in prose that holds no credential is neither redacted nor a credential: %s', (s) => {
  expect(redactSecrets(s)).toBe(s);
  expect(holdsCredential(s)).toBe(false);
});

test('every line of the clean fixture (ordinary code, config and code-fact prose) comes through untouched', () => {
  const lines = readFileSync(new URL('./redact.clean.fixture.txt', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  expect(lines.length).toBeGreaterThan(300);
  expect(lines.filter((l) => redactSecrets(l) !== l)).toEqual([]);
});

test('a credential in prose or code still makes the fact a credential', () => {
  expect(holdsCredential('the admin password is hunter2')).toBe(true);
  expect(holdsCredential(`const API_KEY = "${V}";`)).toBe(true);
  // A model that already wrote [REDACTED] wrote around a credential.
  expect(holdsCredential('The staging password is [REDACTED].')).toBe(true);
});

test('redactTokens redacts known token shapes and URL credentials only', () => {
  const gh = 'gh' + 'p_' + 'x'.repeat(36);
  expect(redactTokens(`the admin password is hunter2 and ${gh}`)).toBe('the admin password is hunter2 and [REDACTED]');
  expect(redactTokens('postgres://admin:s3cretEXAMPLE@db:5432')).toBe('postgres://admin:[REDACTED]@db:5432');
});

describe('redactStoredFact (the startup re-run over stored facts)', () => {
  const fact = (statement: string, o: { origin?: string | null; current?: boolean; why?: string | null } = {}) =>
    ({ statement, why: o.why ?? null, current: o.current ?? true, origin: o.origin === undefined ? 'model' : o.origin });

  test('ordinary prose v2 redacted is left alone and stays served', () => {
    for (const s of ['The primary key is user_id2.', 'The cache key is v2:users list', 'password is hashed with bcrypt']) {
      expect(redactStoredFact(fact(s))).toEqual({ statement: s, why: null, close: false });
    }
  });

  test('a model fact that is a credential is redacted and closed', () => {
    expect(redactStoredFact(fact('the admin password is hunter2', { why: 'the README says the password is hunter2' })))
      .toEqual({ statement: 'the admin password is [REDACTED]', why: 'the README says the password is [REDACTED]', close: true });
    expect(redactStoredFact(fact('the admin password is hunter2', { origin: null })).close).toBe(true);
  });

  test('a fact that is no longer served is redacted but not closed again', () => {
    expect(redactStoredFact(fact('the admin password is hunter2', { current: false }))).toEqual({ statement: 'the admin password is [REDACTED]', why: null, close: false });
  });

  test('text an older rule already redacted is not closed by the re-run: only a rule that matches now closes', () => {
    expect(redactStoredFact(fact('The primary key is [REDACTED].'))).toEqual({ statement: 'The primary key is [REDACTED].', why: null, close: false });
  });

  test("an owner's fact (origin you) is never closed; only a known token shape is redacted in place", () => {
    const gh = 'gh' + 'p_' + 'x'.repeat(36);
    expect(redactStoredFact(fact('the admin password is hunter2', { origin: 'you' })))
      .toEqual({ statement: 'the admin password is hunter2', why: null, close: false });
    expect(redactStoredFact(fact(`CI pushes with ${gh}`, { origin: 'you' }))).toEqual({ statement: 'CI pushes with [REDACTED]', why: null, close: false });
  });
});

test.each([
  ['quoted value that names a secret, with a version', `const REFRESH_TOKEN_KEY = 'refresh_token_v2';`],
  ['env value read from the environment', 'SECRET_KEY = os.environ.get("SECRET_KEY")'],
  ['yaml tag', 'password: !vault |'],
  ['json schema type', '"apiKey": "string",'],
  ['env value that names a secret', 'TOKEN_KEY = "acme.token"'],
  ['env name that only contains a secret word', 'AUTH_TOKEN_ISSUER=acme-web'],
  ['env url', 'TOKEN_URL=https://auth.example.com/oauth/token'],
  ['yaml identifier value', 'token: refresh_token_v2'],
  ['k8s secret name', 'secret: acme-web-secret-v2'],
])('a code rule leaves alone a %s', (_name, s) => {
  expect(redactSecrets(s)).toBe(s);
});

describe('redactStoredRow (re-running the rules over a stored row)', () => {
  test('returns the whole row with its text and JSON fields redacted, keeping each JSON field in its stored form', () => {
    const row = { id: 'a1', subject: 'deploy said the password is hunter2', why: 'clean', detailsText: JSON.stringify({ cmd: `API_TOKEN=${V}`, n: 3 }), details: { password: 'x'.repeat(8), ok: 'yes' } };
    expect(redactStoredRow(row, ['subject', 'why'], ['detailsText', 'details'])).toEqual({
      id: 'a1', subject: 'deploy said the password is [REDACTED]', why: 'clean',
      detailsText: JSON.stringify({ cmd: 'API_TOKEN=[REDACTED]', n: 3 }), details: { password: '[REDACTED]', ok: 'yes' },
    });
  });

  test('null when nothing changes; nulls and unreadable JSON text are handled', () => {
    expect(redactStoredRow({ id: 'a', t: 'The primary key is user_id2.', j: null, k: '{"a":1}' }, ['t'], ['j', 'k'])).toBeNull();
    expect(redactStoredRow({ id: 'a', j: 'not json, password is hunter2' }, [], ['j'])).toEqual({ id: 'a', j: 'not json, password is [REDACTED]' });
  });
});
