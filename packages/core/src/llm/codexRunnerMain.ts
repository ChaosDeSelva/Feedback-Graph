import { createServer } from 'node:http';
import { createCodexRunner, writeRunnerToken } from './codexRunner.ts';
import { killRunningCommands } from './exec.ts';

// The codex-runner container's entry point (Dockerfile target codex-runner). It logs no job content and never the token.
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

const scratch = process.env.RUNNER_SCRATCH || '/scratch';
const port = Number(process.env.RUNNER_PORT || 8790);
const token = await writeRunnerToken(scratch);
const runner = createCodexRunner({ scratch, token });
const server = createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.url !== '/health') log('request', { method: req.method, path: req.url, status: res.statusCode, ms: Date.now() - started });
  });
  runner.handle(req, res).catch((err) => {
    log('error', { error: String(err) });
    if (!res.headersSent) res.writeHead(500).end();
    else res.end();
  });
});
// A job can take as long as its timeout; only the request itself has to arrive promptly.
server.requestTimeout = 60_000;
server.listen(port, '0.0.0.0', () => log('codex runner listening', { port, scratch }));

const stop = () => {
  killRunningCommands();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('exit', killRunningCommands);
