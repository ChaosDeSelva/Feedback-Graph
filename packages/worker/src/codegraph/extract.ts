import type { Node } from 'web-tree-sitter';
import { extractGdscript } from './gdscript.ts';
import { loadParser } from './lang.ts';
import type { Extracted, RawImport, SymbolKind } from './types.ts';

type Sym = Extracted['symbols'][number];

const span = (n: Node): [number, number] => [n.startPosition.row + 1, n.endPosition.row + 1];
const str = (n: Node) => n.text.slice(1, -1);
const field = (n: Node | null | undefined, name: string) => n?.childForFieldName(name) ?? null;

function collector() {
  const list: Sym[] = [];
  const byName = new Map<string, Sym>();
  const ranges = new Map<Sym, [number, number]>();
  return {
    list,
    has: (name: string) => byName.has(name),
    get: (name: string) => byName.get(name),
    add(name: string | undefined, kind: SymbolKind, exported: boolean, at: Node) {
      if (!name) return;
      const [a, b] = span(at);
      const prev = byName.get(name);
      if (prev) {
        // Overloads and redefinitions are one symbol spanning all of them.
        const r = ranges.get(prev)!;
        r[0] = Math.min(r[0], a);
        r[1] = Math.max(r[1], b);
        prev.lines = `${r[0]}-${r[1]}`;
        prev.exported ||= exported;
        return;
      }
      const s: Sym = { name, kind, exported, lines: `${a}-${b}` };
      list.push(s);
      byName.set(name, s);
      ranges.set(s, [a, b]);
    },
    mark(name: string) {
      const s = byName.get(name);
      if (s) s.exported = true;
      return !!s;
    },
  };
}
type Collector = ReturnType<typeof collector>;

// ---------- TypeScript / JavaScript ----------

const JS_FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const JS_CLASS_VALUES = new Set(['class', 'class_expression']);
const valueKind = (v: Node | null): SymbolKind => (v && JS_FUNCTION_VALUES.has(v.type) ? 'function' : v && JS_CLASS_VALUES.has(v.type) ? 'class' : 'const');

function jsImportNames(stmt: Node): string[] {
  const names: string[] = [];
  for (const c of stmt.namedChildren) {
    if (c.type === 'import_require_clause') return ['*'];
    if (c.type !== 'import_clause') continue;
    for (const part of c.namedChildren) {
      if (part.type === 'identifier') names.push('default');
      else if (part.type === 'namespace_import') names.push('*');
      else if (part.type === 'named_imports') {
        for (const spec of part.namedChildren) if (spec.type === 'import_specifier') names.push(field(spec, 'name')!.text);
      }
    }
  }
  return names;
}

function bindingNames(call: Node): string[] {
  let p = call.parent;
  if (p?.type === 'await_expression') p = p.parent;
  if (p?.type !== 'variable_declarator') return [];
  const name = field(p, 'name');
  if (name?.type === 'identifier') return ['*'];
  if (name?.type !== 'object_pattern') return [];
  return name.namedChildren.flatMap((c) =>
    c.type === 'shorthand_property_identifier_pattern' ? [c.text] : c.type === 'pair_pattern' ? [field(c, 'key')!.text] : [],
  );
}

