import { describe, expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';

const hidden = (text: string, secret: string) => {
  const redacted = redactSecrets(text);
  expect(redacted).toContain('[REDACTED]');
  expect(redacted).not.toContain(secret);
  expect(redactSecrets(redacted)).toBe(redacted);
};

describe('0.7.1 held-out credential forms', () => {
  test('AWS 40-character secrets with plus but no slash are caught without a label', () => {
    const secret = 'aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV+wXyZabc';
    expect(secret).toHaveLength(40);
    hidden(`AKIA${'A'.repeat(16)},${secret},us-east-1`, secret);
    hidden(`received ${secret} from the helper`, secret);
  });

  test.each([
    ['mysqldump -p', 'mysqldump -u root -pDumpPass9 db', 'DumpPass9'],
    ['curl --user', 'curl --user admin:CurlPass9 https://example.test', 'CurlPass9'],
    ['docker login -p', 'docker login -u robot -p DockerPass9 registry.test', 'DockerPass9'],
    ['sshpass -p', "sshpass -p 'SshPass9' ssh host", 'SshPass9'],
    ['redis-cli -a', 'redis-cli -h cache -a RedisPass9 ping', 'RedisPass9'],
    ['Okta SSWS', `Authorization: SSWS ${'Ab9_'.repeat(10)}`, 'Ab9_'.repeat(10)],
    ['Square', `token sq0csp-${'Ab9_'.repeat(8)}`, `sq0csp-${'Ab9_'.repeat(8)}`],
    ['Atlassian', `token ATATT${'Ab9_'.repeat(8)}`, `ATATT${'Ab9_'.repeat(8)}`],
    ['Figma', `token figd_${'Ab9_'.repeat(8)}`, `figd_${'Ab9_'.repeat(8)}`],
    ['Notion', `token ntn_${'Ab9_'.repeat(8)}`, `ntn_${'Ab9_'.repeat(8)}`],
    ['Postman', `token PMAK-${'Ab9_'.repeat(8)}`, `PMAK-${'Ab9_'.repeat(8)}`],
    ['GitLab agent', `token glsa_${'Ab9_'.repeat(8)}`, `glsa_${'Ab9_'.repeat(8)}`],
    ['Telegram bot', `bot 123456789:${'Ab9_'.repeat(10)}`, `123456789:${'Ab9_'.repeat(10)}`],
    ['npmrc auth', `_auth=${Buffer.from('alice:NpmPass9').toString('base64')}`, Buffer.from('alice:NpmPass9').toString('base64')],
    ['Kubernetes data.password', `apiVersion: v1\nkind: Secret\ndata:\n  password: ${Buffer.from('KubePass9').toString('base64')}`, Buffer.from('KubePass9').toString('base64')],
    ['XML password', '<password>XmlPass9</password>', 'XmlPass9'],
    ['requests auth tuple', `requests.get(url, auth=('alice', 'PythonPass9'))`, 'PythonPass9'],
    ['WordPress tilde salt', `define('AUTH_SALT', '~${'Ab9!'.repeat(8)}');`, `~${'Ab9!'.repeat(8)}`],
    ['WordPress slash salt', `define('NONCE_SALT', '/${'Ab9!'.repeat(8)}');`, `/${'Ab9!'.repeat(8)}`],
  ])('%s is redacted', (_name, text, secret) => hidden(text, secret));

  test.each([
    ['unterminated PEM', `-----BEGIN ${'PRIVATE'} KEY-----\n${'AbCdEf0123456789+/'.repeat(4)}\n${'QrStUv9876543210+/'.repeat(4)}\n`],
    ['PEM with headers', `-----BEGIN RSA ${'PRIVATE'} KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n\n${'AbCdEf0123456789+/'.repeat(4)}\n`],
    ['YAML-indented PEM', `private_key: |\n  -----BEGIN ${'PRIVATE'} KEY-----\n  ${'AbCdEf0123456789+/'.repeat(4)}\n  ${'QrStUv9876543210+/'.repeat(4)}\n`],
    ['JSON-escaped PEM', `{"key":"-----BEGIN ${'PRIVATE'} KEY-----\\n${'AbCdEf0123456789+/'.repeat(4)}\\n${'QrStUv9876543210+/'.repeat(4)}\\n"}`],
  ])('%s is removed as one block before fragment rules run', (_name, text) => {
    const out = redactSecrets(text);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('AbCdEf');
    expect(out).not.toContain('QrStUv');
  });
});

describe('0.7.1 redaction false-positive guards', () => {
  test.each([
    `integrity=sha512-${'Ab3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uVwXyZaBc'}`,
    `code_challenge=${'Ab3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uVwXyZaBc'}`,
    'u.password = settings.authentication.password,',
    'joinUrl += "?pwd={meeting_password}"',
    'maxBufferedOrderedResultWindowSlotsLen+1',
    'password = "password"',
  ])('keeps ordinary source/config text: %s', text => expect(redactSecrets(text)).toBe(text));

  test('a random secret that happens to look camel-cased is still redacted', () => {
    const secret = 'aVeryRandomSecretLikeValueWith9DigitsAbC';
    expect(secret).toHaveLength(40);
    hidden(`received ${secret}`, secret);
  });
});
