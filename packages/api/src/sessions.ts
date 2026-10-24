import type { Hono } from 'hono';
import { z } from 'zod';
import { decodeSessionCursor, encodeSessionCursor, SESSION_STATES, type SessionsStore } from '@fb/core';

export type SessionsDeps = {
  store: Pick<SessionsStore, 'list' | 'detail' | 'requestRebuild'>;
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

/**
 * GET /api/sessions (newest first, paged by `cursor`), GET /api/sessions/:id (the summary, its history, the Inbox items
 * from the session), and POST /api/sessions/:id/resummarize (owner-only, registered in app.ts): rebuild from scratch.
 */
export function sessionRoutes(app: Hono, d: SessionsDeps) {
  app.get('/api/sessions', async (c) => {
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const after = q.data.cursor ? decodeSessionCursor(q.data.cursor) : null;
    if (q.data.cursor && !after) return c.json({ error: 'cursor is not one this list gave out' }, 400);
    if (q.data.project && !(await d.inScope(q.data.project))) return c.json({ error: 'not a selected project: choose it in Settings to see its sessions' }, 404);
    const keys = q.data.project ? [q.data.project] : await d.projects();
    const { sessions, next } = await d.store.list({ projectKeys: keys, state: q.data.state, limit: q.data.limit, after });
    return c.json({ sessions, next: next ? encodeSessionCursor(next) : null });
  });

  app.get('/api/sessions/:id', async (c) => {
    const s = await d.store.detail(c.req.param('id'));
    if (!s || !(await d.inScope(s.projectKey))) return c.json({ error: 'not found' }, 404);
    return c.json(s);
  });

  app.post('/api/sessions/:id/resummarize', async (c) => {
    const s = await d.store.detail(c.req.param('id'));
    if (!s || !(await d.inScope(s.projectKey))) return c.json({ error: 'not found' }, 404);
    if (s.prunedTurns > 0) {
      return c.json({ error: `${s.prunedTurns} turn${s.prunedTurns === 1 ? '' : 's'} of this session had their text removed by TURN_RETENTION_DAYS, so a rebuild would lose them; the current summary is kept` }, 409);
    }
    await d.store.requestRebuild(s.id);
    return c.json({ queued: true }, 202);
  });
}
