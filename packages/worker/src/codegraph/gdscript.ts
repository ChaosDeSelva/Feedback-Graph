import type { Extracted, RawImport, SymbolKind } from './types.ts';

/**
 * GDScript (Godot) has no maintained prebuilt tree-sitter grammar, so .gd files are read line by line. Only top-level
 * declarations count: class_name, class, enum, func, signal, const and var (annotations, `static` and Godot 3's
 * export/onready/remote keywords stripped). A declaration spans its line and the indented lines under it. Exported:
 * a name not starting with `_` (GDScript has no visibility, `_` is its private convention).
 *
 * Imports are what the file refers to: preload()/load() and `extends "<path>"` paths as written (res://, relative or
 * uid://), and every capitalized identifier outside strings and comments, which resolve.ts matches against the
 * class_name declarations of the repo (a built-in like Node2D matches none and is dropped).
 */

/** Godot 3 keywords that may precede var/func at the top level. */
const PREFIX = /^(?:(?:@[A-Za-z_]\w*(?:\([^)]*\))?|static|export(?:\([^)]*\))?|onready|remote|remotesync|master|mastersync|puppet|puppetsync|sync|slave|tool)\s+)+/;
const DECL = /^(class_name|class|enum|func|signal|const|var)\s+([A-Za-z_]\w*)/;
const KIND: Record<string, SymbolKind> = { class_name: 'class', class: 'class', enum: 'type', func: 'function', signal: 'other', const: 'const', var: 'other' };
const LOAD = /\b(?:pre)?load\s*\(\s*(["'])([^"'\n]+)\1/g;
const EXTENDS_PATH = /^extends\s+(["'])([^"'\n]+)\1/;
/** Godot 4 allows `class_name Foo extends Bar` on one line. */
const INLINE_EXTENDS = /\bextends\s+(?:(["'])([^"'\n]+)\1|([A-Za-z_]\w*))/;
const IDENT = /\b[A-Z]\w*/g;

/** The line with strings and comments blanked; `inTriple` carries an open """ string across lines. */
function codeOf(line: string, inTriple: boolean): { code: string; inTriple: boolean } {
  let out = '';
  let i = 0;
  if (inTriple) {
    const end = line.indexOf('"""');
    if (end < 0) return { code: '', inTriple: true };
    i = end + 3;
  }
  while (i < line.length) {
    const c = line[i];
    if (c === '#') break;
    if (line.startsWith('"""', i)) {
      const end = line.indexOf('"""', i + 3);
      if (end < 0) return { code: out, inTriple: true };
      out += ' ';
      i = end + 3;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      out += ' ';
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return { code: out, inTriple: false };
}

export function extractGdscript(source: string): Extracted {
  const lines = source.split('\n');
  const symbols: Extracted['symbols'] = [];
  const open: { sym: Extracted['symbols'][number]; start: number; end: number }[] = [];
  const specs = new Map<string, Set<string>>();
  const ref = (spec: string, name: string) => {
    if (!specs.has(spec)) specs.set(spec, new Set());
    specs.get(spec)!.add(name);
  };
  const own = new Set<string>();
  let current: (typeof open)[number] | null = null;
  let inTriple = false;

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n].replace(/\r$/, '');
    const startsInTriple = inTriple;
    const { code, inTriple: next } = codeOf(raw, inTriple);
    inTriple = next;
    for (const [, , path] of raw.matchAll(LOAD)) ref(path, '*');
    for (const [id] of code.matchAll(IDENT)) ref(id, id);

    // A line inside a multi-line string belongs to the statement it started in, whatever its indent.
    if (startsInTriple) {
      if (current) current.end = n + 1;
      continue;
    }
    if (!code.trim()) continue;
    if (/^\s/.test(raw)) {
      if (current) current.end = n + 1;
      continue;
    }
    current = null;
    const stmt = raw.replace(PREFIX, '');
    const ext = stmt.match(EXTENDS_PATH);
    if (ext) ref(ext[2], '*');
    const d = stmt.match(DECL);
    if (!d) continue;
    const [, kw, name] = d;
    if (kw === 'class_name') {
      own.add(name);
      const inline = stmt.slice(d[0].length).match(INLINE_EXTENDS);
      if (inline?.[2]) ref(inline[2], '*');
    }
    if (kw === 'class' || kw === 'enum') own.add(name);
    const sym = { name, kind: KIND[kw], exported: kw === 'class_name' || !name.startsWith('_'), lines: '' };
    symbols.push(sym);
    open.push((current = { sym, start: n + 1, end: n + 1 }));
  }
  for (const o of open) o.sym.lines = `${o.start}-${o.end}`;

  // A name declared twice (a var and its setter func, say) is one symbol, as the tree-sitter extractors do.
  const merged = new Map<string, Extracted['symbols'][number]>();
  for (const s of symbols) {
    const prev = merged.get(s.name);
    if (!prev) { merged.set(s.name, s); continue; }
    const [a, b] = prev.lines.split('-').map(Number);
    const [c, d] = s.lines.split('-').map(Number);
    prev.lines = `${Math.min(a, c)}-${Math.max(b, d)}`;
    prev.exported ||= s.exported;
  }
  const imports: RawImport[] = [];
  for (const [spec, names] of specs) {
    if (own.has(spec)) continue;
    imports.push({ spec, names: [...names] });
  }
  return { symbols: [...merged.values()], imports };
}
