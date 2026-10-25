import type { Hono } from 'hono';
import { z } from 'zod';
import {
  DEFAULT_LINK, ENV_VAR, FEEDBACK_SKIP_RULES, githubRepoOfRemote, githubViewer, integrationErrorKind, linearViewer, listLinearTeams, redactSecrets, tokenFingerprint,
  type ActivityStore, type CloudConfig, type Connection, type ConnectionName, type IntegrationCheck, type IntegrationKind, type Integrations,
  type IntegrationSyncState, type LinearTeam, type ManualSync, type OllamaHealth, type WorkerStatus,
} from '@fb/core';

/**
 * Settings > Integrations: connect GitHub and Linear (paste a token, or set it in .env, which wins), see each
 * selected project's repository and Linear team, and the sync state. Tokens go in, never out: no response carries one.
 */
export type IntegrationsDeps = {
  integrations: Integrations;
  /** The selected projects with their git remotes (canonical, e.g. github.com/acme/shop). */
  projects(): Promise<{ key: string; remote: string | null }[]>;
  /** GITHUB_REPOS overrides. */
  githubOverride: Map<string, string>;
  syncMinutes: number;
  /** list: counts the comments each skip rule kept from the classifier (comments_skipped entries); unset: no counts. */
  activity?: Pick<ActivityStore, 'record'> & Partial<Pick<ActivityStore, 'list'>>;
  /** Test seams for the one call that checks a token. */
  viewer?: { github(token: string): Promise<string>; linear(token: string): Promise<string> };
  teams?(apiKey: string): Promise<LinearTeam[]>;
};

export type ServiceView = {
  connection: Connection;
  /** The token is set in .env (it wins; Settings cannot change it). */
  envSet: boolean;
  envVar: string;
  /** A token is saved in the app (used only when .env sets none). */
  savedInApp: boolean;
  account: string | null;
  checkedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  errorKind: IntegrationSyncState['errorKind'];
  rateLimitedUntil: string | null;
};

export type ProjectIntegrations = {
  key: string;
  github: { repo: string | null; from: 'remote' | 'GITHUB_REPOS' | null; enabled: boolean; lastSyncAt: string | null; items: number; error: string | null };
  linear: { teamId: string | null; teamName: string | null; lastSyncAt: string | null; items: number; error: string | null };
};

export type IntegrationsView = {
  /** Tokens can be saved in the app (INTEGRATIONS_FILE is set); false: only .env works. */
  canSave: boolean;
  syncMinutes: number;
  github: ServiceView;
  linear: ServiceView;
  projects: ProjectIntegrations[];
  /** The rules that keep a comment from the classifier (core feedbackRules.ts), each with how many it kept (null: not counted). */
  rules: SkipRuleView[];
  /** The oldest comments_skipped entry counted (the counts cover the most recent SKIP_ENTRIES); null when there is none. */
  skippedSince: string | null;
};

/**
 * skipped: comments the rule kept from the classifier, counting fromInbox: items already pending in the Inbox that it
 * skipped later (the rules changed, or the authors became known; worker integrations/pendingSkips.ts).
 */
export type SkipRuleView = { name: string; description: string; skipped: number | null; fromInbox: number | null };

/** How many comments_skipped entries (one per project and worker cycle that skipped something) the counts add up. */
const SKIP_ENTRIES = 1000;

async function skipRules(d: IntegrationsDeps): Promise<{ rules: SkipRuleView[]; skippedSince: string | null }> {
  const entries = d.activity?.list ? await d.activity.list({ kind: 'comments_skipped', limit: SKIP_ENTRIES }).catch(() => null) : null;
  const counts: Record<string, number> = {};
  const fromInbox: Record<string, number> = {};
  for (const e of entries ?? []) {
    const details = e.details as { rules?: Record<string, unknown>; pending?: unknown } | null;
    for (const [name, n] of Object.entries(details?.rules ?? {})) {
      if (typeof n !== 'number') continue;
      counts[name] = (counts[name] ?? 0) + n;
      if (typeof details?.pending === 'number') fromInbox[name] = (fromInbox[name] ?? 0) + n;
    }
  }
  return {
    rules: FEEDBACK_SKIP_RULES.map((r) => ({ name: r.name, description: r.description, skipped: entries ? counts[r.name] ?? 0 : null, fromInbox: entries ? fromInbox[r.name] ?? 0 : null })),
    skippedSince: entries?.length ? entries.map((e) => e.ts).sort()[0] : null,
  };
}

