import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ownPrNumberReader } from './service.ts';

const dir = mkdtempSync(join(tmpdir(), 'fg-api-prs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
git('init', '-q');
writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
git('add', '-A');
git('commit', '-qm', 'add the search box (#42)');
const sha = git('rev-parse', 'HEAD');
const task = `finish ${sha.slice(0, 10)}`;

/** A reader over this repository, recording GitHub association lookups (each answers PR 7). */
function reader(o: { token?: string | null; github?: boolean; repos?: [string, string][]; remote?: string | null } = {}) {
  const lookups: [string, string, string][] = [];
  const links: string[] = [];
  const read = ownPrNumberReader({
    roots: [],
    integrations: {
      credential: async () => (o.token === null ? null : { token: o.token ?? 'tok', source: 'env', fingerprint: 'f' }),
      link: async (key) => { links.push(key); return { github: o.github ?? true, linearTeamId: null, linearTeamName: null }; },
    },
    projects: async () => [{ key: 'alpha', remote: o.remote === undefined ? 'github.com/org/alpha' : o.remote }],
    githubRepos: new Map(o.repos ?? []),
    commitPrs: async (repo, s, token) => { lookups.push([repo, s, token]); return [7]; },
  });
  return { read, lookups, links };
}

test('a linked GitHub project with a token adds the PRs GitHub associates with the named commit to the ones its message names', async () => {
  const r = reader();
  expect((await r.read(dir, task, 'alpha')).sort()).toEqual([42, 7].sort());
  expect(r.lookups).toEqual([['org/alpha', sha, 'tok']]);
});

test('GITHUB_REPOS names the repository over the remote the worker read', async () => {
  const r = reader({ repos: [['alpha', 'org/renamed']] });
  await r.read(dir, task, 'alpha');
  expect(r.lookups).toEqual([['org/renamed', sha, 'tok']]);
});

test('without a token, a GitHub link, a known repository or a project, only the commit messages are read', async () => {
  for (const [why, r, key] of [
    ['no token', reader({ token: null }), 'alpha'],
    ['unlinked', reader({ github: false }), 'alpha'],
    ['no remote', reader({ remote: null }), 'alpha'],
    ['not a GitHub remote', reader({ remote: 'gitlab.com/org/alpha' }), 'alpha'],
    ['unknown project', reader(), 'beta'],
    ['no project', reader(), undefined],
  ] as const) {
    expect(await r.read(dir, task, key), why).toEqual([42]);
    expect(r.lookups, why).toEqual([]);
  }
  const none = reader();
  await none.read(dir, task);
  expect(none.links).toEqual([]);
});
