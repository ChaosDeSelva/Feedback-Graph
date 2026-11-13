import { authorizeStoreWrite } from '@fb/core';
import { actingAsOperator, currentActor } from './operator.ts';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  previewCloudSync, redactSecrets, cloudUrlProblem, runCloudSync, cloudLocalOnlyProjects, CLOUD_LOCAL_ONLY_CURSOR, cloudSharedDemoProjects, CLOUD_SHARED_DEMOS_CURSOR,
  cloudIntakeSharing, CLOUD_INTAKE_SHARING_CURSOR,
  type ActivityStore, type DocsStore, type CloudConfig, type CloudSyncResult, type ManualSync, type PortabilityStore, type SyncCounts, type SyncMemory,
  type SyncProgress, type SyncTrigger, type SyncResponse, type WorkerStatus,
} from '@fb/core';

export type CloudDeps = {
  /** null: CLOUD_URL / CLOUD_TOKEN are not set, so sync is off and nothing is sent. */
  cloud: CloudConfig | null;
  portability: Pick<PortabilityStore, 'exportData'>;
  activity: Pick<ActivityStore, 'record' | 'list'>;
  /** The projects a sync sends (the selection, narrowed by SYNC_PROJECTS, never an excluded one). */
  projects: () => Promise<string[]>;
  worker: () => Promise<WorkerStatus | null>;
  /** What the cloud last accepted (storedSyncMemory: the same record the worker's schedule uses). Default: in memory. */
  memory?: SyncMemory;
  localOnlyStore?: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  /** Knowledge intake is on (INTAKE_ENABLED): the card shows and sets whether claims and who said them are synced. */
  intake?: boolean;
  fetch?: typeof fetch;
};

/** The plain sentence the Settings card and the Docs page show. */
export const NEVER_SENT =
  'Never sent: session transcripts (including the feedback you typed), intake sources and their quotes and questions, facts from claims you accepted (unless SYNC_CLAIMS, and never a private source\'s), source code, file excerpts, document text, embeddings, or anything new from a project you have not selected (one synced before gets a last bundle that takes it back out).';

/** GET /api/cloud: the Settings card. */
export type CloudInfo = {
  enabled: boolean;
  host: string | null;
  intervalMinutes: number | null;
  /** SYNC_SUGGESTIONS: lessons you have not approved are sent too (proposed ones as suggestions). */
  suggestions: boolean;
  localOnlyProjects?: string[];
  localOnlyEditable?: boolean;
  savedLocalOnlyProjects?: string[];
  shareDemoProjects?: string[];
  projects: string[];
  preview: { total: SyncCounts; projects: { key: string; counts: SyncCounts | null; reason?: string }[] } | null;
  previewError: string | null;
  /** Asked with preview=0: the preview was not counted (counting reads every selected project's export, which takes seconds). */
  previewSkipped?: true;
  last: { at: string; ok: boolean; trigger: SyncTrigger; error: string | null; sent: SyncCounts | null; projects: string[]; failed: string[]; teamLessons?: NonNullable<SyncResponse['teamLessons']>[] } | null;
  nextAt: string | null;
  neverSent: string;
  teamLessons?: SyncResponse['teamLessons'];
  policyError?: string;
  /**
   * With knowledge intake on: whether facts from accepted claims are synced (SYNC_CLAIMS) and name who said them
   * (SYNC_PEOPLE), as in effect (Settings over .env); saved: set in Settings; editable: it can be set there.
   */
  intakeSharing?: { claims: boolean; people: boolean; saved: boolean; editable: boolean };
};

/** A Sync now in progress (GET /api/cloud/progress, /api/status). */
export type RunningSync = SyncProgress & { startedAt: string };

/** What this api process knows about Sync now: the run in progress and the last one it finished. */
export type CloudState = { running(): RunningSync | null; lastManual(): ManualSync | null; restore?(): Promise<void> };

