import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSecretPath, redactSecretsMemo } from '@fb/core';
import { rankCodePaths } from '../scan/rank.ts';
import { listIndexPaths } from '../scan/scan.ts';
import { csharpNamespaces, extract } from './extract.ts';
import { fileMaxBytes, isTestPath, langOf } from './lang.ts';
import { parseSymbols } from './onDemand.ts';
import { makeResolver } from './resolve.ts';
import type { BuildOpts, CodeFile, CodeImport, CodeMap, CodeSymbol, RawImport } from './types.ts';

const DEFAULT_CONCURRENCY = 16;

/** Files whose content the resolver reads: package manifests, tsconfigs, go.mod, Cargo.toml, Package.swift. */
const RESOLVER_INPUT = /(^|\/)(package\.json|go\.mod|Cargo\.toml|Package\.swift|[tj]sconfig[^/]*\.json)$/;
const GD_CLASS_NAME = /^class_name\s+[A-Za-z_]\w*/gm;

const countLines = (s: string) => (s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0);

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** The names an import of `path` would have to mention: its stem, or its directory for index/__init__/mod files. */
function stemsOf(path: string): string[] {
  const segs = path.split('/');
  const name = segs.pop()!;
  const stem = name.replace(/(\.d)?\.[^.]+$/, '');
  return /^(index|__init__|mod|lib|main)$/.test(stem) && segs.length ? [stem, segs.at(-1)!] : [stem];
}

/** The raw imports an earlier map recorded for one file; null if it predates `spec` and so cannot be re-resolved. */
function rawFromPrev(imports: CodeImport[]): RawImport[] | null {
  const bySpec = new Map<string, string[]>();
  for (const i of imports) {
    if (typeof i.spec !== 'string') return null;
    const names = bySpec.get(i.spec) ?? [];
    for (const n of i.names) if (!names.includes(n)) names.push(n);
    bySpec.set(i.spec, names);
  }
  return [...bySpec].map(([spec, names]) => ({ spec, names }));
}

const PY_RELATIVE = /^[ \t]*from[ \t]+(\.[\w.]*)[ \t]+import\b/gm;

/**
 * Whether a Python file has a relative import the previous map kept no edge for: one naming no module makes none, so
 * only a reparse can count it unresolved. A match inside a string only costs a reparse.
 */
const edgelessRelative = (content: string, raw: RawImport[]) => [...content.matchAll(PY_RELATIVE)].some(([, spec]) => !raw.some((r) => r.spec === spec));

const groupBy = <T>(xs: T[] | undefined, key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs ?? []) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
};

/** Symbols null: not known yet (an unchanged file reused from the previous map's import index, which keeps none). */
type Parsed = { file: CodeFile; symbols: CodeSymbol[] | null; raw: RawImport[] };

/**
 * Files parsed for the import index at most, mapped or not: past it a file is neither mapped nor indexed (it is still
 * counted in `candidates`). A 10,000-file monorepo is parsed in seconds; this bounds a pathological tree.
 */
export const MAX_INDEX_FILES = 50_000;

/** Paths are unique, so no two compare equal. */
const cmpPath = (a: string, b: string) => (a < b ? -1 : 1);

async function readSymbols(repoPath: string, file: CodeFile): Promise<CodeSymbol[]> {
  // Deleted since the index read it: no symbols.
  return parseSymbols(file.path, await readFile(join(repoPath, file.path), 'utf8').catch(() => ''));
}

/**
 * Files, symbols and import edges of a repository. Every candidate (up to MAX_INDEX_FILES) is parsed and its imports
 * resolved against all of them: the import index. The map keeps symbols for the first `cap` files ranked by tier
 * (scan/rank.ts), then by import in-degree and churn within a tier, so a capped map holds the files most used and
 * most changed, not the alphabetically first; the rest are `outside`, with their edges but no symbols. With `prev`, a
 * file whose hash is unchanged keeps its previous symbols and raw imports and is not reparsed; every import is
 * re-resolved against the current file set either way.
 */
