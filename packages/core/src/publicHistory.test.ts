import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { execResult } from './testing/exec.ts';

// scripts/check-public-history.sh, run against throwaway repositories. A push publishes every commit, so a path or
// a planning document that was removed later still leaks; the script checks the whole history of a ref.
const script = join(import.meta.dirname, '../../../scripts/check-public-history.sh');
// Built at run time so this file's own text never holds a real-looking home folder.
const realHome = ['', 'Users', 'somebody'].join('/');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fbhist-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  const commit = (file: string, text: string | null, msg = 'c') => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    if (text === null) rmSync(join(dir, file));
    else writeFileSync(join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
  };
  const check = async (ref?: string, env: Record<string, string> = {}) => {
    const r = await execResult('bash', [script, ...(ref ? [ref] : [])], { cwd: dir, env: { ...process.env, ...env } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { dir, git, commit, check };
}

test('a clean history with placeholder home folders passes', async () => {
  const r = repo();
  r.commit('README.md', 'cd /Users/you/code/demo\nls ~/.claude/projects/-Users-me-code-demo-\n');
  expect(await r.check()).toMatchObject({ code: 0 });
});

test('a real home folder fails even after a later commit removed it', async () => {
  const r = repo();
  r.commit('config.ts', `const roots = '${realHome}/Vibe';\n`);
  r.commit('config.ts', "const roots = '/Users/you/code';\n");
  const res = await r.check();
  expect(res.code).toBe(1);
  expect(res.out).toContain(`home folder ${realHome}`);
  // Claude Code's folder names spell the path with dashes.
  const d = repo();
  d.commit('fixture.jsonl', `{"path":"-${realHome.slice(1).replaceAll('/', '-')}-Vibe-demo"}\n`);
  expect((await d.check()).code).toBe(1);
});

test('a planning document under docs/strategy/ anywhere in history fails', async () => {
  const r = repo();
  r.commit('docs/strategy/plan.md', 'pricing\n');
  r.commit('docs/strategy/plan.md', null);
  const res = await r.check();
  expect(res.code).toBe(1);
  expect(res.out).toContain('docs/strategy/plan.md');
});

test('names in the private names file fail without being printed; only the given ref is checked', async () => {
  const r = repo();
  r.commit('a.md', 'clean\n');
  r.git('branch', 'public');
  r.commit('b.md', 'notes on SecretProject_2\n');
  r.commit('b.md', null);
  writeFileSync(join(r.dir, '.git', 'info', 'private-names'), '# private projects\nSecretProject_2\n');
  const res = await r.check('main');
  expect(res.code).toBe(1);
  expect(res.out).toMatch(/private name #2/);
  expect(res.out).not.toContain('SecretProject_2');
  expect((await r.check('public')).code).toBe(0);
  expect((await r.check('main', { PRIVATE_NAMES_FILE: join(r.dir, 'none') })).code).toBe(0);
});
