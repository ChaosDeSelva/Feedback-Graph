import type { Hono } from 'hono';
import {
  previewCloudSync, redactSecrets, runCloudSync,
  type ActivityStore, type CloudConfig, type PortabilityStore, type SyncCounts, type SyncMemory, type SyncTrigger, type WorkerStatus,
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
  fetch?: typeof fetch;
};

/** The plain sentence the Settings card and the Docs page show. */
export const NEVER_SENT =
  'Never sent: session transcripts (including the feedback you typed), source code, file excerpts, document text, embeddings, or anything new from a project you have not selected (one synced before gets a last bundle that takes it back out).';

/** GET /api/cloud: the Settings card. */
export type CloudInfo = {
  enabled: boolean;
  host: string | null;
  intervalMinutes: number | null;
  /** SYNC_SUGGESTIONS: lessons you have not approved are sent too (proposed ones as suggestions). */
  suggestions: boolean;
  projects: string[];
  preview: { total: SyncCounts; projects: { key: string; counts: SyncCounts | null }[] } | null;
  previewError: string | null;
  last: { at: string; ok: boolean; trigger: SyncTrigger; error: string | null; sent: SyncCounts | null; projects: string[]; failed: string[] } | null;
  nextAt: string | null;
  neverSent: string;
};

/** What /api/status says about sync: whether it is on and where it goes. The token is never shown. */
export const cloudStatus = (cloud: CloudConfig | null) => cloud && { host: new URL(cloud.url).host, token: '[REDACTED]' as const, intervalMinutes: cloud.intervalMinutes };

/** The card and Sync now. POST /api/cloud/sync is owner-only (guarded in createApp). */
export function cloudRoutes(app: Hono, d: CloudDeps) {
  let running: Promise<unknown> | null = null;
  // What the cloud last accepted per project, for `withdrawn` on the next Sync now; shared with the worker's schedule.
  const memory: SyncMemory = d.memory ?? new Map();

  app.get('/api/cloud', async (c) => {
    const cloud = d.cloud;
    const info: CloudInfo = {
      enabled: !!cloud,
      host: cloud ? new URL(cloud.url).host : null,
      intervalMinutes: cloud?.intervalMinutes ?? null,
      suggestions: cloud?.suggestions ?? false,
      projects: [],
      preview: null,
      previewError: null,
      last: null,
      nextAt: null,
      neverSent: NEVER_SENT,
    };
    if (!cloud) return c.json(info);
    info.projects = await d.projects();
    try {
      info.preview = await previewCloudSync(d.portability, info.projects, { suggestions: cloud.suggestions, memory });
    } catch (err) {
      info.previewError = redactSecrets(String(err)).slice(0, 300);
    }
    const [a] = await d.activity.list({ kind: 'cloud_synced', limit: 1 }).catch(() => []);
    if (a) {
      const x = a.details as { ok?: boolean; trigger?: SyncTrigger; error?: string | null; sent?: SyncCounts; projects?: string[]; failed?: string[] };
      info.last = { at: a.ts, ok: !!x.ok, trigger: x.trigger ?? 'schedule', error: x.error ?? null, sent: x.sent ?? null, projects: x.projects ?? [], failed: x.failed ?? [] };
    }
    info.nextAt = (await d.worker().catch(() => null))?.cloudSync?.nextAt ?? null;
    return c.json(info);
  });

  app.post('/api/cloud/sync', async (c) => {
    const cloud = d.cloud;
    if (!cloud) return c.json({ error: 'cloud sync is off: set CLOUD_URL and CLOUD_TOKEN in .env and restart' }, 409);
    if (running) return c.json({ error: 'a sync is already running' }, 409);
    const run = runCloudSync({ cloud, portability: d.portability, activity: d.activity, projects: d.projects, trigger: 'manual', fetch: d.fetch, memory });
    running = run;
    try {
      return c.json(await run);
    } finally {
      running = null;
    }
  });
}