/**
 * What /api/status says about sync: whether it is on and where it goes, the last Sync now this api ran and the one
 * running now (the worker's schedule is in worker.cloudSync). The token is never shown.
 */
export const cloudStatus = (cloud: CloudConfig | null, state?: CloudState | null) =>
  cloud && { host: new URL(cloud.url).host, token: '[REDACTED]' as const, intervalMinutes: cloud.intervalMinutes, lastManual: state?.lastManual() ?? null, syncing: state?.running() ?? null };

const manualOf = (r: CloudSyncResult): ManualSync => ({
  at: r.at, ok: r.ok, error: r.error, sent: r.sent,
  unchanged: r.projects.filter((p) => p.status === 'unchanged').length,
  failed: r.projects.filter((p) => p.status === 'failed').length,
  ...(r.projects.some(p => p.teamLessons) ? { teamLessons: [...new Map(r.projects.flatMap(p => p.teamLessons ? [[p.teamLessons.message, p.teamLessons] as const] : [])).values()] } : {}),
});

const SyncRequest = z.object({ force: z.boolean().optional() }).strict();
const ProjectKeys = z.array(z.string().min(1).max(200)).max(2000);
const LocalOnly = z.object({ projects: ProjectKeys, shareDemoProjects: ProjectKeys.optional() }).strict();
/** PUT /api/cloud/intake-sharing: people only with claims. */
const IntakeSharingBody = z.object({ claims: z.boolean(), people: z.boolean() }).strict().refine((b) => b.claims || !b.people, 'people are named only when claims are synced: set claims true too');
/** For the OpenAPI document (openapi.ts). */
export const cloudSchemas = { SyncRequest, LocalOnly, IntakeSharingBody };

/**
 * The card and Sync now. POST /api/cloud/sync is owner-only (guarded in createApp); it sends what changed since the
 * last sync ({ force: true }: everything). GET /api/cloud/progress is cheap to poll while it runs.
 */
