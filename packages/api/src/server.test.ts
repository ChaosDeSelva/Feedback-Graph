import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { KEEP_ALIVE_MS, stopServer, tuneServer } from './server.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;

test('idle connections are kept 65 s (past the usual 60 s proxy and load balancer timeouts), headers a second longer', () => {
  const server = { keepAliveTimeout: 5000, headersTimeout: 60_000 } as Server;
  tuneServer(server);
  expect(KEEP_ALIVE_MS).toBe(65_000);
  expect(server.keepAliveTimeout).toBe(65_000);
  expect(server.headersTimeout).toBe(66_000);
});

test('a shutdown with an event stream open stops at once: the stream ends, the server closes', async () => {
  const closing = new AbortController();
  const app = createApp(repo, { system: { version: 'x', ping: async () => true, worker: async () => null }, closing: closing.signal });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s as Server));
  });
  tuneServer(server);
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const reader = res.body!.getReader();
  await reader.read();
  const started = Date.now();
  await stopServer(server, closing, { graceMs: 5000 });
  expect(Date.now() - started).toBeLessThan(2000);
  // The stream ended (or was cut): no hang.
  const drain = async (): Promise<boolean> => {
    for (;;) if ((await reader.read()).done) return true;
  };
  const end = await Promise.race([drain().catch(() => true), new Promise((r) => setTimeout(() => r('hung'), 2000))]);
  expect(end).toBe(true);
});
