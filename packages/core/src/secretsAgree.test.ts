import { expect, test } from 'vitest';
import { isSecretPath, SECRET_DENY_GLOBS } from './secrets.ts';

/** A deny glob as a matcher with dotfiles included (picomatch's dot: true): ** spans folders, * and ? one name, [..] a set. */
const glob = (g: string) => new RegExp(`^${g.split('**/').map((a) => a.split('**').map((b) => b.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  .replace(/\?/g, '[^/]')).join('.*')).join('(?:.*/)?')}$`);
const GLOBS = SECRET_DENY_GLOBS.map(glob);
const denied = (path: string) => GLOBS.some((re) => re.test(path));

/**
 * The scanner (isSecretPath) and Claude Code's Read() deny rules (SECRET_DENY_GLOBS) must agree on every path: a file only
 * one of them refuses is read by the other. Each path is tried as given and under a home folder.
 */
const DENIED = [
  '.env', '.env.local', 'app/.env.production', 'config/prod.env', '.envrc', '.dev.vars', 'prod.env.sh', 'secrets.sh', 'scripts/secrets.ps1', 'passwords.bat',
  '.ssh/id_rsa', '.ssh/id_ed25519', '.ssh/id_ecdsa_sk', '.ssh/id_ed25519_sk', '.ssh/id_rsa_work', 'deploy/key.pem', 'certs/server.key', 'certs/client.p12', 'certs/client.pfx',
  'android/release.keystore', 'android/release.jks', 'login.ppk', 'private.gpg', 'vault/master.agekey', 'deploy/signing.p8', 'vpn/client.ovpn',
  'infra/terraform.tfstate', 'infra/terraform.tfstate.backup', 'infra/prod.tfvars', 'infra/prod.auto.tfvars.json', 'infra/terraform.tfvars.json', '.terraformrc', 'terraform.rc',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', 'pip.conf', '.netrc', '_netrc', '.git-credentials', '.git/config', '.gem/credentials', '.bundle/config', '.bunfig.toml',
  '.m2/settings.xml', '.m2/settings-security.xml', 'gradle.properties', '.sbt/1.0/credentials.sbt', '.sbt/.credentials', '.ivy2/.credentials',
  'NuGet.Config', 'nuget.config', '.nuget/NuGet/NuGet.config', 'AppData/Roaming/NuGet/NuGet.Config',
  '.config/pypoetry/auth.toml', 'Library/Application Support/pypoetry/auth.toml', '.config/helm/repositories.yaml', 'Library/Preferences/helm/repositories.yaml',
  '.kaggle/kaggle.json', '.config/kaggle/kaggle.json', '.cache/huggingface/token', '.cache/huggingface/stored_tokens', '.huggingface/token',
  '.config/github-copilot/hosts.json', '.config/github-copilot/apps.json', '.aws/config', '.aws/credentials', '.aws/sso/cache/abc.json', '.aws/cli/cache/0f3c.json',
  '.azure/accessTokens.json', '.azure/msal_token_cache.json', '.config/gcloud/application_default_credentials.json', '.config/gcloud/credentials.db',
  '.config/gcloud/access_tokens.db', '.config/gcloud/legacy_credentials/me/adc.json', '.kube/config', 'config/kubeconfig', 'prod-kubeconfig.yaml', '.docker/config.json', '.dockercfg',
  'deploy/service-account.json', 'gcp_service_account_prod.json', '.mcp.json', '.pgpass', '.my.cnf', '.s3cfg', '.boto', '.vault-token', '.vault_pass', 'deploy/vault.yml',
  '.config/gh/hosts.yml', '.config/hub', '.config/fly/config.yml', '.config/stripe/config.toml', '.config/doctl/config.yaml', '.config/op/config', '.snowsql/config',
  '.ngrok2/ngrok.yml', '.config/ngrok/ngrok.yml', '.wakatime.cfg', '.jfrog/jfrog-cli.conf.v6', '.config/configstore/snyk.json', '.talos/config', '.config/argocd/config',
  '.doppler/.doppler.yaml', 'sops/age/keys.txt', '.sentryclirc', '.databrickscfg', 'rclone.conf', '.htpasswd', 'nginx/htpasswd', 'backup/passwords.kdbx', 'vault.kdbx',
  'wg0.conf', 'etc/wireguard/office.conf', '.local/share/keyrings/login.keyring',
  '.mozilla/firefox/abc.default/logins.json', '.mozilla/firefox/abc.default/key4.db', '.mozilla/firefox/abc.default/cookies.sqlite',
  'Library/Application Support/Google/Chrome/Default/Cookies', 'Library/Application Support/Google/Chrome/Default/Login Data',
  'client_secret.json', 'config/secrets.prod.yaml', 'config/db-password.txt', 'aws/credentials', '.secrets', 'vault/credentials.db', 'appsettings.Production.json', 'wp-config.php',
  'deploy/id_rsa', 'keys/id_ed25519_sk', 'ci/id_ecdsa_deploy', '.ssh/id_rsa.pub', '.ssh/id_github', '.gemini/oauth_creds.json', '.config/vault/token',
];
const READABLE = [
  'src/env.ts', 'README.md', 'src/keyboard.ts', 'docs/identity.md', 'secrets.py', 'app/password_reset.ts', 'src/credentials/manager.go', 'lib/secret_store.rb',
  'docs/rotating-secrets.md', 'scripts/rotate-secrets.sh', 'bin/load-credentials.ps1', 'src/vite-env.d.ts', 'scripts/env.sh', 'docs/ngrok.yml', '.circleci/config.yml',
  '.fly/launch.toml', '.supabase/seed.sql', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'bunfig.toml', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'poetry.lock',
  'charts/app/values.yaml', 'charts/app/Chart.yaml', 'helm/repositories.md', 'src/cookies.ts', 'src/cookie-banner.tsx', 'docs/cookies.md', 'src/login/LoginData.tsx',
  'src/login_data.py', 'kaggle/notebook.ipynb', 'src/huggingface/client.py', 'docs/nuget.md', 'build/NuGet.targets', 'src/auth/token.ts', 'src/token_counter.py',
  'infra/main.tf', 'infra/variables.tf', 'infra/outputs.tf', 'docs/terraform.md', 'src/wireguard.go', 'docs/wg-setup.md', 'src/keyrings.ts', 'src/keys.ts', 'src/apikey.ts',
  'Dockerfile', 'docker-compose.yml', '.github/workflows/ci.yml', '.gitignore', '.editorconfig', 'src/htpasswd.go', 'docs/kdbx.md', 'src/sbt/Build.scala', 'build.sbt',
  'project/plugins.sbt', 'src/main/resources/application.yml', 'src/logins.ts', 'test/fixtures/data.json', '.vscode/settings.json', '.idea/workspace.xml',
  'src/id_utils.ts', 'src/id_generator.py', 'lib/id_token.rb', 'internal/id_map.go', 'trace/id_generator.go', 'deploy/id_rsa.pub', 'docs/gemini.md', 'src/vault/token.ts',
];
const AT = ['', 'home/me/'];

test.each(DENIED.flatMap((p) => AT.map((at) => at + p)))('a credential file is refused by the scanner and by Claude: %s', (path) => {
  expect(isSecretPath(path)).toBe(true);
  expect(denied(path)).toBe(true);
});

test.each(READABLE.flatMap((p) => AT.map((at) => at + p)))('a project file is read by both: %s', (path) => {
  expect(isSecretPath(path)).toBe(false);
  expect(SECRET_DENY_GLOBS.filter((_, i) => GLOBS[i].test(path))).toEqual([]);
});

/** A path in upper case and in alternating case: .ENV, .Env.LoCaL. */
const RECASED = DENIED.flatMap((p) => [p.toUpperCase(), [...p].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('')]).filter((p) => !DENIED.includes(p));

test.each(RECASED)('a credential file in another case is refused by both, as a case-insensitive filesystem opens it: %s', (path) => {
  expect(isSecretPath(path)).toBe(true);
  expect(denied(path)).toBe(true);
});
