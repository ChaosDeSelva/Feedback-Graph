import { spawn } from 'node:child_process';

// Node builtins only: the codex-runner image copies this file (and codexRunner.ts) without the rest of the repo.

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
  o: { cwd: string; stdin: string; env: NodeJS.ProcessEnv; timeoutMs: number; killGraceMs?: number },
) => Promise<ExecResult>;
/** process.kill's shape; a negative pid signals that process group. */
export type Kill = (pid: number, signal: NodeJS.Signals) => void;

/** Stops each running CLI agent and the tools it started, so shutdown can stop them (detached, they would outlive the worker). */
const running = new Set<() => void>();
export function killRunningCommands() {
  for (const stop of running) stop();
  running.clear();
}

/** execCommand with its signals sent through `kill` (tests inject failures). */
export const commandRunner = (kill: Kill): Exec => (cmd, args, o) =>
  new Promise((resolve, reject) => {
    // Its own process group, so a timeout takes down the tools it spawned too (they hold the pipes open).
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    // No pid when it could not be started (ENOENT, EACCES): 'error' follows on the next tick, before any signal.
    const pid = child.pid as number;
    // The group even once the CLI itself has exited: a tool it left behind still holds the pipes, so the command has not
    // closed, and until it closes the group id is not reused (a member, or the unreaped leader, holds it).
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        kill(-pid, sig);
      } catch {
        // the group is gone: whatever holds the pipes left it
      }
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    // SIGTERM first so the CLI can clean up; SIGKILL if it ignores that, so a stuck agent can never hang the worker.
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      killer = setTimeout(() => signalGroup('SIGKILL'), o.killGraceMs ?? 10_000);
    }, o.timeoutMs);
    // Stopped at shutdown is a failure even when the CLI exits 0: it can see its tool die before its own SIGKILL lands.
    let stopped = false;
    const stop = () => {
      stopped = true;
      signalGroup('SIGKILL');
    };
    running.add(stop);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(killer);
      running.delete(stop);
    };
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code) => {
      done();
      if (timedOut) stderr += `\n${cmd} timed out after ${o.timeoutMs}ms`;
      resolve({ code: timedOut ? 124 : stopped ? 1 : (code ?? 1), stdout, stderr });
    });
    // A command that exits without reading all its input closes the pipe (EPIPE): its exit status says what happened,
    // and an unhandled 'error' on stdin would crash the process running it.
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin);
  });

export const execCommand: Exec = commandRunner((pid, signal) => process.kill(pid, signal));
