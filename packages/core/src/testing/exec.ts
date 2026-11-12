/**
 * Child processes for tests, run asynchronously. execFileSync/spawnSync block the vitest worker's event loop for as
 * long as the child runs, so the worker cannot answer the runner's RPC and a long script test ends the run with
 * "Timeout calling onTaskUpdate" even though every test passed. Test-only: production code never imports this.
 */
import { spawn } from 'node:child_process';

/** timeout: milliseconds before the child is sent SIGTERM (it then ends with that signal and status null). */
/**
 * The timeout for a test that runs real scripts. Only a hang guard, not a speed check: each run forks dozens of
 * processes, and on a heavily loaded machine (load average several times the core count) one test that takes a second
 * when idle has taken over 20.
 */
export const SCRIPT_TEST_TIMEOUT_MS = 120_000;

export type ExecOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number };
export type ExecResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/** Runs file with args to the end, like spawnSync: never rejects for a failing exit, only when it cannot start. */
export function execResult(file: string, args: readonly string[], o: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, timeout: o.timeout, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    // A child that exits without reading its input closes the pipe; that is its business, not an error here.
    child.stdin.on('error', () => {});
    child.stdin.end(o.input ?? '');
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

/** A failed exec: the exit status and both outputs, as execFileSync's error carries them. */
export class ExecError extends Error {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  constructor(file: string, r: ExecResult) {
    super(`${file} exited ${r.status ?? r.signal}: ${r.stderr.trim()}`);
    this.status = r.status;
    this.signal = r.signal;
    this.stdout = r.stdout;
    this.stderr = r.stderr;
  }
}

/** Runs file with args and resolves with its stdout, like execFileSync: a non-zero exit rejects with an ExecError. */
export async function exec(file: string, args: readonly string[], o: ExecOptions = {}): Promise<string> {
  const r = await execResult(file, args, o);
  if (r.status !== 0) throw new ExecError(file, r);
  return r.stdout;
}
