import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterOverrides } from '@fb/core';
import { afterEach, expect, test } from 'vitest';
import { churn } from './codegraph/churn.ts';
import { repoFingerprint } from './codegraph/stage.ts';
import { commitsInWindow, projectRemote } from './ingest/git.ts';
import { grepMentions, readManifests } from './links/detect.ts';
import { gitChurn } from './scan/priority.ts';
import { candidatePaths } from './scan/scan.ts';

// The repos under the roots are not ours. Their config and attributes can name commands (clean and process filters,
// textconv, external diff, fsmonitor, hooks, a signature program for log) that a git command run on them would start.
// None of the worker's git calls may start one: each writes a line to a marker file here if it runs.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function hostileRepo() {
  const base = mkdtempSync(join(tmpdir(), 'fbgitsafe-'));
  dirs.push(base);
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const marker = join(base, 'marker');
  const hook = join(base, 'hook.sh');
  // Records its role; as a filter or textconv it passes its input through so git sees sane output.
  writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${marker}'\ncase "$1" in clean|textconv) cat "\${2:--}" ;; esac\nexit 0\n`);
  chmodSync(hook, 0o755);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const app = "demo-shop";\n');
  writeFileSync(join(repo, 'README.md'), '# demo-shop\nuses acme-lib\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"demo-shop","dependencies":{"acme-lib":"1.0.0"}}\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const app = "demo-shop!";\n');
  git('commit', '-qam', 'second');
  // Now the repo turns hostile: attributes in the tree and in .git/info, and config naming commands for each.
  writeFileSync(join(repo, '.gitattributes'), '* filter=mark diff=mark\n');
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.md filter=other.name\n');
  const set = (k: string, v: string) => git('config', '--local', k, v);
  set('filter.mark.clean', `${hook} clean`);
  set('filter.mark.smudge', `${hook} smudge`);
  set('filter.mark.required', 'true');
  set('filter.other.name.process', `${hook} process`);
  set('diff.mark.textconv', `${hook} textconv`);
  set('diff.external', `${hook} external`);
  set('core.fsmonitor', `${hook} fsmonitor`);
  set('log.showSignature', 'true');
  set('gpg.program', `${hook} gpg`);
  set('core.hooksPath', join(repo, '.git', 'hooks'));
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  for (const h of ['post-index-change', 'post-checkout', 'pre-commit']) {
    writeFileSync(join(repo, '.git', 'hooks', h), `#!/bin/sh\n'${hook}' hook-${h}\n`);
    chmodSync(join(repo, '.git', 'hooks', h), 0o755);
  }
  // Racily dirty: same size and content, a new mtime, so git status must read (and clean) the file to compare it.
  const later = new Date(Date.now() + 5_000);
  for (const f of ['src/app.ts', 'README.md', 'package.json']) utimesSync(join(repo, f), later, later);
  // And one real edit of the same length.
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const app = "demo-shop?";\n');
  const ran = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : []);
  return { repo, ran, hook };
}

test('the stand-in commands do run under plain git, so the test below can see them', () => {
  const r = hostileRepo();
  // Exercise the clean filter directly; the deliberately invalid process filter makes status abort on some Git versions.
  execFileSync('git', ['-C', r.repo, 'hash-object', '--path=src/app.ts', 'src/app.ts'], { stdio: 'pipe' });
  expect(r.ran()).toEqual(expect.arrayContaining(['clean']));
});

test('no git call the worker makes on a repo runs a command the repo configures', async () => {
  const r = hostileRepo();
  // After each call, so a failure names the call that started a command.
  const ran: Record<string, string[]> = {};
  const after = async <T>(name: string, p: Promise<T>) => {
    const v = await p;
    ran[name] = r.ran();
    return v;
  };
  const fp = await after('repoFingerprint', repoFingerprint(r.repo, 100));
  expect(fp).toMatch(/^[0-9a-f]{64}$/);
  // The edited file still shows: the fingerprint changes when it changes again.
  writeFileSync(join(r.repo, 'src', 'app.ts'), 'export const app = "demo-shop.";\n');
  expect(await after('repoFingerprint again', repoFingerprint(r.repo, 100))).not.toBe(fp);
  expect((await after('churn', churn(r.repo, 90))).get('src/app.ts')?.commits).toBe(2);
  expect((await after('gitChurn', gitChurn(r.repo))).get('src/app.ts')).toBe(2);
  const now = Date.now();
  expect(await after('commitsInWindow', commitsInWindow(r.repo, new Date(now - 86_400_000).toISOString(), new Date(now + 86_400_000).toISOString()))).toHaveLength(2);
  await after('projectRemote', projectRemote(r.repo));
  expect(await after('candidatePaths', candidatePaths(r.repo))).toEqual(expect.arrayContaining(['src/app.ts']));
  expect((await after('grepMentions', grepMentions(r.repo, ['acme-lib']))).get('acme-lib')).toEqual(expect.arrayContaining(['README.md']));
  await after('readManifests', readManifests(r.repo));
  expect(ran).toEqual(Object.fromEntries(Object.keys(ran).map((k) => [k, []])));
});

test('filterOverrides switches off every configured filter, dotted names too; a name -c cannot carry gives null', () => {
  expect(filterOverrides('filter.lfs.clean\0filter.lfs.process\0filter.a.b.smudge\0')).toEqual([
    '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
    '-c', 'filter.a.b.clean=', '-c', 'filter.a.b.process=', '-c', 'filter.a.b.required=false',
  ]);
  expect(filterOverrides('')).toEqual([]);
  expect(filterOverrides('filter.x=y.clean\0')).toBeNull();
  expect(filterOverrides('filter.x\ny.clean\0')).toBeNull();
});

test('a filter whose name cannot be switched off: no git status at all, so the map falls back to file sizes and times', async () => {
  const r = hostileRepo();
  const config = join(r.repo, '.git', 'config');
  writeFileSync(config, `${readFileSync(config, 'utf8')}[filter "x=y"]\n\tclean = ${r.hook} clean\n`);
  writeFileSync(join(r.repo, '.gitattributes'), '* filter=x=y\n');
  const logged: string[] = [];
  expect(await repoFingerprint(r.repo, 100, { log: (m) => logged.push(m) })).toBeNull();
  expect(logged).toEqual(['git status skipped: a filter name cannot be switched off']);
  expect(r.ran()).toEqual([]);
});
