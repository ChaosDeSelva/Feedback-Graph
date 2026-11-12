import { purgeAgentMirrors } from '@fb/core';
import { openStore } from '@fb/store-postgres';
import { fatalError } from './startup.ts';
import { runWorker } from './worker.ts';

await purgeAgentMirrors();

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

runWorker({ env: process.env, openStore, log, signals: process, exit: (code) => process.exit(code) }).catch((err) => {
  log('fatal', { error: fatalError(err) });
  process.exit(1);
});
