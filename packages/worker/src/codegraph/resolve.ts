import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import type { RawImport } from './types.ts';

/**
 * unresolved: the import looks like it names a file of this repo (a tsconfig paths alias, a #-import, a workspace
 * package, a bare name no package.json declares, a module of a Python package of the repo, a Python relative import)
 * but no file was found, so the import graph misses an edge. to null: no edge at all (it is only counted).
 */
export type Resolved = { to: string | null; names: string[]; unresolved?: true };
export type Resolve = (from: string, lang: string, raw: RawImport) => Resolved[];

/** Repo-relative join; '' is the repo root; null when the path leaves the repo. */
function join(...parts: string[]): string | null {
  const p = posix.normalize(parts.filter(Boolean).join('/') || '.');
  if (p === '..' || p.startsWith('../') || p.startsWith('/')) return null;
  return p === '.' ? '' : p.replace(/\/$/, '');
}
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** tsconfig is JSONC: comments and trailing commas are allowed. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function tryParse(text: string | undefined, jsonc = false): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const v = jsonc ? parseJsonc(text) : JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const JS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const EXPORT_CONDITIONS = ['source', 'import', 'module', 'default', 'node', 'require', 'types'];

function exportTargets(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(exportTargets);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = [...EXPORT_CONDITIONS.filter((k) => k in o), ...Object.keys(o).filter((k) => !EXPORT_CONDITIONS.includes(k))];
    return keys.flatMap((k) => exportTargets(o[k]));
  }
  return [];
}

/** Matches a spec against tsconfig paths / package exports keys: exact, or one '*' wildcard (longest prefix wins). */
function matchPattern(patterns: string[], spec: string): { pattern: string; star: string } | null {
  if (patterns.includes(spec)) return { pattern: spec, star: '' };
  let best: { pattern: string; star: string } | null = null;
  for (const p of patterns) {
    const i = p.indexOf('*');
    if (i < 0) continue;
    const pre = p.slice(0, i);
    const post = p.slice(i + 1);
    if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post) && (!best || pre.length > best.pattern.indexOf('*'))) {
      best = { pattern: p, star: spec.slice(pre.length, spec.length - post.length) };
    }
  }
  return best;
}

/** configDir: the folder of the config itself (the leaf of an extends chain), what `${configDir}` in paths stands for. */
type TsConfig = { baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string; configDir: string };
const CONFIG_FILE = /^[tj]sconfig[^/]*\.json$/;
const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]));
/** Python standard library modules a repo folder may share a name with (tools/logging/): never "unresolved". */
const PY_STDLIB = new Set((
  'abc argparse ast asyncio base64 bisect builtins calendar collections concurrent contextlib copy csv ctypes dataclasses ' +
  'datetime decimal difflib email enum errno functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io ' +
  'ipaddress itertools json logging math mimetypes multiprocessing operator os pathlib pickle platform pprint queue random re ' +
  'secrets select shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys tempfile textwrap ' +
  'threading time timeit tomllib traceback types typing unittest urllib uuid warnings weakref xml zipfile zlib zoneinfo'
).split(' '));
/** Marks a JS import that looks like it names a repo file but resolved to none (Resolved.unresolved). */
const UNRESOLVED = Symbol('unresolved');

