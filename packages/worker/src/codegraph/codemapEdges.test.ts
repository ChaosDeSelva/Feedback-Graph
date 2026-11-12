import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { CodeMap } from './types.ts';

/** What happens to the tree between the listing and the read: run once, right after the real listing. */
let afterListing: (() => void) | null = null;
vi.mock('../scan/scan.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../scan/scan.ts')>();
  return {
    ...m,
    listIndexPaths: async (...args: Parameters<typeof m.listIndexPaths>) => {
      const out = await m.listIndexPaths(...args);
      afterListing?.();
      afterListing = null;
      return out;
    },
  };
});

const { buildCodeMap } = await import('./codemap.ts');

const OPTS = { maxFiles: 5000, maxBytes: 200 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'fbcodemap-edges-'));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

test('files that changed after the listing (grown past maxBytes, deleted, unreadable, swapped for a symlink) are left out', async () => {
  const dir = repo({
    'a.ts': 'export const a = 1;\n',
    'grown.ts': 'export const g = 1;\n',
    'gone.ts': 'export const x = 1;\n',
    'locked.ts': 'export const l = 1;\n',
    'swapped.ts': 'export const s = 1;\n',
  });
  afterListing = () => {
    writeFileSync(join(dir, 'grown.ts'), `export const g = '${'x'.repeat(500)}';\n`);
    unlinkSync(join(dir, 'gone.ts'));
    chmodSync(join(dir, 'locked.ts'), 0o000);
    unlinkSync(join(dir, 'swapped.ts'));
    symlinkSync(join(dir, 'a.ts'), join(dir, 'swapped.ts'));
  };
  const m = await buildCodeMap(dir, OPTS);
  chmodSync(join(dir, 'locked.ts'), 0o644);
  expect(m.files.map((f) => f.path)).toEqual(['a.ts']);
  expect(m.symbols.map((s) => s.id)).toEqual(['a.ts#a']);
  expect(m.candidates).toBe(5);
});

test('a C# file with no namespace and a Godot script with no class_name are mapped like any other', async () => {
  const dir = repo({
    'Program.cs': 'class Program { static void Main() {} }\n',
    'scene.gd': 'extends Node\nfunc _ready():\n\tpass\n',
  });
  const m = await buildCodeMap(dir, OPTS);
  expect(m.symbols.map((s) => s.id).sort()).toEqual(['Program.cs#Program', 'scene.gd#_ready']);
});

test('a Python relative import of a module that does not exist is counted unresolved and makes no edge', async () => {
  const dir = repo({
    'pkg/__init__.py': '',
    'pkg/a.py': 'from .missing import thing\nfrom .b import other\n',
    'pkg/b.py': 'def other():\n    return 1\n',
  });
  const m = await buildCodeMap(dir, OPTS);
  expect(m.unresolved).toBe(1);
  expect(m.imports.filter((i) => i.from === 'pkg/a.py').map((i) => i.to)).toEqual(['pkg/b.py']);
});

test('a main file added at the root or an index file added in a folder makes unchanged files that name it reparse', async () => {
  const dir = repo({ 'app.ts': "import { start } from './main';\nimport { u } from './util';\nexport const app = [start, u];\n" });
  const first = await buildCodeMap(dir, OPTS);
  expect(first.imports).toEqual([]);
  writeFileSync(join(dir, 'main.ts'), 'export const start = 1;\n');
  mkdirSync(join(dir, 'util'));
  writeFileSync(join(dir, 'util/index.ts'), 'export const u = 1;\n');
  const second = await buildCodeMap(dir, OPTS, first);
  expect(second.imports.map((i) => [i.from, i.to])).toEqual([['app.ts', 'main.ts'], ['app.ts', 'util/index.ts']]);
});

/** Churn the build consults while ranking, after every file is read: the hook runs then. */
class ChurnWithHook extends Map<string, { commits: number }> {
  private hook: () => void;
  constructor(hook: () => void) {
    super();
    this.hook = hook;
  }
  override get(key: string) {
    this.hook();
    this.hook = () => {};
    return super.get(key);
  }
}

test('a file outside the previous map that is now mapped gets its symbols read, or none if it was deleted meanwhile', async () => {
  const dir = repo({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 'notes.md': '# notes\n' });
  const capped: CodeMap = await buildCodeMap(dir, { ...OPTS, maxFiles: 1 });
  expect(capped.outside?.map((f) => f.path)).toEqual(['b.ts', 'notes.md']);

  const m = await buildCodeMap(dir, { ...OPTS, churn: new ChurnWithHook(() => unlinkSync(join(dir, 'b.ts'))) }, capped);
  expect(m.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'notes.md']);
  // a.ts keeps its previous symbols, b.ts was deleted before its symbols were read, notes.md has none to read.
  expect(m.symbols.map((s) => s.id)).toEqual(['a.ts#a']);
});

test('a shutdown while the map is being ranked stops it before the remaining symbols are read', async () => {
  const dir = repo({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
  const capped = await buildCodeMap(dir, { ...OPTS, maxFiles: 1 });
  const ac = new AbortController();
  const churn = new ChurnWithHook(() => ac.abort(new Error('the worker is shutting down')));
  await expect(buildCodeMap(dir, { ...OPTS, signal: ac.signal, churn }, capped)).rejects.toThrow('shutting down');
});
