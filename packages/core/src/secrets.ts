/** Files that hold credentials. The scanner never reads them and agent CLIs are denied them; one list for both. */
export const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|\.envrc|\.pgpass|\.vault-token|(?:[^/]*[-_])?kubeconfig(?:\.[^/]*)?|\.kube\/config|\.docker\/config\.json|[^/]*service[-_]account[^/]*\.json|\.mcp\.json|\.npmrc|\.netrc|\.pypirc|\.git\/config|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|tfvars|tfstate|keystore|jks)|[^/]*(secret|credential|password)[^/]*)$/i;

export const isSecretPath = (path: string) => SECRET_FILE.test(path);

/** The same files as SECRET_FILE, as globs for Claude Code's Read() deny rules. */
export const SECRET_GLOBS = [
  '**/.env*', '**/.pgpass', '**/.vault-token', '**/*kubeconfig*', '**/.kube/config', '**/.docker/config.json', '**/*service-account*.json', '**/*service_account*.json', '**/.mcp.json', '**/.npmrc', '**/.netrc', '**/.pypirc', '**/.git/config', '**/id_*',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.tfvars', '**/*.tfstate', '**/*.keystore', '**/*.jks',
  '**/*secret*', '**/*credential*', '**/*password*',
];

/** Worker folders an agent must never read: transcripts (Claude Code and Codex), sync state, the Codex login, process environments. */
export const PRIVATE_DIRS = ['/proc/**', '/transcripts/**', '/codex-sessions/**', '/state/**', '/codex/**'];

/** Heavy or generated folders an agent gains nothing from reading. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage', 'vendor', '.venv', '__pycache__', 'target', '.turbo', '.cache']);