function extractJs(root: Node): Extracted {
  const syms = collector();
  const imports: RawImport[] = [];
  const marks: string[] = [];
  const classes: { name: string; body: Node }[] = [];

  const declaration = (node: Node, outer: Node, exported: boolean) => {
    const name = field(node, 'name')?.text;
    switch (node.type) {
      case 'function_declaration': case 'generator_function_declaration': case 'function_signature':
        return syms.add(name, 'function', exported, outer);
      case 'class_declaration': case 'abstract_class_declaration':
        syms.add(name, 'class', exported, outer);
        if (name && field(node, 'body')) classes.push({ name, body: field(node, 'body')! });
        return;
      case 'interface_declaration': return syms.add(name, 'interface', exported, outer);
      case 'type_alias_declaration': case 'enum_declaration': return syms.add(name, 'type', exported, outer);
      case 'internal_module': return syms.add(name, 'other', exported, outer);
      case 'lexical_declaration': case 'variable_declaration': {
        const decls = node.namedChildren.filter((c) => c.type === 'variable_declarator');
        for (const d of decls) {
          const id = field(d, 'name');
          if (id?.type === 'identifier') syms.add(id.text, valueKind(field(d, 'value')), exported, decls.length === 1 ? outer : d);
        }
        return;
      }
      case 'ambient_declaration': {
        const inner = node.namedChildren[0];
        if (inner) declaration(inner, outer, exported);
        return;
      }
      case 'expression_statement': return commonJsExport(node);
    }
  };

  const commonJsExport = (stmt: Node) => {
    const assign = stmt.namedChildren[0];
    if (assign?.type !== 'assignment_expression') return;
    const left = field(assign, 'left');
    const right = field(assign, 'right');
    if (left?.type !== 'member_expression' || !right) return;
    if (left.text === 'module.exports') {
      if (right.type === 'identifier') marks.push(right.text);
      else if (right.type === 'object') {
        for (const p of right.namedChildren) {
          if (p.type === 'shorthand_property_identifier') marks.push(p.text);
          else if (p.type === 'pair') {
            const v = field(p, 'value');
            if (v?.type === 'identifier') marks.push(v.text);
            else syms.add(field(p, 'key')?.text, valueKind(v), true, p);
          }
        }
      } else syms.add('default', valueKind(right), true, stmt);
      return;
    }
    const obj = field(left, 'object')?.text;
    if (obj !== 'exports' && obj !== 'module.exports') return;
    if (right.type === 'identifier' && syms.has(right.text)) marks.push(right.text);
    else syms.add(field(left, 'property')?.text, valueKind(right), true, stmt);
  };

  for (const node of root.namedChildren) {
    if (node.type === 'import_statement') {
      const source = field(node, 'source') ?? field(node.namedChildren.find((c) => c.type === 'import_require_clause'), 'source');
      if (source) imports.push({ spec: str(source), names: jsImportNames(node) });
    } else if (node.type === 'export_statement') {
      const decl = field(node, 'declaration');
      const value = field(node, 'value');
      const source = field(node, 'source');
      const clause = node.namedChildren.find((c) => c.type === 'export_clause');
      if (decl) declaration(decl, node, true);
      else if (value?.type === 'identifier') marks.push(value.text);
      else if (value) syms.add('default', valueKind(value), true, node);
      if (source) {
        const names = clause ? clause.namedChildren.map((s) => field(s, 'name')!.text) : ['*'];
        imports.push({ spec: str(source), names });
      } else if (clause) {
        for (const s of clause.namedChildren) marks.push(field(s, 'name')!.text);
      }
    } else {
      declaration(node, node, false);
    }
  }

  for (const call of root.descendantsOfType('call_expression')) {
    const fn = field(call, 'function');
    if (!(fn?.type === 'import' || (fn?.type === 'identifier' && fn.text === 'require'))) continue;
    const args = field(call, 'arguments')?.namedChildren ?? [];
    if (args.length === 1 && args[0].type === 'string') imports.push({ spec: str(args[0]), names: bindingNames(call) });
  }

  for (const m of marks) syms.mark(m);
  for (const c of classes) {
    if (syms.get(c.name)?.exported) jsMethods(syms, c.name, c.body);
  }
  return { symbols: syms.list, imports };
}

function jsMethods(syms: Collector, cls: string, body: Node) {
  for (const m of body.namedChildren) {
    const name = field(m, 'name');
    if (!name || name.type === 'private_property_identifier' || name.text === 'constructor') continue;
    const isMethod = m.type === 'method_definition' || m.type === 'abstract_method_signature' || m.type === 'method_signature';
    const isFnField = m.type === 'public_field_definition' && JS_FUNCTION_VALUES.has(field(m, 'value')?.type ?? '');
    if (!isMethod && !isFnField) continue;
    const priv = m.namedChildren.some((c) => c.type === 'accessibility_modifier' && c.text === 'private');
    syms.add(`${cls}.${name.text}`, 'method', !priv, m);
  }
}

// ---------- Python ----------

