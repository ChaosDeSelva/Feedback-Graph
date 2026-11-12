import type { CodeMap } from './types.ts';

// Agents call these per question against the same map; building the index once per map keeps that linear.
const indexes = new WeakMap<CodeMap['imports'], Map<string, string[]>>();
const testFiles = new WeakMap<CodeMap, { all: Set<string>; byDir: Map<string, string[]> }>();

function importersOf(map: CodeMap): Map<string, string[]> {
  let idx = indexes.get(map.imports);
  if (!idx) {
    idx = new Map();
    for (const i of map.imports) {
      const list = idx.get(i.to);
      if (!list) idx.set(i.to, [i.from]);
      else if (!list.includes(i.from)) list.push(i.from);
    }
    indexes.set(map.imports, idx);
  }
  return idx;
}

/** Files that import `path`, directly (depth 1) or transitively up to `depth` hops, nearest first. */
export function dependents(map: CodeMap, path: string, depth: number): { path: string; depth: number }[] {
  const idx = importersOf(map);
  const seen = new Set([path]);
  const out: { path: string; depth: number }[] = [];
  let frontier = [path];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const from of idx.get(p) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        next.push(from);
      }
    }
    next.sort();
    out.push(...next.map((p) => ({ path: p, depth: d })));
    frontier = next;
  }
  return out;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
/** "foo" for foo.ts, foo.test.ts, foo.spec.tsx, foo_test.go, test_foo.py. */
const stemOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '').replace(/([._](test|spec))$/, '').replace(/^test_/, '');

/** Test files (mapped or past the cap), and by folder. */
function testsOf(map: CodeMap): { all: Set<string>; byDir: Map<string, string[]> } {
  let t = testFiles.get(map);
  if (!t) {
    t = { all: new Set(), byDir: new Map() };
    for (const f of [...map.files, ...(map.outside ?? [])].filter((f) => f.isTest)) {
      t.all.add(f.path);
      const list = t.byDir.get(dirOf(f.path));
      if (list) list.push(f.path);
      else t.byDir.set(dirOf(f.path), [f.path]);
    }
    testFiles.set(map, t);
  }
  return t;
}

/**
 * Test files beside `path` that test it without importing it: a Go file's same-package `_test.go` files (a package
 * tests its own files without an import), and the test named for the file (foo.test.ts, test_foo.py) of any language,
 * which may reach it through a mock or a fixture rather than an import.
 */
function besideTests(map: CodeMap, path: string): string[] {
  const here = testsOf(map).byDir.get(dirOf(path)) ?? [];
  const go = path.endsWith('.go');
  return here.filter((t) => t !== path && ((go && t.endsWith('_test.go')) || stemOf(t) === stemOf(path)));
}

/**
 * Test files (mapped or in the import index past the cap) that cover `path`: the ones beside it (besideTests), and those
 * importing it directly or through one intermediate file. The tests beside its importers are theirs: an answer reaches
 * them through the importers (core codeGraphViews), so they are not linked here too (in a Go monorepo that would link
 * every file of a hub package to every test of every package importing it).
 */
export function testsFor(map: CodeMap, path: string): string[] {
  const { all } = testsOf(map);
  return [...new Set([...besideTests(map, path), ...dependents(map, path, 2).map((d) => d.path).filter((p) => all.has(p))])].sort();
}
