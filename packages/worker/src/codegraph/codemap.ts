import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSecretPath, redactSecrets } from '@fb/core';
import { listCodeFilesWithTotal } from '../scan/scan.ts';
import { extract } from './extract.ts';
import { isTestPath, langOf } from './lang.ts';
import { makeResolver } from './resolve.ts';
import type { BuildOpts, CodeFile, CodeImport, CodeMap, CodeSymbol, RawImport } from './types.ts';

const DEFAULT_CONCURRENCY = 16;

/** Files whose content the resolver reads: package manifests, tsconfigs, go.mod, Cargo.toml, Package.swift. */
const RESOLVER_INPUT = /(^|\/)(package\.json|go\.mod|Cargo\.toml|Package\.swift|[tj]sconfig[^/]*\.json)$/;
const CS_NAMESPACE = /^\s*namespace\s+[A-Za-z_][\w.]*/gm;
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

const groupBy = <T>(xs: T[] | undefined, key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs ?? []) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
};

type Parsed = { file: CodeFile; symbols: CodeSymbol[]; raw: RawImport[] };

/**
 * Files, symbols and import edges of a repository. With `prev`, a file whose hash is unchanged keeps its previous
 * symbols and is not reparsed; every import is re-resolved against the current file set either way.
 */
export async function buildCodeMap(repoPath: string, opts: BuildOpts, prev?: CodeMap): Promise<CodeMap> {
  const { files: listed, totalCandidates } = await listCodeFilesWithTotal(repoPath, { maxFiles: opts.maxFiles, maxBytes: opts.maxBytes, priority: opts.priority });
  const prevFiles = new Map(prev?.files.map((f) => [f.path, f]));
  const prevSymbols = groupBy(prev?.symbols, (s) => s.path);
  const prevImports = groupBy(prev?.imports, (i) => i.from);
  // A dangling import is not in the previous map, so an unchanged file that might name a new file is reparsed.
  const addedStems = prev ? [...new Set(listed.filter((f) => !prevFiles.has(f.path)).flatMap((f) => stemsOf(f.path)))] : [];

  const resolverInput = new Map<string, string>();
  const parsed = new Map<string, Parsed>();
  await pool(listed, opts.concurrency ?? DEFAULT_CONCURRENCY, async ({ path }) => {
    if (opts.signal?.aborted || isSecretPath(path)) return;
    const abs = join(repoPath, path);
    // Re-checked here: the file may have been swapped for a symlink since it was listed.
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile() || st.size > opts.maxBytes) return;
    const buf = await readFile(abs).catch(() => null);
    if (!buf) return;
    const content = buf.toString('utf8');
    const lang = langOf(path);
    const file: CodeFile = { path, lang, hash: createHash('sha256').update(buf).digest('hex'), loc: countLines(content), isTest: isTestPath(path) };
    if (RESOLVER_INPUT.test(path)) resolverInput.set(path, content);
    else if (lang === 'csharp') resolverInput.set(path, (content.match(CS_NAMESPACE) ?? []).join('\n'));
    else if (lang === 'gdscript') resolverInput.set(path, (content.match(GD_CLASS_NAME) ?? []).join('\n'));

    const old = prevFiles.get(path);
    // GDScript refers to classes by class_name, which no stem check can see coming; its line reader is cheap.
    const reused = old?.hash === file.hash && lang !== 'gdscript' ? rawFromPrev(prevImports.get(path) ?? []) : null;
    if (reused && !addedStems.some((s) => content.includes(s))) {
      parsed.set(path, { file, symbols: prevSymbols.get(path) ?? [], raw: reused });
      return;
    }
    const ex = await extract(lang, content).catch(() => null);
    const symbols = (ex?.symbols ?? []).map((s) => {
      const name = redactSecrets(s.name);
      return { id: `${path}#${name}`, path, ...s, name };
    });
    parsed.set(path, { file, symbols, raw: ex?.imports ?? [] });
  });

  opts.signal?.throwIfAborted();
  // Listed best first (for the cap); the map itself is in path order.
  const entries = listed.map((f) => parsed.get(f.path)).filter((p): p is Parsed => !!p).sort((a, b) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
  const resolve = makeResolver(entries.map((e) => e.file.path), (p) => resolverInput.get(p));
  const imports: CodeImport[] = [];
  let unresolved = 0;
  for (const { file, raw } of entries) {
    const byTarget = new Map<string, CodeImport>();
    for (const r of raw) {
      const found = resolve(file.path, file.lang, r);
      if (found.some((x) => x.unresolved)) unresolved++;
      for (const { to, names } of found) {
        const target = to.startsWith('pkg:') ? redactSecrets(to) : to;
        const e = byTarget.get(target);
        const clean = names.map(redactSecrets);
        if (!e) byTarget.set(target, { from: file.path, to: target, names: [...new Set(clean)], spec: redactSecrets(r.spec) });
        else for (const n of clean) if (!e.names.includes(n)) e.names.push(n);
      }
    }
    imports.push(...byTarget.values());
  }
  return { files: entries.map((e) => e.file), symbols: entries.flatMap((e) => e.symbols), imports, candidates: totalCandidates, unresolved };
}