const NAME: Record<IntegrationKind, string> = { github: 'GitHub', linear: 'Linear' };
export const integrationHref = (kind: IntegrationKind) => `#settings/integrations-${kind}`;

const Token = z.object({ token: z.string().trim().min(8, 'paste the whole token').max(500) }).strict();
const Kind = z.enum(['github', 'linear']);
const LinkPatch = z
  .object({ github: z.boolean().optional(), linearTeamId: z.string().min(1).max(100).nullable().optional(), linearTeamName: z.string().max(200).nullable().optional() })
  .strict();
/** For the OpenAPI document (openapi.ts). */
export const integrationSchemas = { Token, LinkPatch };

const when = (iso: string | null) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null);

/**
 * A service's state from its token, the last check and the worker's last sync: not connected (no token), error (the
 * check or the worker found the token rejected, or a rate limit is in force), or connected.
 */
export function serviceConnection(
  kind: IntegrationKind,
  o: { source: 'env' | 'app' | null; fingerprint: string | null; check: IntegrationCheck | null; sync: IntegrationSyncState; canSave: boolean },
  now = Date.now(),
): Connection {
  const href = integrationHref(kind);
  if (!o.source || !o.fingerprint) {
    const how = o.canSave ? `paste a token in Settings or set ${ENV_VAR[kind]} in .env` : `set ${ENV_VAR[kind]} in .env`;
    return { state: 'not_connected', source: null, detail: `Not connected: ${how}.`, href };
  }
  const check = o.check?.fingerprint === o.fingerprint ? o.check : null;
  const from = o.source === 'env' ? ' (set in .env)' : '';
  if (check && !check.ok) return { state: 'error', source: o.source, detail: `${NAME[kind]} refused the token${from}: ${check.error}`, href };
  if (o.sync.authFailedFor === o.fingerprint) {
    return { state: 'error', source: o.source, detail: `${NAME[kind]} rejected the token${from} (revoked, expired or missing access). Syncing is paused until you replace it.`, href };
  }
  if (o.sync.rateLimitedUntil && Date.parse(o.sync.rateLimitedUntil) > now) {
    return { state: 'error', source: o.source, detail: `Rate limited by ${NAME[kind]}: syncing resumes on its own at ${when(o.sync.rateLimitedUntil)}.`, href };
  }
  const who = check?.account ? `as ${check.account}` : 'token not checked yet';
  const synced = o.sync.lastSyncAt ? `last sync ${when(o.sync.lastSyncAt)}` : 'not synced yet';
  return { state: 'connected', source: o.source, detail: `Connected ${who}${from}; ${synced}.`, href };
}

/** A check that could not reach the service is tried again after this long, not on every read. */
const RECHECK_AFTER_MS = 10 * 60_000;
/** How long a read waits for a check started on it; a slower one lands on a later read. */
const CHECK_WAIT_MS = 5_000;
/** Per Integrations: the check last started for each service (its token's fingerprint, when, and the call). */
const checking = new WeakMap<Integrations, Map<IntegrationKind, { fingerprint: string; at: number; done: Promise<IntegrationCheck | null> }>>();

/**
 * Check a token nobody has checked (one set in .env is never checked by saving it), or one whose last check failed
 * while a sync has worked since, so the connection names the account instead of "token not checked yet". At most one
 * call per token at a time; a service that could not be reached is not recorded as refusing the token, and is asked
 * again only after RECHECK_AFTER_MS. Returns the new check, or null when none was made or it did not finish in time.
 */
