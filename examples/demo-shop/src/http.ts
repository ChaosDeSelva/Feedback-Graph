import type { IncomingMessage, ServerResponse } from 'node:http';

export type Req = { auth: { orgId: string }; query: Record<string, string>; params: Record<string, string> };

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { error: { code, message } });
}

/** Server-side pagination: default 20, max 50. */
export function paginate<T>(rows: T[], query: Record<string, string>) {
  const limit = Math.min(Number(query.limit ?? 20) || 20, 50);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

/** Demo auth: the org comes from the x-org header. */
export function authOf(req: IncomingMessage): { orgId: string } | null {
  const org = req.headers['x-org'];
  return typeof org === 'string' && org ? { orgId: org } : null;
}
