import type { CodeMap } from './types.ts';

// Agents call these per question against the same map; building the index once per map keeps that linear.
const indexes = new WeakMap<CodeMap['imports'], Map<string, string[]>>();
const testFiles = new WeakMap<CodeMap['files'], Set<string>>();

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

/** Test files (mapped or in the import index past the cap) that import `path` directly or through one intermediate file. */
export function testsFor(map: CodeMap, path: string): string[] {
  let tests = testFiles.get(map.files);
  if (!tests) testFiles.set(map.files, (tests = new Set([...map.files, ...(map.outside ?? [])].filter((f) => f.isTest).map((f) => f.path))));
  return dependents(map, path, 2).map((d) => d.path).filter((p) => tests.has(p)).sort();
}