async function checkOnFirstUse(
  d: IntegrationsDeps,
  kind: IntegrationKind,
  cred: { token: string; source: 'env' | 'app'; fingerprint: string },
  current: IntegrationCheck | null,
  sync: IntegrationSyncState,
): Promise<IntegrationCheck | null> {
  const failedBeforeASync = !!current && !current.ok && !!sync.lastSyncAt && sync.lastSyncAt > current.at && sync.authFailedFor !== cred.fingerprint;
  if (current && !failedBeforeASync) return null;
  const mine = checking.get(d.integrations) ?? new Map();
  checking.set(d.integrations, mine);
  let run = mine.get(kind);
  if (!run || run.fingerprint !== cred.fingerprint || (Date.now() - run.at > RECHECK_AFTER_MS)) {
    const done = checkToken(d, kind, cred.token, cred.source).then(async (c) => {
      if (c.ok || c.errorKind !== 'network') {
        await d.integrations.saveCheck(kind, c);
        return c;
      }
      return null;
    }, () => null);
    run = { fingerprint: cred.fingerprint, at: Date.now(), done };
    mine.set(kind, run);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run.done, new Promise<null>((r) => { timer = setTimeout(() => r(null), CHECK_WAIT_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** `checkUnchecked`: check a token nobody has checked yet (checkOnFirstUse) before saying how it stands. */
async function service(d: IntegrationsDeps, kind: IntegrationKind, o: { checkUnchecked: boolean } = { checkUnchecked: true }): Promise<ServiceView> {
  const i = d.integrations;
  const [cred, saved, sync, savedInApp] = await Promise.all([i.credential(kind), i.check(kind), i.sync(kind), i.savedInApp(kind)]);
  let check = saved;
  if (cred && o.checkUnchecked) check = (await checkOnFirstUse(d, kind, cred, saved && saved.fingerprint === cred.fingerprint ? saved : null, sync)) ?? saved;
  const current = check && cred && check.fingerprint === cred.fingerprint ? check : null;
  return {
    connection: serviceConnection(kind, { source: cred?.source ?? null, fingerprint: cred?.fingerprint ?? null, check, sync, canSave: i.canSave }),
    envSet: i.envSet(kind),
    envVar: ENV_VAR[kind],
    savedInApp,
    account: current?.ok ? current.account : null,
    checkedAt: current?.at ?? null,
    lastSyncAt: sync.lastSyncAt,
    lastError: sync.lastError,
    errorKind: sync.errorKind,
    rateLimitedUntil: sync.rateLimitedUntil,
  };
}

export async function integrationsView(d: IntegrationsDeps): Promise<IntegrationsView> {
  const [github, linear, projects, links, ghSync, linSync, skips] = await Promise.all([
    service(d, 'github'), service(d, 'linear'), d.projects(), d.integrations.links(), d.integrations.sync('github'), d.integrations.sync('linear'), skipRules(d),
  ]);
  return {
    ...skips,
    canSave: d.integrations.canSave,
    syncMinutes: d.syncMinutes,
    github,
    linear,
    projects: projects.map((p) => {
      const link = { ...DEFAULT_LINK, ...links[p.key] };
      const override = d.githubOverride.get(p.key) ?? null;
      const repo = override ?? githubRepoOfRemote(p.remote);
      const gs = ghSync.projects[p.key];
      const ls = linSync.projects[p.key];
      return {
        key: p.key,
        github: { repo, from: override ? 'GITHUB_REPOS' : repo ? 'remote' : null, enabled: link.github, lastSyncAt: gs?.lastSyncAt ?? null, items: gs?.items ?? 0, error: gs?.error ?? null },
        linear: { teamId: link.linearTeamId, teamName: link.linearTeamName, lastSyncAt: ls?.lastSyncAt ?? null, items: ls?.items ?? 0, error: ls?.error ?? null },
      };
    }),
  };
}

/** One cheap call with the token: the account it belongs to, or why it was refused (never the token itself). */
async function checkToken(d: IntegrationsDeps, kind: IntegrationKind, token: string, source: 'env' | 'app'): Promise<IntegrationCheck> {
  const at = new Date().toISOString();
  const fingerprint = tokenFingerprint(token);
  try {
    const account = kind === 'github'
      ? await (d.viewer?.github ?? (async (t: string) => (await githubViewer({ token: t })).login))(token)
      : await (d.viewer?.linear ?? (async (t: string) => { const v = await linearViewer({ apiKey: t }); return v.organization ? `${v.name} (${v.organization})` : v.name; }))(token);
    return { ok: true, account, error: null, errorKind: null, at, source, fingerprint };
  } catch (err) {
    const errorKind = integrationErrorKind(err);
    const raw = err instanceof Error ? err.message : String(err);
    const error = redactSecrets(raw.split(token).join('[REDACTED]')).slice(0, 300);
    const reason = errorKind === 'network' ? `could not reach ${NAME[kind]}: ${error}` : error;
    return { ok: false, account: null, error: reason, errorKind, at, source, fingerprint };
  }
}

/** Routes behind Settings > Integrations. Writes are owner-only (guarded in createApp). */
export function integrationRoutes(app: Hono, d: IntegrationsDeps) {
  const i = d.integrations;
  const record = (kind: IntegrationKind, subject: string, why: string, details: Record<string, unknown> = {}) =>
    d.activity?.record({ kind: 'integration_changed', actor: 'you', projectKey: null, subject, why, details: { service: kind, ...details } });

  app.get('/api/settings/integrations', async (c) => c.json(await integrationsView(d)));

  app.put('/api/settings/integrations/:kind', async (c) => {
    const kind = Kind.safeParse(c.req.param('kind'));
    if (!kind.success) return c.json({ error: 'unknown service: github or linear' }, 404);
    const k = kind.data;
    if (!i.canSave) return c.json({ error: `tokens cannot be saved here (no INTEGRATIONS_FILE): set ${ENV_VAR[k]} in .env instead` }, 501);
    const body = Token.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'send { "token": "..." }' }, 400);
    const check = await checkToken(d, k, body.data.token, 'app');
    if (!check.ok) return c.json({ error: `${NAME[k]} did not accept this token, so it was not saved: ${check.error}` }, 400);
    await i.saveCredential(k, body.data.token);
    await i.saveCheck(k, check);
    await record(k, `connected ${NAME[k]} as ${check.account}`, 'you saved a token in Settings; it was checked with one call');
    return c.json(await integrationsView(d));
  });

  app.post('/api/settings/integrations/:kind/test', async (c) => {
    const kind = Kind.safeParse(c.req.param('kind'));
    if (!kind.success) return c.json({ error: 'unknown service: github or linear' }, 404);
    const cred = await i.credential(kind.data);
    if (!cred) return c.json({ error: `${NAME[kind.data]} is not connected` }, 409);
    const check = await checkToken(d, kind.data, cred.token, cred.source);
    await i.saveCheck(kind.data, check);
    return c.json({ ok: check.ok, account: check.account, error: check.error, view: await integrationsView(d) });
  });

  app.delete('/api/settings/integrations/:kind', async (c) => {
    const kind = Kind.safeParse(c.req.param('kind'));
    if (!kind.success) return c.json({ error: 'unknown service: github or linear' }, 404);
    const k = kind.data;
    if (i.envSet(k) && !(await i.savedInApp(k))) return c.json({ error: `${ENV_VAR[k]} is set in .env: remove it there and restart to disconnect.` }, 409);
    await i.removeCredential(k);
    await record(k, `disconnected ${NAME[k]}`, i.envSet(k) ? `you removed the token saved in Settings, so ${ENV_VAR[k]} in .env is used again` : 'you removed the token saved in Settings; comments already in the Inbox stay');
    return c.json(await integrationsView(d));
  });

  app.get('/api/settings/integrations/linear/teams', async (c) => {
    const cred = await i.credential('linear');
    if (!cred) return c.json({ error: 'Linear is not connected' }, 409);
    try {
      return c.json(await (d.teams ?? ((apiKey: string) => listLinearTeams({ apiKey })))(cred.token));
    } catch (err) {
      const msg = redactSecrets((err instanceof Error ? err.message : String(err)).split(cred.token).join('[REDACTED]')).slice(0, 300);
      return c.json({ error: `could not list Linear teams: ${msg}` }, 502);
    }
  });

  app.put('/api/settings/integrations/projects/:key', async (c) => {
    const key = c.req.param('key');
    if (!(await d.projects()).some((p) => p.key === key)) return c.json({ error: `${key} is not a selected project` }, 404);
    const body = LinkPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'send { "github"?: boolean, "linearTeamId"?: string | null, "linearTeamName"?: string | null }' }, 400);
    const patch = { ...body.data, ...(body.data.linearTeamId === null ? { linearTeamName: null } : {}) };
    const next = await i.setLink(key, patch);
    const what = [
      body.data.github !== undefined ? `GitHub ${next.github ? 'on' : 'off'}` : null,
      body.data.linearTeamId !== undefined ? (next.linearTeamId ? `Linear team ${next.linearTeamName ?? next.linearTeamId}` : 'no Linear team') : null,
    ].filter(Boolean).join(', ');
    await d.activity?.record({ kind: 'integration_changed', actor: 'you', projectKey: key, subject: `${key}: ${what}`, why: 'you changed it in Settings > Integrations', details: next });
    return c.json(await integrationsView(d));
  });
}

/** Model connections from the worker's heartbeat: which jobs use Claude or Codex, and whether they answered. */
function agentConnection(name: 'claude' | 'codex', w: WorkerStatus | null): Connection {
  const href = '#settings/connections';
  const label = name === 'claude' ? 'Claude' : 'Codex';
  if (!w) return { state: 'not_connected', source: null, detail: 'The worker has not reported yet.', href };
  const match = (p: string | null | undefined) => !!p && (name === 'claude' ? p.startsWith('claude-cli') || p.startsWith('anthropic:') : p.startsWith('codex-cli'));
  const jobs = Object.entries(w.providers).filter(([, p]) => match(p)).map(([job]) => job);
  if (!jobs.length) {
    const how = name === 'claude' ? 'set CLAUDE_CODE_OAUTH_TOKEN (./scripts/setup.sh) or ANTHROPIC_API_KEY, or POSTMORTEM_LLM=claude-cli' : 'set POSTMORTEM_LLM or SCAN_LLM to codex-cli';
    return { state: 'not_connected', source: null, detail: `No job uses ${label}: ${how}.`, href };
  }
  const down = jobs.map((j) => w.health?.[j as keyof NonNullable<WorkerStatus['health']>]).find((h) => h && !h.ok);
  if (down) return { state: 'error', source: 'env', detail: `${label} did not answer: ${down.reason}`, href };
  return { state: 'connected', source: 'env', detail: `${label} runs: ${jobs.join(', ')}.`, href };
}

function ollamaConnection(o: OllamaHealth | null): Connection {
  const href = '#settings/connections';
  if (!o) return { state: 'not_connected', source: null, detail: 'Ollama was not checked.', href };
  return o.ok ? { state: 'connected', source: 'env', detail: `Ollama answers at ${o.url}.`, href } : { state: 'error', source: 'env', detail: `Ollama: ${o.reason}`, href };
}

/** The newer of the worker's last scheduled sync and the api's last Sync now decides what the line says. */
function cloudConnection(cloud: CloudConfig | null, w: WorkerStatus | null, manual: ManualSync | null): Connection {
  const href = '#settings/connections';
  if (!cloud) return { state: 'not_connected', source: null, detail: 'Cloud sync is off: nothing is sent anywhere.', href };
  const host = new URL(cloud.url).host;
  const s = w?.cloudSync;
  const last = manual && (!s?.lastAt || manual.at > s.lastAt)
    ? { at: manual.at, ok: manual.ok, error: manual.error, how: ' (Sync now)' }
    : s?.lastAt ? { at: s.lastAt, ok: s.lastOk !== false, error: s.lastError, how: '' } : null;
  if (last && !last.ok) return { state: 'error', source: 'env', detail: `Sync to ${host} failed${last.how}: ${last.error ?? 'unknown error'}`, href };
  return { state: 'connected', source: 'env', detail: last ? `Syncing to ${host}; last sync ${when(last.at)}${last.how}.` : `Set up for ${host}; not synced yet.`, href };
}

/** Every connection for /api/status. Each one fails on its own: a broken one never hides the others. */
export async function connectionsStatus(o: {
  integrations: Integrations | null;
  /** The integration routes' deps: with them, a token nobody has checked is checked here too (the status bar polls). */
  deps?: IntegrationsDeps;
  worker: WorkerStatus | null;
  ollama: OllamaHealth | null;
  cloud: CloudConfig | null;
  /** The api's last Sync now, when it ran one. */
  manualSync?: ManualSync | null;
}): Promise<Record<ConnectionName, Connection>> {
  const one = async (kind: IntegrationKind): Promise<Connection> => {
    if (!o.integrations) return { state: 'not_connected', source: null, detail: 'Not available in this setup.', href: integrationHref(kind) };
    try {
      const d = o.deps?.integrations === o.integrations ? o.deps : ({ integrations: o.integrations } as IntegrationsDeps);
      return (await service(d, kind, { checkUnchecked: d === o.deps })).connection;
    } catch (err) {
      return { state: 'error', source: null, detail: `Could not read the ${NAME[kind]} state: ${redactSecrets(String(err)).slice(0, 200)}`, href: integrationHref(kind) };
    }
  };
  const [github, linear] = await Promise.all([one('github'), one('linear')]);
  return {
    github,
    linear,
    claude: agentConnection('claude', o.worker),
    codex: agentConnection('codex', o.worker),
    ollama: ollamaConnection(o.ollama),
    cloud: cloudConnection(o.cloud, o.worker, o.manualSync ?? null),
  };
}
