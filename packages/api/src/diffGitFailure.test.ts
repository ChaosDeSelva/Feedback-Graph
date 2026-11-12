import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

// git itself, except that its no-index diff fails the way a killed or broken git would (no exit code 1).
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = ((file: string, args: string[], opts: object, cb: (e: unknown, stdout?: string, stderr?: string) => void) => {
    if (args.includes('--no-index') && args.includes('diff')) return void cb(Object.assign(new Error('killed'), { code: null, signal: 'SIGTERM', stdout: 'partial', stderr: '' }));
    return real.execFile(file, args, opts, cb as never);
  }) as typeof real.execFile;
  Object.assign(execFile, { [promisify.custom]: (file: string, args: string[], opts: object) => new Promise((resolve, reject) => {
    execFile(file, args, opts, (e: unknown, stdout: unknown, stderr: unknown) => (e ? reject(e) : resolve({ stdout, stderr })));
  }) });
  return { ...real, execFile };
});

test('a file whose diff git fails to produce is left out instead of failing the check or showing a partial diff', async () => {
  const { readRepoDiff } = await import('./diff.ts');
  const dir = mkdtempSync(join(tmpdir(), 'fg-diff-fail-'));
  try {
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a]);
    writeFileSync(join(dir, 'a.ts'), 'a\n');
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.ts'), 'b\n');
    expect(await readRepoDiff(dir, ['a.ts'])).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
