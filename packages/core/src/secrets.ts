/**
 * Extensions of data files. A file named for secrets, credentials or passwords is a credential file when it has one
 * of these or none (aws/credentials, client_secret.json, db-password.txt); source such as secrets.py or
 * password_reset.ts is code about them.
 */
const DATA_EXTS = ['json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'txt', 'env', 'conf', 'cfg', 'cnf', 'properties', 'xml', 'plist', 'csv', 'tsv', 'dat', 'db', 'sqlite', 'enc', 'age', 'asc', 'bak', 'backup', 'old', 'kdbx', 'keychain', 'vars', 'cred', 'creds', 'list', 'gz', 'zip', 'tgz', 'sbt'];
const NAMED = ['secret', 'credential', 'password'];
/**
 * Script extensions. A script named for the secrets themselves (secrets.sh, .credentials.ps1, passwords.bat) or an env
 * file in script form (prod.env.sh) exports values, so it is data; one named for what it does to them
 * (rotate-secrets.sh, load-credentials.ps1) is code and is read.
 */
const SCRIPT_EXTS = ['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd'];

/** Files that hold credentials. The scanner never reads them and agent CLIs are denied them; one list for both. */
export const SECRET_FILE =
  new RegExp(String.raw`(^|\/)(integrations\.json|worker\.sqlite(?:-(?:wal|shm|journal))?|project-roots\.json|neo4j\.dump|rclone\.conf|codex-auth\.json|\.run-key-salt|auth\.json|\.vault_pass|vault\.ya?ml|[^/]*firebase-adminsdk-[^/]*\.json|\.env(\..*)?|[^/]*\.env(?:\.(?:${SCRIPT_EXTS.join('|')}))?|\.?(?:${NAMED.join('|')})s?\.(?:${SCRIPT_EXTS.join('|')})|\.dev\.vars|[^/]*\.ppk|[^/]*\.tfstate(?:\.[^/]*)?\.backup|pip\.conf|\.yarnrc(?:\.yml)?|[^/]*\.gpg|appsettings\.(?:Production|Staging|Development)\.json|wp-config\.php|local_settings\.py|gradle\.properties|\.m2\/settings\.xml|\.config\/hub|\.ngrok2\/ngrok\.ya?ml|\.git-credentials|\.htpasswd|\.my\.cnf|\.s3cfg|\.boto|\.terraformrc|terraform\.rc|\.aws\/(?:config|sso\/cache\/[^/]+\.json)|\.azure\/(?:accessTokens\.json|msal_token_cache[^/]*)|\.config\/gcloud\/(?:application_default_credentials\.json|credentials\.db|access_tokens\.db|legacy_credentials\/[^/]+\/[^/]+)|\.config\/gh\/hosts\.ya?ml|\.config\/(?:doctl|fly|flyctl|firebase|stripe|ngrok|circleci|glab|supabase|railway|hcloud|linode)\/[^/]+|\.snowsql\/config|\.config\/op\/config|\.gem\/credentials|\.bundle\/config|Library\/Application Support\/(?:doctl|flyctl|1Password)\/[^/]+|[^/]*\.(?:p8|ovpn|agekey)|\.envrc|\.pgpass|\.vault-token|(?:[^/]*[-_])?kubeconfig(?:\.[^/]*)?|\.kube\/config|\.docker\/config\.json|\.dockercfg|sops\/age\/keys\.txt|\.sentryclirc|\.databrickscfg|[^/]*service[-_]account[^/]*\.json|\.mcp\.json|\.npmrc|\.netrc|_netrc|\.fly\/config\.yml|\.op\/config|\.circleci\/cli\.yml|\.supabase\/access-token|\.railway\/config\.json|\.netlify\/config\.json|(?:\.config|Library\/Preferences)\/netlify\/config\.json|(?:\.config\/|Library\/Preferences\/)?\.wrangler\/config\/[^/]+\.toml|\.oci\/(?:config|sessions\/.+)|\.twilio-cli\/config\.json|\.cloudflared\/[^/]+\.json|\.config\/scw\/config\.ya?ml|\.pypirc|\.git\/config|\.ssh\/id_[^/]+|id_(?:rsa|dsa|ecdsa|ed25519)(?:_[^/]*)?|\.gemini\/oauth_creds\.json|\.config\/vault\/token|[^/]*\.(pem|key|p12|pfx|tfvars|tfvars\.json|tfstate|keystore|jks|kdbx)|(?:\.config|Library\/Application Support)\/pypoetry\/auth\.toml|(?:\.config|Library\/Preferences)\/helm\/repositories\.ya?ml|(?:\.kaggle|\.config\/kaggle)\/kaggle\.json|\.cache\/huggingface\/(?:token|stored_tokens)|\.huggingface\/token|\.config\/github-copilot\/(?:hosts|apps)\.json|nuget\.config|\.aws\/cli\/cache\/[^/]+\.json|cookies\.sqlite|logins\.json|key[34]\.db|signons\.sqlite|Cookies|Login Data(?: For Account)?|\.wakatime\.cfg|\.jfrog\/jfrog-cli\.conf(?:\.v\d+)?|\.config\/configstore\/snyk\.json|\.m2\/settings-security\.xml|\.talos\/config|\.config\/argocd\/config|\.doppler\/\.doppler\.ya?ml|\.bunfig\.toml|wg\d[^/]*\.conf|wireguard\/[^/]+\.conf|htpasswd|\.local\/share\/keyrings\/[^/]+\.keyring|[^/]*(?:${NAMED.join('|')})[^/]*\.(?:${DATA_EXTS.join('|')})|\.?[^/.]*(?:${NAMED.join('|')})s?)$`, 'i');

export const isSecretPath = (path: string) => { const normalized = path.replaceAll('\\', '/'); return /(?:^|\/)(?:redaction-archive|redaction-key)(?:\/|$)/i.test(normalized) || /(?:^|\/)backups\/(?:[^/]+\/)*(?:state\.tgz|[^/]*\.dump)$/i.test(normalized) || /(?:^|\/)(?:\.config\/(?:glab-cli|linode-cli)(?:\/|$)|\.config\/configstore\/(?:firebase-tools|doctl|flyctl)\.json$|Library\/Application Support\/(?:1Password|ngrok)(?:\/|$))/i.test(normalized) || SECRET_FILE.test(normalized); };

/** The same files as SECRET_FILE, as globs for Claude Code's Read() deny rules. */
export const SECRET_GLOBS = [
  '**/integrations.json', '**/worker.sqlite', '**/worker.sqlite-wal', '**/worker.sqlite-shm', '**/worker.sqlite-journal', '**/project-roots.json', '**/neo4j.dump', '**/rclone.conf', '**/codex-auth.json', '**/.run-key-salt', '**/auth.json', '**/.vault_pass', '**/vault.yml', '**/vault.yaml', '**/*firebase-adminsdk-*.json', '**/backups/**/state.tgz', '**/backups/**/*.dump',
  '**/.dev.vars', '**/*.ppk', '**/*.tfstate.backup', '**/*.tfstate.*.backup', '**/pip.conf', '**/.yarnrc', '**/.yarnrc.yml', '**/*.gpg', '**/appsettings.Production.json', '**/appsettings.Staging.json', '**/appsettings.Development.json', '**/wp-config.php', '**/local_settings.py',
  '**/.git-credentials', '**/.htpasswd', '**/.my.cnf', '**/.s3cfg', '**/.boto', '**/.terraformrc', '**/terraform.rc',
  '**/.aws/config', '**/.aws/sso/cache/*.json', '**/.azure/accessTokens.json', '**/.azure/msal_token_cache*',
  '**/.config/gcloud/application_default_credentials.json', '**/.config/gcloud/credentials.db', '**/.config/gcloud/access_tokens.db',
  '**/.config/gh/hosts.yml', '**/.config/gh/hosts.yaml', '**/.config/hub', '**/.m2/settings.xml', '**/gradle.properties', '**/.gem/credentials', '**/.bundle/config', '**/*.p8', '**/*.ovpn', '**/*.agekey', '**/.dockercfg', '**/sops/age/keys.txt', '**/.sentryclirc', '**/.databrickscfg',
  '**/.config/doctl/**', '**/.config/fly/**', '**/.config/firebase/**', '**/.snowsql/config', '**/.config/op/config',
  '**/.config/flyctl/**', '**/.config/stripe/**', '**/.config/ngrok/**', '**/.config/circleci/**', '**/.config/glab/**', '**/.config/supabase/**', '**/.config/railway/**', '**/.config/hcloud/**', '**/.config/linode/**', '**/.config/gcloud/legacy_credentials/**', '**/Library/Application Support/doctl/**', '**/Library/Application Support/flyctl/**',
  '**/.config/configstore/firebase-tools.json', '**/.config/configstore/doctl.json', '**/.config/configstore/flyctl.json',
  '**/.config/glab-cli/**', '**/.config/linode-cli/**', '**/Library/Application Support/1Password/**', '**/Library/Application Support/ngrok/**',
  '**/.fly/config.yml', '**/.op/config', '**/.circleci/cli.yml', '**/.supabase/access-token', '**/.railway/config.json', '**/.config/linode-cli',
  '**/_netrc', '**/.netlify/config.json', '**/.config/netlify/config.json', '**/Library/Preferences/netlify/config.json', '**/.wrangler/config/*.toml', '**/.config/.wrangler/config/*.toml',
  '**/Library/Preferences/.wrangler/config/*.toml', '**/.oci/config', '**/.oci/sessions/**', '**/.twilio-cli/config.json', '**/.cloudflared/*.json', '**/.config/scw/config.yml', '**/.config/scw/config.yaml',
  '**/.env*', '**/.pgpass', '**/.vault-token', '**/*kubeconfig*', '**/.kube/config', '**/.docker/config.json', '**/*service-account*.json', '**/*service_account*.json', '**/.mcp.json', '**/.npmrc', '**/.netrc', '**/.pypirc', '**/.git/config',
  // An SSH key by where it lives or by its algorithm's name, not any file named id_ (src/id_utils.ts).
  '**/.ssh/id_*', ...['rsa', 'dsa', 'ecdsa', 'ed25519'].flatMap((a) => [`**/id_${a}`, `**/id_${a}_*`]), '**/.gemini/oauth_creds.json', '**/.config/vault/token',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.tfvars', '**/*.tfvars.json', '**/*.tfstate', '**/*.keystore', '**/*.jks', '**/*.kdbx',
  '**/.config/pypoetry/auth.toml', '**/Library/Application Support/pypoetry/auth.toml', '**/.config/helm/repositories.yaml', '**/.config/helm/repositories.yml',
  '**/Library/Preferences/helm/repositories.yaml', '**/Library/Preferences/helm/repositories.yml', '**/.kaggle/kaggle.json', '**/.config/kaggle/kaggle.json',
  '**/.cache/huggingface/token', '**/.cache/huggingface/stored_tokens', '**/.huggingface/token', '**/.config/github-copilot/hosts.json', '**/.config/github-copilot/apps.json',
  '**/NuGet.Config', '**/NuGet.config', '**/nuget.config', '**/.aws/cli/cache/*.json', '**/cookies.sqlite', '**/logins.json', '**/key3.db', '**/key4.db', '**/signons.sqlite',
  '**/Cookies', '**/Login Data', '**/Login Data For Account', '**/.wakatime.cfg', '**/.jfrog/jfrog-cli.conf', '**/.jfrog/jfrog-cli.conf.v*', '**/.config/configstore/snyk.json',
  '**/.m2/settings-security.xml', '**/.talos/config', '**/.config/argocd/config', '**/.doppler/.doppler.yaml', '**/.doppler/.doppler.yml', '**/.bunfig.toml',
  '**/wg[0-9]*.conf', '**/wireguard/*.conf', '**/htpasswd', '**/.local/share/keyrings/*.keyring',
  '**/redaction-archive/**', '**/redaction-key/**',
  ...NAMED.flatMap((w) => [`**/*${w}`, `**/*${w}s`, ...DATA_EXTS.map((e) => `**/*${w}*.${e}`)]),
  '**/.ngrok2/ngrok.yml', '**/.ngrok2/ngrok.yaml', '**/*.env', ...SCRIPT_EXTS.map((e) => `**/*.env.${e}`),
  ...NAMED.flatMap((w) => [w, `${w}s`, `.${w}`, `.${w}s`].flatMap((n) => SCRIPT_EXTS.map((e) => `**/${n}.${e}`))),
];

/** A glob that matches its path in any case: `.env*` as `.[eE][nN][vV]*`. A set ([0-9]) is kept as it is. */
export const anyCase = (glob: string) => glob.replace(/\[[^\]]*\]|[a-zA-Z]/g, (c) => c.length > 1 ? c : `[${c.toLowerCase()}${c.toUpperCase()}]`);

/**
 * SECRET_GLOBS for Claude Code's Read() deny rules: as written and in any case, since isSecretPath ignores case and a
 * case-insensitive filesystem (macOS, and a container's mount of it) opens .env for a Read of .ENV.
 */
export const SECRET_DENY_GLOBS = [...SECRET_GLOBS, ...SECRET_GLOBS.map(anyCase)];

/** Worker folders an agent must never read: transcripts (Claude Code and Codex), sync state, the Codex login, process environments. */
export const PRIVATE_DIRS = ['/proc/**', '/transcripts/**', '/codex-sessions/**', '/state/**', '/redaction-key/**', '/codex/**'];

/** Heavy or generated folders an agent gains nothing from reading. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage', 'vendor', '.venv', '__pycache__', 'target', '.turbo', '.cache']);
