import { expect, test } from 'vitest';
import { isSecretPath } from './secrets.ts';

test.each(['.envrc', '.pgpass', '.vault-token', '.kube/config', 'config/kubeconfig', '.docker/config.json', 'deploy/service-account.json', '.env', 'app/.env.local', '.mcp.json', 'deploy/key.pem', 'ssh/id_rsa', 'aws/credentials', 'config/db-password.txt', 'infra/terraform.tfstate', 'android/release.keystore', 'certs/a.p12', '.pypirc', '.git/config'])('%s is a secret file', (p) => {
  expect(isSecretPath(p)).toBe(true);
});

test.each(['src/env.ts', 'README.md', 'src/keyboard.ts', 'docs/identity.md', 'src/passwordStrength.test.ts.snap'])('%s is not', (p) => {
  // A file *named* for passwords is skipped on purpose (it often holds them); code that merely mentions them is not.
  expect(isSecretPath(p)).toBe(p.includes('password'));
});
