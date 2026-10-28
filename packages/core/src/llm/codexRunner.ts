import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execCommand, type Exec } from './exec.ts';

/*
 * The codex-runner sidecar (docker-compose.yml, profile "codex") and the worker's client for it.
 *
 * Codex's read-only sandbox reads the whole filesystem, so the only way to confine it is to run it where there is
 * nothing else to read: a container holding the Codex CLI, its login and a scratch volume. The worker writes a
 * filtered mirror of the repository (mirror.ts) into that volume and asks the runner, over the compose network, to run
 * `codex exec` on it. The runner refuses any directory outside the scratch volume. Requests carry a random token the
 * runner writes into the scratch volume at startup, which only the worker and the runner mount.
 *
 * Node builtins only: the runner image copies this file and exec.ts, nothing else of the repo.
 */

/** Lease metadata is beside the mirror, never exposed inside the repository mounted for a job. */
export const mirrorLeasePath = (dir: string) => join(resolve(dir, '..'), `.${dir.split('/').at(-1)}.lease`);
/** Sweep abandoned copies in both worker and runner; renewable leases protect live and queued mirrors. */
export async function purgeStaleRunnerMirrors(scratch: string, keep?: string, now = Date.now(), worker = false): Promise<void> {
  for (const name of await readdir(scratch).catch(() => [] as string[])) {
    if (!/^fb-mirror-[A-Za-z0-9]+$/.test(name)) continue;
    const path = join(scratch, name);
    if (keep && resolve(path) === resolve(keep)) continue;
    const leasePath = mirrorLeasePath(path);
    const lease = await readFile(leasePath, 'utf8').then(v => JSON.parse(v) as { pid: number; host: string }).catch(() => null);
    const info = await stat(lease ? leasePath : path).catch(() => null);
    let dead = false;
    if (worker && lease?.host === hostname() && Number.isInteger(lease.pid) && lease.pid > 0) {
      try { process.kill(lease.pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
    if (dead || (info && now - info.mtimeMs > 5 * 60_000)) {
      await rm(path, { recursive: true, force: true });
      await rm(leasePath, { force: true });
    }
  }
}

export const RUNNER_TOKEN_FILE = '.runner-token';
export const RUNNER_DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const RUNNER_MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const OUTPUT_TAIL = 64_000;
/** Undici gives up on a response that sends nothing for 300 s; a byte of whitespace keeps a long job's answer alive. */
const KEEPALIVE_MS = 20_000;
const MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,63}$/;

/** The exact `codex exec` flags, shared by the runner and the unconfined in-worker path so they cannot drift apart. */
export function codexArgs(o: { dir: string; schemaPath: string; outPath: string; model?: string }): string[] {
  const args = ['exec', '-s', 'read-only', '-C', o.dir, '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema', o.schemaPath, '-o', o.outPath];
  if (o.model) args.push('-m', o.model);
  args.push('-');
  return args;
}

/** A fresh mount/PID namespace: only this job's mirror, output folder and login are visible. */
export function isolatedRunnerArgs(o: { dir: string; work: string; auth: string; bin: string; args: string[] }): string[] {
  return [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/codex',
    '--bind-try', o.auth, '/codex/auth.json', '--ro-bind', o.dir, '/repo', '--bind', o.work, o.work,
    '--chdir', '/repo', '--setenv', 'CODEX_HOME', '/codex', '--setenv', 'HOME', '/tmp', '--', o.bin, ...o.args,
  ];
}

/** One job: `mirror` is a directory in the scratch volume, relative to it (or absolute inside it). */
export type RunnerJob = { prompt: string; mirror: string; schema: object; model?: string; timeoutMs?: number };
/** `output` is the file codex wrote with `-o` (the final answer), or null when it wrote none. */
export type RunnerResult = { code: number; stdout: string; stderr: string; output: string | null };

export class RunnerRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * The job's directory, resolved and checked: strictly inside the scratch volume (never the volume itself), no `..`
 * segments, and still inside once symlinks are resolved. Anything else is refused before codex starts.
 */
export async function resolveMirror(scratch: string, raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) throw new RunnerRequestError(400, 'mirror must be a directory in the scratch volume');
  if (raw.split(/[\\/]+/).includes('..')) throw new RunnerRequestError(400, 'mirror must not contain ".."');
  const lexicalRoot = resolve(scratch);
  const root = await realpath(scratch);
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  // Checked before touching the path, so the answer says nothing about what exists outside the volume.
  if (!inside(lexicalRoot, abs) && !inside(root, abs)) throw new RunnerRequestError(403, 'mirror must be inside the scratch volume');
  const real = await realpath(abs).catch(() => null);
  if (!real) throw new RunnerRequestError(400, 'mirror does not exist');
  if (!inside(root, real)) throw new RunnerRequestError(403, 'mirror must be inside the scratch volume');
  if (!(await stat(real)).isDirectory()) throw new RunnerRequestError(400, 'mirror is not a directory');
  return real;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** `Authorization: Bearer <token>`, compared in constant time. */
export function runnerAuthorized(header: string | undefined, token: string): boolean {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  return !!m && !!token && timingSafeEqual(digest(m[1]), digest(token));
}

/** A fresh token in the scratch volume, written atomically and readable by its owner only. */
export async function writeRunnerToken(scratch: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const tmp = join(scratch, `${RUNNER_TOKEN_FILE}.${process.pid}.tmp`);
  await writeFile(tmp, token, { mode: 0o600 });
  await rename(tmp, join(scratch, RUNNER_TOKEN_FILE));
  return token;
}

/** Codex gets the container's basics and its login folder; the runner has no secrets, and this keeps it that way. */
function runnerEnv(from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'CODEX_HOME'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (from[k] !== undefined) env[k] = from[k];
  return env;
}

export type RunnerOpts = {
  scratch: string;
  token: string;
  exec?: Exec;
  /** The CLI to run; tests pass a stand-in. */
  bin?: string;
  /** Disable only for local test stand-ins. Production always uses an outer mount namespace and fails closed. */
  isolate?: boolean;
  env?: NodeJS.ProcessEnv;
  maxTimeoutMs?: number;
  killGraceMs?: number;
  keepaliveMs?: number;
  healthTimeoutMs?: number;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(new RunnerRequestError(413, 'job is too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

function parseJob(body: string): RunnerJob {
  let j: Partial<RunnerJob>;
  try {
    j = JSON.parse(body) as Partial<RunnerJob>;
  } catch {
    throw new RunnerRequestError(400, 'job is not JSON');
  }
  if (!j || typeof j !== 'object') throw new RunnerRequestError(400, 'job is not an object');
  if (typeof j.prompt !== 'string' || !j.prompt) throw new RunnerRequestError(400, 'prompt is required');
  if (!j.schema || typeof j.schema !== 'object' || Array.isArray(j.schema)) throw new RunnerRequestError(400, 'schema must be a JSON schema object');
  if (j.model !== undefined && (typeof j.model !== 'string' || !MODEL_RE.test(j.model))) throw new RunnerRequestError(400, 'model must be a model name');
  if (j.timeoutMs !== undefined && (typeof j.timeoutMs !== 'number' || !Number.isFinite(j.timeoutMs) || j.timeoutMs <= 0)) {
    throw new RunnerRequestError(400, 'timeoutMs must be a positive number');
  }
  return j as RunnerJob;
}

const tail = (s: string) => (s.length > OUTPUT_TAIL ? s.slice(-OUTPUT_TAIL) : s);
const send = (res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** The runner's request handler: GET /health, and POST /run (one job at a time). */
export function createCodexRunner(o: RunnerOpts) {
  const exec = o.exec ?? execCommand;
  const max = o.maxTimeoutMs ?? RUNNER_MAX_TIMEOUT_MS;
  let busy = false;
  let checkedAt = 0;
  let lastHealth: { ok: boolean; sandbox: boolean; error?: string } | null = null;
  let probing: Promise<{ ok: boolean; sandbox: boolean; error?: string }> | null = null;
  async function health() {
    if (o.isolate === false) return { ok: true, sandbox: false };
    if (lastHealth && (busy || Date.now() - checkedAt < 30_000)) return lastHealth;
    if (probing) return probing;
    probing = (async () => {
      const work = await mkdtemp(join(tmpdir(), 'fb-runner-probe-'));
      try {
        const probe = ['-e', "if(require('fs').existsSync('/scratch'))process.exit(2)"];
        // Exercise the nested user/network/PID/proc sandbox, with no model call or login needed.
        const inner = isolatedRunnerArgs({ dir: '/repo', work, auth: '/codex/auth.json', bin: 'node', args: probe });
        inner.unshift('--unshare-net');
        const args = isolatedRunnerArgs({ dir: work, work, auth: join((o.env ?? process.env).CODEX_HOME ?? '/codex', 'auth.json'), bin: 'bwrap', args: inner });
        const r = await exec('bwrap', args, { cwd: work, stdin: '', env: runnerEnv(o.env ?? process.env), timeoutMs: o.healthTimeoutMs ?? 5000 });
        if (r.code !== 0) throw new Error(r.stderr.slice(0, 300) || `sandbox probe exit ${r.code}`);
        lastHealth = { ok: true, sandbox: true };
      } catch (e) {
        lastHealth = { ok: false, sandbox: false, error: `Codex sandbox cannot start: ${String(e).slice(0, 400)}. Rebuild the runner and check the Docker procfs/AppArmor settings in docs/operations.md.` };
      } finally { await rm(work, { recursive: true, force: true }); checkedAt = Date.now(); }
      return lastHealth!;
    })().finally(() => { probing = null; });
    return probing;
  }

  async function run(job: RunnerJob, dir: string): Promise<RunnerResult> {
    const work = await mkdtemp(join(tmpdir(), 'fb-codex-'));
    try {
      const schemaPath = join(work, 'schema.json');
      const outPath = join(work, 'out.json');
      await writeFile(schemaPath, JSON.stringify(job.schema));
      const timeoutMs = Math.min(job.timeoutMs ?? RUNNER_DEFAULT_TIMEOUT_MS, max);
      const isolated = o.isolate !== false;
      const args = codexArgs({ dir: isolated ? '/repo' : dir, schemaPath, outPath, model: job.model });
      const r = await exec(isolated ? 'bwrap' : o.bin ?? 'codex', isolated ? isolatedRunnerArgs({
        dir, work, auth: join((o.env ?? process.env).CODEX_HOME ?? '/codex', 'auth.json'), bin: o.bin ?? 'codex', args,
      }) : args, {
        cwd: work,
        stdin: job.prompt,
        env: runnerEnv(o.env ?? process.env),
        timeoutMs,
        killGraceMs: o.killGraceMs,
      });
      return { code: r.code, stdout: tail(r.stdout), stderr: tail(r.stderr), output: await readFile(outPath, 'utf8').catch(() => null) };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health' && req.method === 'GET') { const h = await health(); return send(res, h.ok ? 200 : 503, { ...h, busy }); }
    if (path !== '/run') return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { allow: 'POST' });
    if (!runnerAuthorized(req.headers.authorization, o.token)) return send(res, 401, { error: 'missing or wrong token' });
    // One job at a time; a private mount/PID namespace hides all other mirrors.
    const ready = await health();
    if (!ready.ok) return send(res, 503, { error: ready.error, code: 'sandbox_unavailable' }, { 'retry-after': '30' });
    if (busy) return send(res, 503, { error: 'busy' }, { 'retry-after': '2' });
    busy = true;
    let keepalive: NodeJS.Timeout | undefined;
    try {
      let job: RunnerJob;
      let dir: string;
      try {
        job = parseJob(await readBody(req));
        dir = await resolveMirror(o.scratch, job.mirror);
      } catch (err) {
        const status = err instanceof RunnerRequestError ? err.status : 500;
        return send(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
      await purgeStaleRunnerMirrors(o.scratch, dir);
      // Accepted: headers now, whitespace while codex works, the result at the end (JSON ignores the whitespace).
      res.writeHead(200, { 'content-type': 'application/json' });
      keepalive = setInterval(() => res.write(' '), o.keepaliveMs ?? KEEPALIVE_MS);
      try {
        res.end(JSON.stringify(await run(job, dir)));
      } catch (err) {
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      clearInterval(keepalive);
      busy = false;
    }
  }

  return { handle, health, busy: () => busy };
}

/** The runner could not be asked at all (not started, unreachable, token missing, busy past the deadline). */
export class RunnerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerUnavailableError';
  }
}

const START_HINT = 'start it with docker compose --profile codex up -d (docs/operations.md)';

async function readToken(scratch: string): Promise<string> {
  const t = await readFile(join(scratch, RUNNER_TOKEN_FILE), 'utf8').catch(() => '');
  if (!t.trim()) throw new RunnerUnavailableError(`the codex runner has not written its token to ${scratch}: is it running? ${START_HINT}`);
  return t.trim();
}

/**
 * Send one job to the runner and wait for its result. Waits (until the job's own deadline) while the runner is busy
 * with another job, and re-reads the token once if the runner restarted with a new one.
 */
export async function runOnRunner(o: { url: string; scratch: string; job: RunnerJob; fetchImpl?: typeof fetch; retryMs?: number }): Promise<RunnerResult> {
  const f = o.fetchImpl ?? fetch;
  const endpoint = `${o.url.replace(/\/+$/, '')}/run`;
  const deadline = Date.now() + (o.job.timeoutMs ?? RUNNER_DEFAULT_TIMEOUT_MS);
  let token = await readToken(o.scratch);
  let reread = false;
  for (;;) {
    const left = Math.max(1, deadline - Date.now());
    let res: Response;
    try {
      res = await f(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...o.job, timeoutMs: left }),
        // The runner kills codex at `left` and answers right after; this only catches a runner that went away.
        signal: AbortSignal.timeout(left + 60_000),
      });
    } catch (err) {
      const why = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new RunnerUnavailableError(`cannot reach the codex runner at ${o.url} (${why}); ${START_HINT}`);
    }
    if (res.status === 401 && !reread) {
      reread = true;
      await res.text().catch(() => '');
      token = await readToken(o.scratch);
      continue;
    }
    if (res.status === 503) {
      const wait = o.retryMs ?? 2000;
      const unavailable = await res.text().catch(() => '');
      let reason = '';
      try { const body = JSON.parse(unavailable) as { error?: string; code?: string }; if (body.code === 'sandbox_unavailable') reason = body.error ?? 'sandbox unavailable'; } catch {}
      if (reason) throw new RunnerUnavailableError(reason);
      if (Date.now() + wait >= deadline) throw new RunnerUnavailableError('the codex runner stayed busy with another job until this one timed out');
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    let body: Partial<RunnerResult> & { error?: string };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`codex runner ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 401) throw new RunnerUnavailableError(`the codex runner refused the token in ${o.scratch}; restart both: docker compose restart codex-runner worker`);
    if (!res.ok || body.error !== undefined) throw new Error(`codex runner ${res.status}: ${body.error ?? text.slice(0, 300)}`);
    return { code: body.code ?? 1, stdout: body.stdout ?? '', stderr: body.stderr ?? '', output: body.output ?? null };
  }
}
