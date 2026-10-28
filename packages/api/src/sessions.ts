import type { Hono } from 'hono';
import { currentRun } from './operator.ts';
import { z } from 'zod';
import { decodeSessionCursor, encodeSessionCursor, SESSION_STATES, type SessionsStore } from '@fb/core';

export type SessionsDeps = {
  store: Pick<SessionsStore, 'list' | 'detail' | 'requestRebuild'> & Partial<Pick<SessionsStore, 'claimRun' | 'runFor'>>;
  /** The selected projects (ProjectScope.projects): the list covers these. */
  projects(): Promise<string[]> | string[];
  /** ProjectScope.project: a session of any other project is not shown. */
  inScope(key: string): Promise<boolean> | boolean;
};

const ListQuery = z.object({
  project: z.string().min(1).max(200).optional(),
  state: z.enum(SESSION_STATES).optional(),
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
/** For the OpenAPI document (openapi.ts). */
export const sessionSchemas = { ListQuery };

/**
 * GET /api/sessions (newest first, paged by `cursor`), GET /api/sessions/:id (the summary, its history, the Inbox items
 * from the session), and POST /api/sessions/:id/resummarize (owner-only, registered in app.ts): rebuild from scratch.
 */
export function sessionRoutes(app: Hono, d: SessionsDeps) {
  app.post('/api/sessions/:id/run', async c => {
    const run = currentRun();
    if (!run) return c.json({ error: 'session registration requires X-FG-Run' }, 400);
    const id = c.req.param('id');
    if (!/^[\w.:-]{1,200}$/.test(id)) return c.json({ error: 'invalid session id' }, 400);
    if (!d.store.claimRun) return c.json({ error: 'session run registration unavailable' }, 503);
    if (!await d.store.claimRun(id, run)) return c.json({ error: 'session already belongs to the owner or another run; start a new labelled session' }, 409);
    return c.body(null, 204);
  });
  app.get('/api/sessions', async (c) => {
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const after = q.data.cursor ? decodeSessionCursor(q.data.cursor) : null;
    if (q.data.cursor && !after) return c.json({ error: 'cursor is not one this list gave out' }, 400);
    if (q.data.project && !(await d.inScope(q.data.project))) return c.json({ error: 'not a selected project: choose it in Settings to see its sessions' }, 404);
    const keys = q.data.project ? [q.data.project] : await d.projects();
    const { sessions, next } = await d.store.list({ projectKeys: keys, state: q.data.state, limit: q.data.limit, after, run: currentRun()?.id ?? null });
    return c.json({ sessions, next: next ? encodeSessionCursor(next) : null });
  });

  app.get('/api/sessions/:id', async (c) => {
    const s = await d.store.detail(c.req.param('id'));
    if (!s || (s.sandbox && s.run !== currentRun()?.id) || !(await d.inScope(s.projectKey))) return c.json({ error: 'not found' }, 404);
    return c.json(s);
  });

  app.post('/api/sessions/:id/resummarize', async (c) => {
    const s = await d.store.detail(c.req.param('id'));
    if (!s || (s.sandbox && s.run !== currentRun()?.id) || !(await d.inScope(s.projectKey))) return c.json({ error: 'not found' }, 404);
    if (s.prunedTurns > 0) {
      return c.json({ error: `${s.prunedTurns} turn${s.prunedTurns === 1 ? '' : 's'} of this session had their text removed by TURN_RETENTION_DAYS, so a rebuild would lose them; the current summary is kept` }, 409);
    }
    await d.store.requestRebuild(s.id);
    return c.json({ queued: true }, 202);
  });
}
