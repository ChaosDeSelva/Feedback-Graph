import { expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';

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
