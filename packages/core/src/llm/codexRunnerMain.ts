import { runCodexRunner } from './codexRunner.ts';

// The codex-runner container's entry point (Dockerfile target codex-runner). It logs no job content and never the token.
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

await runCodexRunner({
  scratch: process.env.RUNNER_SCRATCH || '/scratch',
  port: Number(process.env.RUNNER_PORT || 8790),
  host: '0.0.0.0',
  log,
  signals: process,
  exit: (code) => process.exit(code),
});
