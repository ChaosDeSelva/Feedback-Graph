import type { ServerResponse } from 'node:http';
import { db } from '../db.ts';
import { paginate, sendError, sendJson, type Req } from '../http.ts';

export function listCustomers(req: Req, res: ServerResponse) {
  sendJson(res, 200, paginate(db.scoped(req.auth.orgId).list('customers'), req.query));
}

export function getCustomer(req: Req, res: ServerResponse) {
  const row = db.scoped(req.auth.orgId).get('customers', req.params.id);
  if (!row) return sendError(res, 404, 'not_found', 'customer not found');
  sendJson(res, 200, row);
}