export async function buildCodeMap(repoPath: string, opts: BuildOpts, prev?: CodeMap): Promise<CodeMap> {
  const { paths: listed, totalCandidates, cap } = await listIndexPaths(repoPath, { maxFiles: opts.maxFiles, maxBytes: opts.maxBytes, sourceMaxBytes: opts.sourceMaxBytes, priority: opts.priority, limit: MAX_INDEX_FILES });
  const prevFiles = new Map([...(prev?.files ?? []), ...(prev?.outside ?? [])].map((f) => [f.path, f]));
  const prevMapped = new Set(prev?.files.map((f) => f.path));
  const prevSymbols = groupBy(prev?.symbols, (s) => s.path);
  const prevImports = groupBy(prev?.imports, (i) => i.from);
  // A dangling import is not in the previous map, so an unchanged file that might name a new file is reparsed.
  const addedStems = prev ? [...new Set(listed.filter((p) => !prevFiles.has(p)).flatMap((p) => stemsOf(p)))] : [];

  const redactSecrets = redactSecretsMemo();
  const resolverInput = new Map<string, string>();
  const parsed = new Map<string, Parsed>();
  await pool(listed, opts.concurrency ?? DEFAULT_CONCURRENCY, async (path) => {
    if (opts.signal?.aborted || isSecretPath(path)) return;
    const abs = join(repoPath, path);
    // Re-checked here: the file may have been swapped for a symlink since it was listed.
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile() || st.size > fileMaxBytes(path, opts)) return;
    const buf = await readFile(abs).catch(() => null);
    if (!buf) return;
    const content = buf.toString('utf8');
    const lang = langOf(path);
    const file: CodeFile = { path, lang, hash: createHash('sha256').update(buf).digest('hex'), loc: countLines(content), isTest: isTestPath(path) };
    if (RESOLVER_INPUT.test(path)) resolverInput.set(path, content);
    else if (lang === 'gdscript') resolverInput.set(path, (content.replace(/^\uFEFF/, '').match(GD_CLASS_NAME) ?? []).join('\n'));
    const namespaces = (names: string[]) => {
      file.namespaces = names;
      resolverInput.set(path, names.map((n) => `namespace ${n}`).join('\n'));
    };

    const old = prevFiles.get(path);
    // GDScript refers to classes by class_name, which no stem check can see coming; its line reader is cheap.
    const reused = old?.hash === file.hash && lang !== 'gdscript' ? rawFromPrev(prevImports.get(path) ?? []) : null;
    if (reused && !addedStems.some((s) => content.includes(s)) && !(lang === 'python' && edgelessRelative(content, reused))) {
      // An unchanged C# file's namespaces come with the map; one built before they were stored is parsed for them.
      if (lang === 'csharp') namespaces(old!.namespaces ?? await csharpNamespaces(content).catch(() => []));
      parsed.set(path, { file, symbols: prevMapped.has(path) ? (prevSymbols.get(path) ?? []) : null, raw: reused });
      return;
    }
    const ex = await extract(lang, content).catch(() => null);
    if (lang === 'csharp') namespaces(ex?.namespaces ?? []);
    const symbols = (ex?.symbols ?? []).map((s) => {
      const name = redactSecrets(s.name);
      return { id: `${path}#${name}`, path, ...s, name };
    });
    parsed.set(path, { file, symbols, raw: ex?.imports ?? [] });
  });

  opts.signal?.throwIfAborted();
  const entries = [...parsed.values()].sort((a, b) => cmpPath(a.file.path, b.file.path));
  const resolve = makeResolver(entries.map((e) => e.file.path), (p) => resolverInput.get(p));
  const imports: CodeImport[] = [];
  const importers = new Map<string, Set<string>>();
  let unresolved = 0;
  for (const { file, raw } of entries) {
    const byTarget = new Map<string, CodeImport>();
    // Counted per edge, not per import: imports merged into one edge keep only its first spec, so an unchanged file
    // reused from the previous map (rawFromPrev) has no more to count. One that makes no edge is counted on its own.
    const unresolvedTo = new Set<string>();
    for (const r of raw) {
      for (const { to, names, unresolved: missed } of resolve(file.path, file.lang, r)) {
        if (to === null) {
          if (missed) unresolved++;
          continue;
        }
        const target = to.startsWith('pkg:') ? redactSecrets(to) : to;
        if (missed) unresolvedTo.add(target);
        const e = byTarget.get(target);
        const clean = names.map(redactSecrets);
        if (!e) byTarget.set(target, { from: file.path, to: target, names: [...new Set(clean)], spec: redactSecrets(r.spec) });
        else for (const n of clean) if (!e.names.includes(n)) e.names.push(n);
        if (!target.startsWith('pkg:')) {
          if (!importers.has(target)) importers.set(target, new Set());
          importers.get(target)!.add(file.path);
        }
      }
    }
    imports.push(...byTarget.values());
    unresolved += unresolvedTo.size;
  }

  // Which files the map keeps: tier first, then the most imported and most changed (log scale, as hotspots weigh them).
  const weight = (p: string) => Math.log2(1 + (importers.get(p)?.size ?? 0)) + Math.log2(1 + (opts.churn?.get(p)?.commits ?? 0));
  const kept = new Set(rankCodePaths(entries.map((e) => e.file.path), { priority: opts.priority, weight }).slice(0, cap));
  const mapped = entries.filter((e) => kept.has(e.file.path));
  // Reused from the index, so its symbols were never kept: read them now that it is mapped.
  await pool(mapped.filter((e) => e.symbols === null), opts.concurrency ?? DEFAULT_CONCURRENCY, async (e) => {
    if (!opts.signal?.aborted) e.symbols = await readSymbols(repoPath, e.file);
  });
  opts.signal?.throwIfAborted();
  return {
    files: mapped.map((e) => e.file),
    outside: entries.filter((e) => !kept.has(e.file.path)).map((e) => e.file),
    symbols: mapped.flatMap((e) => e.symbols!),
    imports,
    candidates: totalCandidates,
    unresolved,
  };
}
