import { expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';

const hidden = (text: string, secret: string) => {
  const out = redactSecrets(text);
  expect(out).toContain('[REDACTED]');
  expect(out).not.toContain(secret);
  expect(redactSecrets(out)).toBe(out);
};

const notion = `secret_${'Qm7tXz2Lw9Rb4Kc8Np3Hs6Vd1Fg5Jy0Ae'}${'Wu4Ti7Oq2s'}`;
const fcm = `AAAAq7Wd1Xz:APA91b${'Hk3Lp9Qr2Vt8Wy5Zb1Cd7Fg4Jm6Ns0'.repeat(4)}`;

test.each([
  [`client = Client(auth="${notion}")`, notion.slice(7)],
  ['SENTRY_DSN=https://7c1e9a4b2d8f6053' + '1a9e7c4d2b6f8a01@o98765.ingest.sentry.io/4455667', '7c1e9a4b2d8f60531a9e7c4d2b6f8a01'],
  ['dsn: "https://7c1e9a4b2d8f6053' + '1a9e7c4d2b6f8a01@sentry.internal.example/12"', '7c1e9a4b2d8f60531a9e7c4d2b6f8a01'],
  ['sudo tailscale up --authkey tskey' + '-auth-kQ2wE4rT6CNTRL-Zx9Vb7Nm5Lk3Jh1Gf8Ds6Aq4Wp2', 'Zx9Vb7Nm5Lk3Jh1Gf8Ds6Aq4Wp2'],
  ['ALIBABA_CLOUD_ACCESS_KEY_ID=LTAI' + '9xQ2mW7rZk4Tb8Vn', 'LTAI' + '9xQ2mW7rZk4Tb8Vn'],
  [`FCM_SERVER_KEY=${fcm}`, fcm.slice(20)],
  ['htpasswd -b -c /etc/nginx/.htpasswd deploy Kp4!wQz9Rm', 'Kp4!wQz9Rm'],
  ['htpasswd -c -b conf/users ops "Kp4!wQz9Rm"', 'Kp4!wQz9Rm'],
  ['htpasswd -Bbc conf/users ops Kp4!wQz9Rm', 'Kp4!wQz9Rm'],
  ['mongosh "mongodb://db:27017" --username root -p Kp4wQz9Rm%x', 'Kp4wQz9Rm%x'],
  ['mongodump --uri mongodb://db --password=Kp4wQz9Rm%x', 'Kp4wQz9Rm%x'],
  ['net user backup_svc Kp4wQz9Rm%x /add /y', 'Kp4wQz9Rm%x'],
  ['NET USER "Backup Svc" Kp4wQz9Rm%x', 'Kp4wQz9Rm%x'],
  ['use token Hq3Zt8Wm1Rx6Lb9Kd4Vy7Np2 for the release bot', 'Hq3Zt8Wm1Rx6Lb9Kd4Vy7Np2'],
  ['log in with password Kp4wQz9Rm%x then rotate it', 'Kp4wQz9Rm%x'],
])('0.7.6 a vendor, command or prose credential is redacted: %s', (text, secret) => hidden(text, secret));

test.each([
  'x = s.AbCdEfGhIjKlMnOpQrStUv12',
  'const y = s.readmeGeneratorConfigFile99;',
  'mailchimp etag 5d41402abc4b2a76b9' + '719d911017c592-us2',
  'Mailchimp campaign cache 5d41402abc4b2a76b9' + '719d911017c592-us2 expired',
  '--registry-password="::add-mask::$secrets.DOCKER_PASSWORD"',
  'type OpeningBraceToken = OpeningBraceToken$1;',
  'secret_key_base_for_the_test_environment_only',
  'net user backup_svc /domain',
  'net user admin *',
  'mongosh --port 27017 -p',
  'htpasswd -n deploy',
  'use token authentication for the API',
  'pass token through to the next handler',
  'https://github.com/org/repo@main',
  'psk = settings.network.psk',
  'let password = rpassword::read_password()?;',
])('0.7.6 code and prose near those forms stay: %s', (line) => expect(redactSecrets(line)).toBe(line));

test('0.7.6 a Vault s. token is still redacted when its characters are random', () => {
  hidden('VAULT_TOKEN s' + '.Xq3Lp9Zw2Rb7Km4Tn8Vc1Hd6 to log in', 'Xq3Lp9Zw2Rb7Km4Tn8Vc1Hd6');
});

test.each([
  'net user Administrator | Select-String "active"',
  'net user jdoe && whoami',
  'net user "%USER%" | findstr Last',
  'net user $env:USERNAME | findstr Last',
  'mongosh admin --password | tee log',
  'mongosh --password # will prompt',
  'mongosh -p && echo ok',
  'mongodump --password > dump.log',
  'mongo --password -- db',
  'mongosh $URI --password --quiet',
  'htpasswd -b .htpasswd user | tee out',
])('0.7.6 a shell operator or the next flag after a value-less command is not its password: %s', (line) => expect(redactSecrets(line)).toBe(line));