function pyAll(root: Node): Set<string> | null {
  for (const st of root.namedChildren) {
    const a = st.type === 'expression_statement' ? st.namedChildren[0] : null;
    if (a?.type !== 'assignment' || field(a, 'left')?.text !== '__all__') continue;
    const right = field(a, 'right');
    if (right?.type !== 'list' && right?.type !== 'tuple') return null;
    return new Set(right.namedChildren.filter((s) => s.type === 'string').map((s) => s.namedChildren.find((c) => c.type === 'string_content')?.text ?? ''));
  }
  return null;
}

function extractPython(root: Node): Extracted {
  const syms = collector();
  const all = pyAll(root);
  const isExported = (name: string) => (all ? all.has(name) : !name.startsWith('_'));
  for (const outer of root.namedChildren) {
    const node = outer.type === 'decorated_definition' ? field(outer, 'definition') : outer;
    if (!node) continue;
    const name = field(node, 'name')?.text;
    if (node.type === 'function_definition' && name) syms.add(name, 'function', isExported(name), outer);
    else if (node.type === 'class_definition' && name) {
      const exported = isExported(name);
      syms.add(name, 'class', exported, outer);
      if (exported) {
        for (const m of field(node, 'body')?.namedChildren ?? []) {
          const fn = m.type === 'decorated_definition' ? field(m, 'definition') : m;
          const mName = fn?.type === 'function_definition' ? field(fn, 'name')?.text : undefined;
          if (mName) syms.add(`${name}.${mName}`, 'method', !mName.startsWith('_') || /^__.+__$/.test(mName), m);
        }
      }
    } else if (node.type === 'expression_statement') {
      const a = node.namedChildren[0];
      const left = a?.type === 'assignment' ? field(a, 'left') : null;
      if (left?.type === 'identifier' && left.text !== '__all__') syms.add(left.text, 'const', isExported(left.text), node);
    } else if (node.type === 'type_alias_statement') {
      const n = field(node, 'left')?.text;
      if (n) syms.add(n, 'type', isExported(n), node);
    }
  }

  const imports: RawImport[] = [];
  for (const st of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    const targets = st.childrenForFieldName('name').filter((n) => n.isNamed).map((n) => (n.type === 'aliased_import' ? field(n, 'name')!.text : n.text));
    if (st.type === 'import_statement') {
      for (const t of targets) imports.push({ spec: t, names: ['*'] });
    } else {
      const mod = field(st, 'module_name');
      const wildcard = st.namedChildren.some((c) => c.type === 'wildcard_import');
      if (mod) imports.push({ spec: mod.text, names: wildcard ? ['*'] : targets });
    }
  }
  return { symbols: syms.list, imports };
}

// ---------- Go ----------

const goExported = (name: string) => /^[A-Z]/.test(name);

function goReceiver(method: Node): string | undefined {
  let t = field(field(method, 'receiver')?.namedChildren.find((c) => c.type === 'parameter_declaration'), 'type');
  while (t && t.type !== 'type_identifier') t = t.type === 'pointer_type' ? t.namedChildren[0] : field(t, 'type');
  return t?.text;
}

function extractGo(root: Node): Extracted {
  const syms = collector();
  const imports: RawImport[] = [];
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'function_declaration': {
        const name = field(node, 'name')?.text;
        if (name) syms.add(name, 'function', goExported(name), node);
        break;
      }
      case 'method_declaration': {
        const recv = goReceiver(node);
        const name = field(node, 'name')?.text;
        if (recv && name && goExported(recv)) syms.add(`${recv}.${name}`, 'method', goExported(name), node);
        break;
      }
      case 'type_declaration':
        for (const spec of node.namedChildren) {
          const name = field(spec, 'name')?.text;
          if (!name) continue;
          const t = field(spec, 'type')?.type;
          const kind: SymbolKind = spec.type === 'type_spec' && t === 'struct_type' ? 'class' : spec.type === 'type_spec' && t === 'interface_type' ? 'interface' : 'type';
          syms.add(name, kind, goExported(name), node.namedChildren.length === 1 ? node : spec);
        }
        break;
      case 'const_declaration': case 'var_declaration':
        for (const spec of node.namedChildren) {
          for (const n of spec.childrenForFieldName('name').filter((x) => x.isNamed)) syms.add(n.text, 'const', goExported(n.text), node);
        }
        break;
      case 'import_declaration':
        for (const spec of node.descendantsOfType('import_spec')) {
          const path = field(spec, 'path');
          if (path) imports.push({ spec: str(path), names: ['*'] });
        }
        break;
    }
  }
  return { symbols: syms.list, imports };
}

