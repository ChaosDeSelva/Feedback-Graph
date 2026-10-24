import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DocsStore } from '../store.ts';
import type { ExternalSource } from '../types.ts';
import type { IntegrationErrorKind } from './errors.ts';

/**
 * GitHub and Linear connections: a token from .env (GITHUB_TOKEN, LINEAR_API_KEY), which always wins, or one pasted in
 * Settings. A pasted token is kept in INTEGRATIONS_FILE (state/settings/integrations.json, mode 600): never in the
 * database, never returned by the API, logged, exported or synced. The api writes it; the worker reads it each cycle.
 *
 * What is not secret lives in the store's key/value records, each written by one side so they never race: `check` (the
 * api: the last test call and the account it named), `sync` (the worker: last sync, errors, per project) and `links`
 * (the api: per project, whether GitHub is on and which Linear team it maps to). Keys use slashes, never `:<project>`
 * endings, so deleting a project never deletes them.
 */
export type IntegrationKind = ExternalSource;
export const INTEGRATION_KINDS: readonly IntegrationKind[] = ['github', 'linear'];
export type CredentialSource = 'env' | 'app';

export const ENV_VAR: Record<IntegrationKind, string> = { github: 'GITHUB_TOKEN', linear: 'LINEAR_API_KEY' };

export type IntegrationCheck = { ok: boolean; account: string | null; error: string | null; errorKind: IntegrationErrorKind | null; at: string; source: CredentialSource; fingerprint: string };

export type ProjectSyncState = { lastSyncAt: string | null; items: number; error: string | null; target: string | null };

export type IntegrationSyncState = {
  lastSyncAt: string | null;
  lastError: string | null;
  errorKind: IntegrationErrorKind | null;
  /** A rate limit: no calls before this. */
  rateLimitedUntil: string | null;
  /** The token (by fingerprint) the service rejected: the worker stops using it until it changes. */
  authFailedFor: string | null;
  projects: Record<string, ProjectSyncState>;
};

export type ProjectLink = { github: boolean; linearTeamId: string | null; linearTeamName: string | null };

export const DEFAULT_LINK: ProjectLink = { github: true, linearTeamId: null, linearTeamName: null };

export const emptySyncState = (): IntegrationSyncState => ({ lastSyncAt: null, lastError: null, errorKind: null, rateLimitedUntil: null, authFailedFor: null, projects: {} });

/** A short, one-way id of a token: tells two tokens apart without keeping or showing either. */
export const tokenFingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 12);

const key = (kind: IntegrationKind, part: 'check' | 'sync') => `integrations/${kind}/${part}`;
const LINKS = 'integrations/links';

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export type Credential = { token: string; source: CredentialSource; fingerprint: string };

type SavedTokens = Partial<Record<IntegrationKind, { token: string; savedAt: string }>>;

/** Where tokens pasted in Settings are kept. */
export type CredentialFile = { read(): Promise<SavedTokens>; write(next: SavedTokens): Promise<void> };

/**
 * The tokens file: JSON, mode 600, written whole (a temp file renamed over it, so a reader never sees half of it).
 * Missing or unreadable: no tokens.
 */
export function credentialFile(path: string): CredentialFile {
  return {
    async read() {
      try {
        const v = JSON.parse(await readFile(path, 'utf8'));
        return v && typeof v === 'object' ? (v as SavedTokens) : {};
      } catch {
        return {};
      }
    },
    async write(next) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = path + '.' + process.pid + '.tmp';
      await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    },
  };
}

export class Integrations {
  readonly kv: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  readonly env: Record<string, string | undefined>;
  /** Null: no INTEGRATIONS_FILE, so tokens can only come from .env. */
  readonly file: CredentialFile | null;

  constructor(kv: Pick<DocsStore, 'getCursor' | 'setCursor'>, env: Record<string, string | undefined>, file: CredentialFile | null = null) {
    this.kv = kv;
    this.env = env;
    this.file = file;
  }

  /** Whether .env sets this service's token (it then wins over one saved in the app). */
  envSet(kind: IntegrationKind): boolean {
    return !!this.env[ENV_VAR[kind]]?.trim();
  }

  /** Whether tokens can be saved in the app (an INTEGRATIONS_FILE is configured). */
  get canSave(): boolean {
    return !!this.file;
  }

  async credential(kind: IntegrationKind): Promise<Credential | null> {
    const fromEnv = this.env[ENV_VAR[kind]]?.trim();
    if (fromEnv) return { token: fromEnv, source: 'env', fingerprint: tokenFingerprint(fromEnv) };
    const saved = this.file ? (await this.file.read())[kind]?.token : null;
    return saved ? { token: saved, source: 'app', fingerprint: tokenFingerprint(saved) } : null;
  }

  /** Whether a token is saved in the app (whether or not .env overrides it). */
  async savedInApp(kind: IntegrationKind): Promise<boolean> {
    return !!(this.file && (await this.file.read())[kind]?.token);
  }

  async saveCredential(kind: IntegrationKind, token: string): Promise<void> {
    if (!this.file) throw new Error('no INTEGRATIONS_FILE is configured: set the token in .env instead');
    const all = await this.file.read();
    await this.file.write({ ...all, [kind]: { token, savedAt: new Date().toISOString() } });
  }

  /** Forget the token saved in the app, and what was learned with it (the check). Sync history stays. */
  async removeCredential(kind: IntegrationKind): Promise<void> {
    if (this.file) {
      const rest = { ...(await this.file.read()) };
      delete rest[kind];
      await this.file.write(rest);
    }
    await this.kv.setCursor(key(kind, 'check'), '');
  }

  async check(kind: IntegrationKind): Promise<IntegrationCheck | null> {
    return parse<IntegrationCheck | null>(await this.kv.getCursor(key(kind, 'check')), null);
  }

  async saveCheck(kind: IntegrationKind, c: IntegrationCheck): Promise<void> {
    await this.kv.setCursor(key(kind, 'check'), JSON.stringify(c));
  }

  async sync(kind: IntegrationKind): Promise<IntegrationSyncState> {
    return { ...emptySyncState(), ...parse<Partial<IntegrationSyncState>>(await this.kv.getCursor(key(kind, 'sync')), {}) };
  }

  async saveSync(kind: IntegrationKind, s: IntegrationSyncState): Promise<void> {
    await this.kv.setCursor(key(kind, 'sync'), JSON.stringify(s));
  }

  async links(): Promise<Record<string, ProjectLink>> {
    return parse<Record<string, ProjectLink>>(await this.kv.getCursor(LINKS), {});
  }

  async link(projectKey: string): Promise<ProjectLink> {
    return { ...DEFAULT_LINK, ...(await this.links())[projectKey] };
  }

  async setLink(projectKey: string, patch: Partial<ProjectLink>): Promise<ProjectLink> {
    const all = await this.links();
    const next = { ...DEFAULT_LINK, ...all[projectKey], ...patch };
    await this.kv.setCursor(LINKS, JSON.stringify({ ...all, [projectKey]: next }));
    return next;
  }
}
