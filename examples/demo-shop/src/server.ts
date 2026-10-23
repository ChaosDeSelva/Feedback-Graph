import { createServer } from 'node:http';
import { authOf, sendError, type Req } from './http.ts';
import { getCustomer, listCustomers } from './routes/customers.ts';

type Handler = (req: Req, res: import('node:http').ServerResponse) => void;
const routes: [RegExp, Handler][] = [
  [/^\/customers$/, listCustomers],
  [/^\/customers\/(?<id>[\w-]+)$/, getCustomer],
];

export const server = createServer((req, res) => {
  const auth = authOf(req);
  if (!auth) return sendError(res, 401, 'unauthenticated', 'missing x-org header');
  const url = new URL(req.url ?? '/', 'http://local');
  for (const [re, handler] of routes) {
    const m = url.pathname.match(re);
    if (m) return handler({ auth, query: Object.fromEntries(url.searchParams), params: m.groups ?? {} }, res);
  }
  sendError(res, 404, 'not_found', 'no such route');
});

if (import.meta.main) server.listen(3000, () => console.log('demo-shop on :3000'));
