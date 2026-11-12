import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

// How often a build parses C#: counted at the extract module, which every parse goes through.
const calls = vi.hoisted(() => ({ extract: [] as string[], namespaces: 0 }));
vi.mock('./extract.ts', async (actual) => {
  const real = await actual<typeof import('./extract.ts')>();
  return {
    ...real,
    extract: (lang: string, source: string) => { if (lang === 'csharp') calls.extract.push(source.slice(0, 20)); return real.extract(lang, source); },
    csharpNamespaces: (source: string) => { calls.namespaces++; return real.csharpNamespaces(source); },
  };
});
const { buildCodeMap } = await import('./codemap.ts');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('a C# file is parsed once when it changes and not at all when it does not; its namespaces still resolve', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbcsparse-'));
  dirs.push(dir);
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('src/Models/Order.cs', 'namespace Shop.Models;\npublic class Order {}\n');
  w('src/Web/Ctl.cs', 'using Shop.Models;\nnamespace Shop.Web { public class Ctl { Order o; } }\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const opts = { maxFiles: 5000, maxBytes: 200_000 };
  const full = await buildCodeMap(dir, opts);
  expect([calls.extract.length, calls.namespaces]).toEqual([2, 0]);
  calls.extract.length = 0;
  const same = await buildCodeMap(dir, opts, full);
  expect([calls.extract.length, calls.namespaces]).toEqual([0, 0]);
  expect(same.imports.map((i) => [i.from, i.to])).toEqual([['src/Web/Ctl.cs', 'src/Models/Order.cs']]);
  w('src/Web/Ctl.cs', 'using Shop.Models;\nnamespace Shop.Web { public class Ctl { Order o; int n; } }\n');
  const edited = await buildCodeMap(dir, opts, same);
  expect([calls.extract, calls.namespaces]).toEqual([['using Shop.Models;\nn'], 0]);
  expect(edited.imports.map((i) => [i.from, i.to])).toEqual([['src/Web/Ctl.cs', 'src/Models/Order.cs']]);
});

test('after a restart, an unchanged C# file takes its namespaces from the stored map, with no parse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbcsrestart-'));
  dirs.push(dir);
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('src/Models/Order.cs', 'namespace Shop.Models;\npublic class Order {}\n');
  w('src/Web/Ctl.cs', 'using Shop.Models;\nnamespace Shop.Web { public class Ctl { Order o; } }\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const opts = { maxFiles: 5000, maxBytes: 200_000 };
  const full = await buildCodeMap(dir, opts);
  expect(full.files.map((f) => [f.path, f.namespaces])).toEqual([['src/Models/Order.cs', ['Shop.Models']], ['src/Web/Ctl.cs', ['Shop.Web']]]);
  // A new worker process: nothing of the last build is left in memory, only the map as the store gave it back.
  vi.resetModules();
  const fresh = (await import('./codemap.ts')).buildCodeMap;
  const stored = JSON.parse(JSON.stringify(full));
  calls.extract.length = 0;
  calls.namespaces = 0;
  const again = await fresh(dir, opts, stored);
  expect([calls.extract.length, calls.namespaces]).toEqual([0, 0]);
  expect(again.imports.map((i) => [i.from, i.to])).toEqual([['src/Web/Ctl.cs', 'src/Models/Order.cs']]);
});
