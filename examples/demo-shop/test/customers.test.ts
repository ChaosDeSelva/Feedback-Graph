import assert from 'node:assert/strict';
import { test } from 'node:test';
import { server } from '../src/server.ts';

async function call(path: string, org: string) {
  await new Promise<void>((r) => (server.listening ? r() : server.listen(0, r)));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-org': org } });
  return { status: res.status, body: await res.json() };
}

test.after(() => server.close());

test('customers are scoped to the caller org and paginated', async () => {
  const r = await call('/customers', 'acme');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((c: { id: string }) => c.id), ['c1', 'c2']);
  assert.equal(r.body.limit, 20);
});

test('another org cannot read acme customers', async () => {
  const r = await call('/customers/c1', 'globex');
  assert.equal(r.status, 404);
});
