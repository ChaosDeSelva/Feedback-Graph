import { spawn } from 'node:child_process';

// Node builtins only: the codex-runner image copies this file (and codexRunner.ts) without the rest of the repo.

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
  o: { cwd: string; stdin: string; env: NodeJS.ProcessEnv; timeoutMs: number; killGraceMs?: number },
) => Promise<ExecResult>;

/** Process groups of running CLI agents, so shutdown can stop them (they are detached and would outlive the worker). */
const running = new Set<number>();
export function killRunningCommands() {
  for (const pid of running) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
  running.clear();
}

export const execCommand: Exec = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    // Its own process group, so a timeout takes down the tools it spawned too (they hold the pipes open).
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const pid = child.pid;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const killGroup = (sig: NodeJS.Signals) => {
      if (exited()) return; // never signal a group id the OS may already have reused
      try {
        if (pid) process.kill(-pid, sig);
      } catch {
        child.kill(sig); // group already gone
      }
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    // SIGTERM first so the CLI can clean up; SIGKILL if it ignores that, so a stuck agent can never hang the worker.
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killer = setTimeout(() => killGroup('SIGKILL'), o.killGraceMs ?? 10_000);
    }, o.timeoutMs);
    if (pid) running.add(pid);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (pid) running.delete(pid);
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
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });
    child.stdin.end(o.stdin);
  });