export function cloudRoutes(app: Hono, d: CloudDeps): CloudState {
  let running: Promise<unknown> | null = null;
  let progress: RunningSync | null = null;
  let lastManual: ManualSync | null = null;
  let policyCache: { until: number; value: Promise<SyncResponse['teamLessons']> } | null = null;
  const teamPolicy = () => {
    if (!d.cloud || cloudUrlProblem(d.cloud.url)) return Promise.resolve(undefined);
    if (policyCache && policyCache.until > Date.now()) return policyCache.value;
    const cloud = d.cloud;
    const value = (d.fetch ?? fetch)(`${cloud.url.replace(/\/+$/, '')}/api/v1/sync-policy`, { headers: { authorization: `Bearer ${cloud.token}` }, redirect: 'error', signal: AbortSignal.timeout(3000) })
      .then(async response => { if (!response.ok) return undefined; const body = await response.json() as { teamLessons?: SyncResponse['teamLessons'] }; const team = body.teamLessons; return team && typeof team.message === 'string' && typeof team.adminApprovalRequired === 'boolean' ? { ...team, message: redactSecrets(team.message).slice(0, 1000) } : undefined; }).catch(() => undefined);
    policyCache = { until: Date.now() + 60_000, value }; return value;
  };
  /** SYNC_CLAIMS and SYNC_PEOPLE in effect: Settings over .env. */
  const sharing = async () => (d.localOnlyStore ? cloudIntakeSharing(d.localOnlyStore, d.cloud ?? {}) : { claims: !!d.cloud?.claims, people: !!d.cloud?.claims && !!d.cloud?.people, saved: false });
  // What the cloud last accepted per project, for `withdrawn` on the next Sync now; shared with the worker's schedule.
  const memory: SyncMemory = d.memory ?? new Map();
  const restore = async () => {
    const saved = await memory.last?.('manual');
    if (saved && (!lastManual || Date.parse(saved.at) > Date.parse(lastManual.at))) lastManual = manualOf(saved);
  };

  app.get('/api/cloud', async (c) => {
    const requestedProject = c.req.query('project');
    if (requestedProject !== undefined && !/^[\w][\w./-]{0,199}$/.test(requestedProject)) return c.json({ error: 'invalid project key' }, 400);
    const cloud = d.cloud;
    const info: CloudInfo = {
      enabled: !!cloud,
      host: cloud ? new URL(cloud.url).host : null,
      intervalMinutes: cloud?.intervalMinutes ?? null,
      suggestions: cloud?.suggestions ?? false,
      localOnlyProjects: d.localOnlyStore ? await cloudLocalOnlyProjects(d.localOnlyStore, cloud?.localOnlyProjects) : cloud?.localOnlyProjects ?? [],
      localOnlyEditable: !!d.localOnlyStore,
      savedLocalOnlyProjects: d.localOnlyStore ? await cloudLocalOnlyProjects(d.localOnlyStore) : [],
      shareDemoProjects: d.localOnlyStore ? await cloudSharedDemoProjects(d.localOnlyStore) : [],
      projects: [],
      preview: null,
      previewError: null,
      last: null,
      nextAt: null,
      neverSent: NEVER_SENT,
    };
    const shares = d.intake ? await sharing() : null;
    if (shares) info.intakeSharing = { ...shares, editable: !!d.localOnlyStore && !!cloud };
    if (!cloud) return c.json(info);
    info.projects = (await d.projects()).filter(key => !info.localOnlyProjects?.includes(key));
    // preview=0: the settings at once; the page asks again for the counts.
    if (c.req.query('preview') === '0') info.previewSkipped = true;
    else try {
      info.preview = await previewCloudSync(d.portability, info.projects, { suggestions: cloud.suggestions, claims: shares?.claims ?? cloud.claims, people: shares?.people ?? cloud.people, memory, shareDemoProjects: info.shareDemoProjects });
    } catch (err) {
      info.previewError = redactSecrets(String(err)).slice(0, 300);
    }
    if (requestedProject) { info.teamLessons = await teamPolicy(); if (!info.teamLessons) info.policyError = 'Team approval policy is unavailable; verify it in cloud Settings before selecting this project for sync.'; }
    if (requestedProject && !info.projects.includes(requestedProject)) {
      info.preview ??= { total: { projects: 0, lessons: 0, misses: 0, facts: 0, docs: 0, codeFiles: 0 }, projects: [] };
      info.preview.projects.push({ key: requestedProject, counts: null, reason: info.localOnlyProjects?.includes(requestedProject) ? 'Project is local-only; it will not be sent.' : 'Project is not selected for cloud sync; inspect local-only settings and the team approval policy before selecting it.' });
    }
    await restore();
    const saved = await memory.last?.();
    if (saved) info.last = { at: saved.at, ok: saved.ok, trigger: saved.trigger, error: saved.error, sent: saved.sent,
      projects: saved.projects.filter(p => p.status === 'sent').map(p => p.key), failed: saved.projects.filter(p => p.status === 'failed').map(p => p.key),
      ...(saved.projects.some(p => p.teamLessons) ? { teamLessons: [...new Map(saved.projects.flatMap(p => p.teamLessons ? [[p.teamLessons.message, p.teamLessons] as const] : [])).values()] } : {}) };
    const [a] = saved ? [] : await d.activity.list({ kind: 'cloud_synced', limit: 1 }).catch(() => []);
    if (a) {
      const x = a.details as { ok?: boolean; trigger?: SyncTrigger; error?: string | null; sent?: SyncCounts; projects?: string[]; failed?: string[] };
      info.last = { at: a.ts, ok: !!x.ok, trigger: x.trigger ?? 'schedule', error: x.error ?? null, sent: x.sent ?? null, projects: x.projects ?? [], failed: x.failed ?? [] };
    }
    info.nextAt = (await d.worker().catch(() => null))?.cloudSync?.nextAt ?? null;
    return c.json(info);
  });

  app.get('/api/cloud/progress', async (c) => { await restore(); return c.json({ running: progress, lastManual }); });

  app.put('/api/cloud/local-only', async (c) => {
    if (!d.localOnlyStore) return c.json({ error: 'local-only policy storage is unavailable' }, 503);
    const body = LocalOnly.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    await d.localOnlyStore.setCursor(CLOUD_LOCAL_ONLY_CURSOR, JSON.stringify([...new Set(body.data.projects)].sort()));
    if (body.data.shareDemoProjects) await d.localOnlyStore.setCursor(CLOUD_SHARED_DEMOS_CURSOR, JSON.stringify([...new Set(body.data.shareDemoProjects)].sort()));
    return c.json({ projects: await cloudLocalOnlyProjects(d.localOnlyStore, d.cloud?.localOnlyProjects), shareDemoProjects: await cloudSharedDemoProjects(d.localOnlyStore) });
  });

  // Settings' Cloud sync card: whether facts from accepted claims are synced, and with who said them. A fact from a
  // private source never goes, whatever this says (syncBundle). Logged in Activity.
  app.put('/api/cloud/intake-sharing', async (c) => {
    if (!d.localOnlyStore || !d.cloud) return c.json({ error: 'cloud sync is off: set CLOUD_URL and CLOUD_TOKEN in .env and restart' }, 409);
    if (!d.intake) return c.json({ error: 'knowledge intake is off (INTAKE_ENABLED), so there are no claims to sync' }, 409);
    const body = IntakeSharingBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const before = await sharing();
    await d.localOnlyStore.setCursor(CLOUD_INTAKE_SHARING_CURSOR, JSON.stringify(body.data));
    const after = await sharing();
    if (before.claims !== after.claims || before.people !== after.people) {
      await d.activity.record({
        kind: 'cloud_settings_changed', actor: currentActor(), projectKey: null,
        subject: `cloud sync of claims: ${after.claims ? `on${after.people ? ', naming who said them' : ', without names'}` : 'off'}`,
        why: `${actingAsOperator() ? `an agent (${currentActor()})` : 'you'} chose ${after.claims ? 'to sync the facts accepted claims became (never a private source\'s, never a quote)' : 'to keep the facts accepted claims became on this machine; synced ones are withdrawn on the next sync'}`,
        details: { claims: after.claims, people: after.people, before: { claims: before.claims, people: before.people } }, targets: [],
      });
    }
    return c.json({ ...after, editable: true });
  });

  app.post('/api/cloud/sync', async (c) => {
    const cloud = d.cloud;
    if (!cloud) return c.json({ error: 'cloud sync is off: set CLOUD_URL and CLOUD_TOKEN in .env and restart' }, 409);
    if (running) return c.json({ error: 'a sync is already running' }, 409);
    const body = SyncRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    await authorizeStoreWrite();
    const startedAt = new Date().toISOString();
    const run = runCloudSync({
      cloud: { ...cloud, ...(await sharing()), shareDemoProjects: d.localOnlyStore ? await cloudSharedDemoProjects(d.localOnlyStore) : [], localOnlyProjects: d.localOnlyStore ? await cloudLocalOnlyProjects(d.localOnlyStore, cloud.localOnlyProjects) : cloud.localOnlyProjects }, portability: d.portability, activity: d.activity, projects: d.projects, trigger: 'manual', fetch: d.fetch, memory,
      force: body.data.force ?? false,
      onProgress: (p) => { progress = { ...p, startedAt }; },
    });
    running = run;
    try {
      const r = await run;
      lastManual = manualOf(r);
      return c.json(r);
    } finally {
      running = null;
      progress = null;
    }
  });

  return { running: () => progress, lastManual: () => lastManual, restore };
}
