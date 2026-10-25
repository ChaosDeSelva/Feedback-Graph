import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeStores } from '@fb/core/testing';
import { afterEach, expect, test } from 'vitest';
import { buildCodeMap } from './codemap.ts';
import { MapStage } from './stage.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fbmap-'));
  dirs.push(dir);
  const w = (p: string, c: string) => {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  w('src/db.ts', 'export class Db {\n  query() {}\n}\n');
  w('src/api.ts', "import { Db } from './db.ts';\nexport function route() { return new Db(); }\n");
  w('test/api.test.ts', "import { route } from '../src/api.ts';\n");
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'one');
  return { dir, w, git };
}

const OPTS = { maxFiles: 100, maxBytes: 100_000 };

describeStores('Code map stage', (h) => {
  test('a real repo is mapped, read back losslessly, and rebuilt incrementally from what was stored', async () => {
    const r = repo();
    const stage = new MapStage({ store: h.store.codegraph, activity: h.store.activity, projects: async () => [], ...OPTS });
    const first = await stage.mapProject({ key: 'demo', repoPath: r.dir }, null);
    expect(first).toMatchObject({ files: 3, symbols: 3, imports: 2, tests: 2 });
    const stored = (await h.store.codegraph.codeMap('demo'))!;
    const fresh = await buildCodeMap(r.dir, OPTS);
    const { candidates, unresolved: _unresolved, ...parts } = fresh;
    expect({ files: stored.files, symbols: stored.symbols, imports: stored.imports, outside: stored.outside ?? [] }).toEqual(parts);
    expect((await h.store.codegraph.codeMapMeta('demo'))?.candidates).toBe(candidates);

    const db = (await h.store.codegraph.moduleContext('demo', 'src/db.ts'))!;
    expect(db.importers).toEqual(['src/api.ts']);
    expect(db.tests).toEqual(['test/api.test.ts']);
    expect(db.file.churn?.commits).toBe(1);

    // nothing changed: no rebuild, no log entry
    expect(await stage.mapProject({ key: 'demo', repoPath: r.dir }, null)).toBeNull();
    r.w('src/cli.ts', "import { Db } from './db.ts';\n");
    expect(await stage.mapProject({ key: 'demo', repoPath: r.dir }, null)).toMatchObject({ files: 4, imports: 3 });
    expect((await h.store.codegraph.moduleContext('demo', 'src/db.ts'))!.importers).toEqual(['src/api.ts', 'src/cli.ts']);
    const log = await h.store.activity.list({ projectKey: 'demo', kind: 'code_mapped' });
    expect(log.map((a) => a.why)).toEqual(['the repo changed since the last map', 'first map of this project']);
    expect(log[0].details).toMatchObject({ files: 4, incremental: true, durationMs: expect.any(Number) });
  });
});