// ---------- Rust ----------

const rustPub = (n: Node) => n.namedChildren.some((c) => c.type === 'visibility_modifier');
const RUST_KIND: Record<string, SymbolKind> = {
  function_item: 'function', function_signature_item: 'function', struct_item: 'class', union_item: 'class', enum_item: 'type',
  trait_item: 'interface', type_item: 'type', const_item: 'const', static_item: 'const', mod_item: 'other', macro_definition: 'other',
};

function rustTypeName(t: Node | null): string | undefined {
  while (t && t.type !== 'type_identifier') t = t.type === 'generic_type' ? field(t, 'type') : t.type === 'scoped_type_identifier' ? field(t, 'name') : null;
  return t?.text;
}

function rustUse(node: Node | null, prefix: string, out: RawImport[]) {
  if (!node) return;
  const join = (p: string) => (prefix ? `${prefix}::${p}` : p).replace(/\s+/g, '');
  const leaf = (path: string) => {
    const full = join(path);
    const segs = full.split('::');
    if (segs.at(-1) === 'self') out.push({ spec: segs.slice(0, -1).join('::'), names: ['*'] });
    else out.push({ spec: full, names: [segs.at(-1)!] });
  };
  switch (node.type) {
    case 'scoped_use_list': {
      const path = field(node, 'path');
      const next = path ? join(path.text) : prefix;
      for (const c of field(node, 'list')?.namedChildren ?? []) rustUse(c, next, out);
      return;
    }
    case 'use_list':
      for (const c of node.namedChildren) rustUse(c, prefix, out);
      return;
    case 'use_as_clause': return leaf(field(node, 'path')!.text);
    case 'use_wildcard': {
      const path = node.text.replace(/::\s*\*$/, '').replace(/^\*$/, '');
      out.push({ spec: path ? join(path) : prefix, names: ['*'] });
      return;
    }
    default: return leaf(node.text);
  }
}

function extractRust(root: Node): Extracted {
  const syms = collector();
  const imports: RawImport[] = [];
  const impls: Node[] = [];
  for (const node of root.namedChildren) {
    if (node.type === 'use_declaration') rustUse(field(node, 'argument'), '', imports);
    else if (node.type === 'impl_item') impls.push(node);
    else if (RUST_KIND[node.type]) {
      const name = field(node, 'name')?.text;
      syms.add(name, RUST_KIND[node.type], rustPub(node), node);
      if (node.type === 'mod_item' && name && !field(node, 'body')) imports.push({ spec: `mod ${name}`, names: [] });
    }
  }
  for (const impl of impls) {
    const type = rustTypeName(field(impl, 'type'));
    // A type declared here privately has no public methods; one declared elsewhere may be public, so keep it.
    if (!type || (syms.has(type) && !syms.get(type)!.exported)) continue;
    const isTrait = !!field(impl, 'trait');
    for (const fn of field(impl, 'body')?.namedChildren ?? []) {
      if (fn.type === 'function_item') syms.add(`${type}.${field(fn, 'name')?.text}`, 'method', isTrait || rustPub(fn), fn);
    }
  }
  return { symbols: syms.list, imports };
}

// ---------- C# ----------

const CS_KIND: Record<string, SymbolKind> = {
  class_declaration: 'class', struct_declaration: 'class', record_declaration: 'class', record_struct_declaration: 'class',
  interface_declaration: 'interface', enum_declaration: 'type', delegate_declaration: 'type',
};
const csMods = (n: Node) => n.namedChildren.filter((c) => c.type === 'modifier').map((c) => c.text);

