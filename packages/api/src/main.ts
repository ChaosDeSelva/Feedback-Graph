import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { apiAuthConfigured, apiAuthStateFile, AUTH_STATE_BEAT_MS, ConfigError, loadConfig, VERSION, writeAuthState } from '@fb/core';
import { openStore } from '@fb/store-postgres';
import { authStateBeat, createApiService, openApiStore, shutdownHandler } from './service.ts';
import { tuneServer } from './server.ts';

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

// First, before anything that can fail: the worker's learning loop only observes until this API listens with a token
// (authState.ts), never on what an earlier start of it wrote.
const authStateFile = apiAuthStateFile(process.env);
await writeAuthState(authStateFile, false);

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (err) {
  log('fatal', { error: err instanceof ConfigError ? err.message : String(err) });
  process.exit(1);
}

const store = await openApiStore(config, openStore, log);
if (!store) process.exit(1);
const { app, closing } = await createApiService(config, store, process.env, log);

// API_LISTEN is 0.0.0.0 inside the container (compose publishes it on API_BIND); otherwise API_BIND, loopback by default.
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.apiListen }) as Server;
tuneServer(server);
const beat = authStateBeat({ file: authStateFile, configured: apiAuthConfigured(config), ping: () => store.ping(), log });
server.once('listening', () => {
  void beat();
  setInterval(() => void beat(), AUTH_STATE_BEAT_MS).unref();
});
log('api listening', { port: config.port, version: VERSION, bind: config.apiBind, auth: config.apiToken ? 'token' : 'none (loopback only)', operator: config.operator ? config.operator.allow.join(',') : 'off', publicHosts: config.publicHosts, cloudSync: config.cloud ? new URL(config.cloud.url).host : 'off' });
if (!config.apiToken) log(`no API_TOKEN set: reachable on ${config.apiBind} only; setting API_BIND to anything but loopback requires API_TOKEN`);

const shutdown = shutdownHandler({ server, closing, store, log, exit: (code) => process.exit(code) });
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