export function makeResolver(paths: string[], read: (path: string) => string | undefined): Resolve {
  const files = new Set(paths);
  const dirs = new Set<string>(['']);
  const dirFiles = new Map<string, string[]>();
  for (const p of paths) {
    const d = dirOf(p);
    if (!dirFiles.has(d)) dirFiles.set(d, []);
    dirFiles.get(d)!.push(p);
    for (let x = d; x && !dirs.has(x); x = dirOf(x)) dirs.add(x);
  }
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const named = (name: string) => paths.filter((p) => base(p) === name);
  const lazy = <T>(f: () => T) => {
    let v: T | undefined;
    let done = false;
    return () => {
      if (!done) { v = f(); done = true; }
      return v as T;
    };
  };

  // ---------- TypeScript / JavaScript ----------

  const resolveFile = (b: string | null): string | null => {
    if (b === null) return null;
    if (files.has(b)) return b;
    const ext = posix.extname(b);
    for (const alt of JS_TO_TS[ext] ?? []) if (files.has(b.slice(0, -ext.length) + alt)) return b.slice(0, -ext.length) + alt;
    for (const e of JS_EXTS) if (files.has(b + e)) return b + e;
    for (const e of JS_EXTS) if (files.has(`${b}/index${e}`)) return `${b}/index${e}`;
    return null;
  };

  /** The config an `extends` names: a relative path, or a workspace package (`@acme/tsconfig/base.json`). */
  const extendsTarget = (dir: string, e: string): string | undefined => {
    let p: string | null;
    if (e.startsWith('.') || e.startsWith('/')) p = e.startsWith('/') ? join(e.slice(1)) : join(dir, e);
    else {
      const segs = e.split('/');
      const n = e.startsWith('@') ? 2 : 1;
      const ws = workspaces().get(segs.slice(0, n).join('/'));
      p = ws ? join(ws.dir, segs.slice(n).join('/')) : null;
    }
    return p === null ? undefined : [p, `${p}.json`, p ? `${p}/tsconfig.json` : 'tsconfig.json'].find((c) => files.has(c));
  };
  const tsconfigs = new Map<string, TsConfig | null>();
  const loadTsconfig = (path: string, depth = 0): TsConfig | null => {
    if (tsconfigs.has(path)) return tsconfigs.get(path)!;
    tsconfigs.set(path, null); // guards an extends cycle
    const json = tryParse(read(path), true);
    if (!json) return null;
    const dir = dirOf(path);
    let cfg: TsConfig = { configDir: dir };
    const ext = json.extends;
    for (const e of (Array.isArray(ext) ? ext : [ext]).filter((x): x is string => typeof x === 'string')) {
      const found = extendsTarget(dir, e);
      const parent = found && depth < 10 ? loadTsconfig(found, depth + 1) : null;
      if (parent) cfg = { ...cfg, ...parent, configDir: dir };
    }
    const co = (json.compilerOptions ?? {}) as Record<string, unknown>;
    if (typeof co.baseUrl === 'string') cfg.baseUrl = join(dir, co.baseUrl) ?? undefined;
    if (co.paths && typeof co.paths === 'object') {
      cfg.paths = co.paths as Record<string, string[]>;
      cfg.pathsDir = dir;
    }
    tsconfigs.set(path, cfg);
    return cfg;
  };
  const nearestTsconfig = new Map<string, TsConfig | null>();
  const tsconfigFor = (dir: string): TsConfig | null => {
    if (nearestTsconfig.has(dir)) return nearestTsconfig.get(dir)!;
    const here = ['tsconfig.json', 'jsconfig.json'].map((n) => (dir ? `${dir}/${n}` : n)).find((p) => files.has(p));
    const cfg = here ? loadTsconfig(here) : dir ? tsconfigFor(dirOf(dir)) : null;
    nearestTsconfig.set(dir, cfg);
    return cfg;
  };
  /**
   * Every config whose paths may apply to a file in `dir`, nearest first: the nearest tsconfig.json (with what it
   * extends), then the other tsconfig*.json beside it (a solution-style tsconfig.json keeps its aliases in
   * tsconfig.app.json), then the same for each folder above. TypeScript would use one; the map tries them in turn.
   */
  const configChain = new Map<string, TsConfig[]>();
  const pathsConfigsFor = (dir: string): TsConfig[] => {
    if (configChain.has(dir)) return configChain.get(dir)!;
    const here = (dirFiles.get(dir) ?? []).filter((p) => CONFIG_FILE.test(base(p))).sort((a, b) => Number(!/\/?tsconfig\.json$/.test(a)) - Number(!/\/?tsconfig\.json$/.test(b)) || (a < b ? -1 : 1));
    const own = here.map((p) => loadTsconfig(p)).filter((c): c is TsConfig => !!c?.paths);
    const chain = [...own, ...(dir ? pathsConfigsFor(dirOf(dir)) : [])];
    configChain.set(dir, chain);
    return chain;
  };
  /** A spec through one config's paths: the file, null when a pattern matched but named no file, undefined when none matched. */
  const viaPaths = (cfg: TsConfig, spec: string): string | null | undefined => {
    const m = matchPattern(Object.keys(cfg.paths!), spec);
    if (!m) return undefined;
    const baseDir = cfg.baseUrl ?? cfg.pathsDir ?? '';
    for (const t of cfg.paths![m.pattern] ?? []) {
      if (typeof t !== 'string') continue;
      const target = t.replace('*', m.star);
      const f = target.includes('${configDir}') ? resolveFile(join(target.replace('${configDir}', cfg.configDir))) : resolveFile(join(baseDir, target));
      if (f) return f;
    }
    return null;
  };
  /** A #-import through the `imports` of the nearest package.json above the file. */
  const packageImport = (from: string, spec: string): string | null | undefined => {
    for (let d: string | null = dirOf(from); d !== null; d = d ? dirOf(d) : null) {
      const p = d ? `${d}/package.json` : 'package.json';
      if (!files.has(p)) continue;
      const imp = tryParse(read(p))?.imports;
      if (!imp || typeof imp !== 'object') return undefined;
      const o = imp as Record<string, unknown>;
      const m = matchPattern(Object.keys(o), spec);
      if (!m) return null;
      for (const t of exportTargets(o[m.pattern]).map((x) => x.replace('*', m.star))) {
        const f = fromPackage(d, t);
        if (f) return f;
      }
      return null;
    }
    return undefined;
  };
  /** Every name a package.json in the repo declares as a dependency, with the workspace names. */
  const declared = lazy(() => {
    const s = new Set<string>(workspaces().keys());
    let any = false;
    for (const p of named('package.json')) {
      const pkg = tryParse(read(p));
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = pkg?.[k];
        if (!deps || typeof deps !== 'object') continue;
        for (const name of Object.keys(deps)) {
          s.add(name);
          any = true;
          // @types/foo is imported as foo; @types/scope__pkg as @scope/pkg
          if (name.startsWith('@types/')) s.add(name.slice(7).includes('__') ? `@${name.slice(7).replace('__', '/')}` : name.slice(7));
        }
      }
    }
    return any ? s : null;
  });

  const workspaces = lazy(() => {
    const m = new Map<string, { dir: string; pkg: Record<string, unknown> }>();
    for (const p of named('package.json')) {
      const pkg = tryParse(read(p));
      if (pkg && typeof pkg.name === 'string' && !m.has(pkg.name)) m.set(pkg.name, { dir: dirOf(p), pkg });
    }
    return m;
  });

  // Built entries (dist/index.js) are usually not in the repo; their source is.
  const fromPackage = (dir: string, target: string) => {
    const b = join(dir, target);
    if (b === null) return null;
    const prefix = dir ? `${dir}/` : '';
    const src = (prefix + b.slice(prefix.length).replace(/^(dist|build|lib|out)\//, 'src/')).replace(/\.d\.ts$/, '');
    return resolveFile(b) ?? (src !== b ? resolveFile(src) : null);
  };

  const workspaceImport = (spec: string): string | null => {
    const segs = spec.split('/');
    const n = spec.startsWith('@') ? 2 : 1;
    const ws = workspaces().get(segs.slice(0, n).join('/'));
    if (!ws) return null;
    const sub = segs.slice(n).join('/');
    const { dir, pkg } = ws;
    const exp = pkg.exports;
    const key = sub ? `./${sub}` : '.';
    const candidates: string[] = [];
    if (typeof exp === 'string' || Array.isArray(exp)) {
      if (!sub) candidates.push(...exportTargets(exp));
    } else if (exp && typeof exp === 'object') {
      const o = exp as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.every((k) => !k.startsWith('.'))) {
        if (!sub) candidates.push(...exportTargets(o));
      } else {
        const m = matchPattern(keys, key);
        if (m) candidates.push(...exportTargets(o[m.pattern]).map((t) => t.replace('*', m.star)));
      }
    }
    if (sub) candidates.push(sub, `src/${sub}`);
    else candidates.push(...['module', 'main', 'types'].map((k) => pkg[k]).filter((x): x is string => typeof x === 'string'), 'src/index', 'index');
    for (const c of candidates) {
      const f = fromPackage(dir, c);
      if (f) return f;
    }
    return null;
  };

  const jsRoot = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
  /** A file; null when nothing (a relative path to no file); undefined for a package; UNRESOLVED (see Resolved). */
  const resolveJs = (from: string, spec: string): string | null | undefined | typeof UNRESOLVED => {
    if (spec.startsWith('.')) return resolveFile(join(dirOf(from), spec));
    if (spec.startsWith('/')) return resolveFile(join(spec.slice(1)));
    let aliased = false;
    for (const cfg of pathsConfigsFor(dirOf(from))) {
      const f = viaPaths(cfg, spec);
      if (f) return f;
      if (f === null) aliased = true;
    }
    if (spec.startsWith('#')) return packageImport(from, spec) ?? UNRESOLVED;
    const cfg = tsconfigFor(dirOf(from));
    if (cfg?.baseUrl !== undefined) {
      const f = resolveFile(join(cfg.baseUrl, spec));
      if (f) return f;
    }
    const ws = workspaceImport(spec);
    if (ws) return ws;
    const root = jsRoot(spec);
    if (aliased || workspaces().has(root)) return UNRESOLVED;
    if (spec.includes(':') || NODE_BUILTINS.has(root)) return undefined;
    const deps = declared();
    return deps && !deps.has(root) ? UNRESOLVED : undefined;
  };

  // ---------- Python ----------

  const pyRoots = lazy(() => {
    const roots = [''];
    for (const p of [...named('pyproject.toml'), ...named('setup.py'), ...named('setup.cfg')]) roots.push(dirOf(p));
    for (const r of [...roots]) roots.push(r ? `${r}/src` : 'src');
    return [...new Set(roots)].filter((r) => dirs.has(r));
  });
  const pyModule = (p: string) => ({
    file: files.has(`${p}.py`) ? `${p}.py` : files.has(p ? `${p}/__init__.py` : '__init__.py') ? (p ? `${p}/__init__.py` : '__init__.py') : undefined,
    isDir: dirs.has(p),
  });
  const pyFrom = (modPath: string, mod: { file?: string }, names: string[]): Resolved[] => {
    const out = new Map<string, string[]>();
    const add = (to: string | undefined, n: string) => {
      if (!to) return;
      if (!out.has(to)) out.set(to, []);
      out.get(to)!.push(n);
    };
    for (const n of names) {
      const sub = n === '*' ? undefined : pyModule(modPath ? `${modPath}/${n}` : n).file;
      add(sub ?? mod.file, n);
    }
    if (!names.length) add(mod.file, '*');
    return [...out].map(([to, ns]) => ({ to, names: ns }));
  };
  /** Top-level names a Python import of this repo's own code may start with: folders holding .py files, and .py stems. */
  const pyLocal = lazy(() => {
    const s = new Set<string>();
    for (const p of paths) {
      if (!p.endsWith('.py')) continue;
      s.add(base(p).slice(0, -3));
      for (let d = dirOf(p); d; d = dirOf(d)) s.add(base(d));
    }
    return s;
  });
  const resolvePython = (from: string, spec: string, names: string[]): Resolved[] | null => {
    if (spec.startsWith('.')) {
      const dots = spec.match(/^\.+/)![0].length;
      let d: string | null = dirOf(from);
      for (let i = 1; i < dots; i++) d = d ? dirOf(d) : null;
      if (d === null) return [];
      const modPath = join(d, spec.slice(dots).replace(/\./g, '/'));
      if (modPath === null) return [];
      const mod = pyModule(modPath);
      // A relative import is always this repo's code: one that names nothing is counted.
      return mod.file || mod.isDir ? pyFrom(modPath, mod, names) : [{ to: null, names, unresolved: true }];
    }
    const segs = spec.split('.');
    const wholeModule = names.every((n) => n === '*');
    for (const root of [...pyRoots(), dirOf(from)]) {
      for (let k = segs.length; k >= (wholeModule ? 1 : segs.length); k--) {
        const modPath = join(root, segs.slice(0, k).join('/'))!;
        const mod = pyModule(modPath);
        if (mod.file || (!wholeModule && mod.isDir)) return pyFrom(modPath, mod, names);
      }
    }
    return null;
  };

  // ---------- Go ----------

  const goModules = lazy(() =>
    named('go.mod').flatMap((p) => {
      const m = read(p)?.match(/^module\s+(\S+)/m);
      return m ? [{ dir: dirOf(p), path: m[1].replace(/^"|"$/g, '') }] : [];
    }).sort((a, b) => b.path.length - a.path.length),
  );
  const resolveGo = (spec: string): string[] => {
    const mod = goModules().find((m) => spec === m.path || spec.startsWith(`${m.path}/`));
    if (!mod) return [];
    const dir = join(mod.dir, spec.slice(mod.path.length + 1));
    return dir === null ? [] : (dirFiles.get(dir) ?? []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).sort();
  };

  // ---------- Rust ----------

  const crates = lazy(() =>
    named('Cargo.toml').flatMap((p) => {
      const pkg = read(p)?.split(/^\s*\[/m).find((s) => s.startsWith('package]'));
      const name = pkg?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      return name ? [{ dir: dirOf(p), name: name.replace(/-/g, '_'), src: join(dirOf(p), 'src')! }] : [];
    }).sort((a, b) => b.dir.length - a.dir.length),
  );
  const crateSrcs = lazy(() => new Set(crates().map((c) => c.src)));
  const rustModFile = (dir: string): string | undefined =>
    [`${dir}.rs`, `${dir}/mod.rs`, ...(crateSrcs().has(dir) ? [`${dir}/lib.rs`, `${dir}/main.rs`] : [])].find((f) => files.has(f));
  const rustModDir = (file: string) => (/^(lib|main|mod)\.rs$/.test(base(file)) ? dirOf(file) : file.slice(0, -3));
  const resolveRust = (from: string, spec: string): string[] | null => {
    if (spec.startsWith('mod ')) {
      const f = rustModFile(join(rustModDir(from), spec.slice(4))!);
      return f ? [f] : [];
    }
    const segs = spec.replace(/^::/, '').split('::');
    let cur: string;
    let rest: string[];
    if (segs[0] === 'crate') {
      const crate = crates().find((c) => from.startsWith(`${c.dir ? `${c.dir}/` : ''}`));
      if (!crate) return [];
      [cur, rest] = [crate.src, segs.slice(1)];
    } else if (segs[0] === 'self' || segs[0] === 'super') {
      cur = rustModDir(from);
      rest = segs.slice(1);
      if (segs[0] === 'super') cur = dirOf(cur);
      while (rest[0] === 'super') [cur, rest] = [dirOf(cur), rest.slice(1)];
    } else if (rustModFile(join(rustModDir(from), segs[0])!)) {
      [cur, rest] = [rustModDir(from), segs];
    } else {
      const crate = crates().find((c) => c.name === segs[0]);
      if (!crate) return null;
      [cur, rest] = [crate.src, segs.slice(1)];
    }
    for (const seg of rest) {
      const next = join(cur, seg);
      if (next === null || !rustModFile(next)) break;
      cur = next;
    }
    const f = rustModFile(cur);
    return f ? [f] : [];
  };

  // ---------- C# ----------

  const namespaces = lazy(() => {
    const m = new Map<string, string[]>();
    for (const p of paths.filter((x) => x.endsWith('.cs'))) {
      for (const [, ns] of (read(p) ?? '').matchAll(/^\s*namespace\s+([A-Za-z_][\w.]*)/gm)) {
        if (!m.has(ns)) m.set(ns, []);
        if (!m.get(ns)!.includes(p)) m.get(ns)!.push(p);
      }
    }
    return m;
  });

  // ---------- Swift ----------

  // A module is a Package.swift target (its `path:`, else Sources/<name>, or Tests/<name> for a test target), or by
  // convention any Sources/<Module>/ folder. Its files are the .swift files under that folder.
  const swiftModules = lazy(() => {
    const m = new Map<string, string[]>();
    const add = (name: string, dir: string | null) => {
      if (dir === null) return;
      if (!m.has(name)) m.set(name, []);
      if (!m.get(name)!.includes(dir)) m.get(name)!.push(dir);
    };
    for (const p of named('Package.swift')) {
      const text = (read(p) ?? '').replace(/\/\/[^\n]*/g, '');
      // split with a capture group: [before, kind, body, kind, body, ...]; each body runs to the next target.
      const parts = text.split(/\.(target|executableTarget|testTarget|macro)\s*\(/);
      for (let i = 1; i + 1 < parts.length; i += 2) {
        const body = parts[i + 1];
        const name = body.match(/^\s*name:\s*"([^"]+)"/)?.[1];
        if (!name) continue;
        const path = body.match(/\bpath:\s*"([^"]+)"/)?.[1];
        add(name, join(dirOf(p), path ?? `${parts[i] === 'testTarget' ? 'Tests' : 'Sources'}/${name}`));
      }
    }
    for (const d of dirs) {
      const name = d.match(/(?:^|\/)Sources\/([^/]+)$/)?.[1];
      if (name && !m.has(name)) add(name, d);
    }
    return m;
  });
  const swiftFiles = lazy(() => paths.filter((p) => p.endsWith('.swift')));
  /** The module's files; null when no module of that name is in the repo. */
  const resolveSwift = (spec: string): string[] | null => {
    const roots = swiftModules().get(spec.split('.')[0]);
    if (!roots) return null;
    return swiftFiles().filter((f) => roots.some((d) => !d || f.startsWith(`${d}/`))).sort();
  };

  // ---------- GDScript ----------

  // res:// is the folder holding the nearest project.godot above the file (the repo root without one).
  const godotRoots = lazy(() => named('project.godot').map(dirOf).sort((a, b) => b.length - a.length));
  const godotRootOf = (path: string) => godotRoots().find((r) => !r || path.startsWith(`${r}/`)) ?? '';
  const classNames = lazy(() => {
    const m = new Map<string, string[]>();
    for (const p of paths.filter((x) => x.endsWith('.gd'))) {
      for (const [, name] of (read(p) ?? '').matchAll(/^class_name\s+([A-Za-z_]\w*)/gm)) {
        if (!m.has(name)) m.set(name, []);
        m.get(name)!.push(p);
      }
    }
    return m;
  });
  const resolveGdscript = (from: string, spec: string): string[] => {
    if (/^[A-Za-z_]\w*$/.test(spec)) {
      const declared = classNames().get(spec) ?? [];
      // Two Godot projects in one repo may both declare it: the one in this file's project wins.
      const same = declared.filter((p) => godotRootOf(p) === godotRootOf(from));
      return (same.length ? same : declared).sort();
    }
    const p = spec.startsWith('res://')
      ? join(godotRootOf(from), spec.slice('res://'.length))
      : /^[a-z]+:\/\//.test(spec) ? null // uid://, user://: nothing in the repo by path
        : join(dirOf(from), spec);
    return p !== null && files.has(p) ? [p] : [];
  };

  return (from, lang, raw) => {
    const { spec, names } = raw;
    const one = (to: string | null | undefined, external: string): Resolved[] =>
      to === null ? [] : to === undefined ? [{ to: `pkg:${external}`, names }] : to === from ? [] : [{ to, names }];
    const many = (tos: string[] | null, external: string): Resolved[] =>
      tos === null ? [{ to: `pkg:${external}`, names }] : tos.filter((t) => t !== from).map((to) => ({ to, names }));
    switch (lang) {
      case 'typescript': case 'tsx': case 'javascript': {
        const to = resolveJs(from, spec);
        return to === UNRESOLVED ? [{ to: `pkg:${jsRoot(spec)}`, names, unresolved: true }] : one(to, jsRoot(spec));
      }
      case 'python': {
        const r = resolvePython(from, spec, names);
        const top = spec.split('.')[0];
        // Not found in the repo: a module of one of its own packages is unresolved; anything else is a package.
        if (r === null) return [{ to: `pkg:${top}`, names, ...(pyLocal().has(top) && !PY_STDLIB.has(top) ? { unresolved: true as const } : {}) }];
        return r.filter((x) => x.to !== from);
      }
      case 'go': {
        const r = resolveGo(spec);
        return many(r.length ? r : null, spec);
      }
      case 'rust': return many(resolveRust(from, spec), spec.replace(/^::/, '').split('::')[0]);
      case 'csharp': {
        const r = namespaces().get(spec);
        return many(r ? [...r].sort() : null, spec);
      }
      case 'swift': return many(resolveSwift(spec), spec);
      // A class_name or path that names nothing in the repo is an engine class or a missing file: no edge.
      case 'gdscript': return many(resolveGdscript(from, spec), spec);
      default: return [{ to: `pkg:${spec}`, names }];
    }
  };
}