function extractCsharp(root: Node): Extracted {
  const syms = collector();
  const imports: RawImport[] = [];
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.type === 'using_directive') {
        const target = node.namedChildren.filter((c) => c.type === 'qualified_name' || c.type === 'identifier').at(-1);
        if (target) imports.push({ spec: target.text.replace(/\s+/g, ''), names: ['*'] });
      } else if (node.type === 'namespace_declaration') visit(field(node, 'body')?.namedChildren ?? []);
      else if (node.type === 'file_scoped_namespace_declaration') visit(node.namedChildren);
      else if (CS_KIND[node.type]) {
        const name = field(node, 'name')?.text;
        if (!name) continue;
        const exported = csMods(node).includes('public');
        syms.add(name, CS_KIND[node.type], exported, node);
        if (!exported) continue;
        const iface = node.type === 'interface_declaration';
        for (const m of field(node, 'body')?.namedChildren ?? []) {
          if (m.type !== 'method_declaration') continue;
          const mods = csMods(m);
          syms.add(`${name}.${field(m, 'name')?.text}`, 'method', iface || mods.includes('public') || mods.includes('protected'), m);
        }
      }
    }
  };
  visit(root.namedChildren);
  return { symbols: syms.list, imports };
}

// ---------- Swift ----------

const swiftVisible = (n: Node) => !(field(n, 'modifiers') ?? n.namedChildren.find((c) => c.type === 'modifiers'))?.text.match(/\b(private|fileprivate)\b/);
// The grammar sometimes wraps a valid member in an ERROR node; its children are still the declarations.
const flatErrors = (nodes: Node[]): Node[] => nodes.flatMap((n) => (n.type === 'ERROR' ? flatErrors(n.namedChildren) : [n]));

function extractSwift(root: Node): Extracted {
  const syms = collector();
  const imports: RawImport[] = [];
  for (const node of flatErrors(root.namedChildren)) {
    const nameNode = field(node, 'name');
    switch (node.type) {
      case 'import_declaration': {
        const id = node.namedChildren.find((c) => c.type === 'identifier');
        if (id) imports.push({ spec: id.text, names: ['*'] });
        break;
      }
      case 'class_declaration': {
        const declKind = field(node, 'declaration_kind')?.text;
        const name = nameNode?.text;
        if (!name) break;
        const visible = swiftVisible(node);
        if (declKind !== 'extension') syms.add(name, declKind === 'enum' ? 'type' : 'class', visible, node);
        if (!visible) break;
        for (const m of flatErrors(field(node, 'body')?.namedChildren ?? [])) {
          if (m.type === 'function_declaration') syms.add(`${name}.${field(m, 'name')?.text}`, 'method', swiftVisible(m), m);
        }
        break;
      }
      case 'protocol_declaration': syms.add(nameNode?.text, 'interface', swiftVisible(node), node); break;
      case 'function_declaration': syms.add(nameNode?.text, 'function', swiftVisible(node), node); break;
      case 'typealias_declaration': syms.add(nameNode?.text, 'type', swiftVisible(node), node); break;
      case 'property_declaration': {
        const n = field(nameNode, 'bound_identifier') ?? nameNode;
        syms.add(n?.text, 'const', swiftVisible(node), node);
        break;
      }
    }
  }
  return { symbols: syms.list, imports };
}

const EXTRACTORS: Record<string, (root: Node) => Extracted> = {
  typescript: extractJs, tsx: extractJs, javascript: extractJs, python: extractPython, go: extractGo, rust: extractRust, csharp: extractCsharp, swift: extractSwift,
};

/** Symbols and raw imports of one file; null when the language has no grammar (GDScript is read line by line). */
export async function extract(lang: string, source: string): Promise<Extracted | null> {
  if (lang === 'gdscript') return extractGdscript(source);
  const fn = Object.hasOwn(EXTRACTORS, lang) ? EXTRACTORS[lang] : undefined;
  const parser = fn ? await loadParser(lang) : null;
  if (!fn || !parser) return null;
  const tree = parser.parse(source);
  if (!tree) return null;
  try {
    return fn(tree.rootNode);
  } finally {
    tree.delete(); // trees live in WASM memory, not the JS heap
  }
}
