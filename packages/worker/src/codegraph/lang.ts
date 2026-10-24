import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

const BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.cs': 'csharp', '.swift': 'swift', '.gd': 'gdscript',
};

/** Our lang name -> the grammar file in @repomix/tree-sitter-wasms. GDScript has no maintained prebuilt grammar there. */
const GRAMMAR: Record<string, string> = {
  typescript: 'typescript', tsx: 'tsx', javascript: 'javascript', python: 'python', go: 'go', rust: 'rust', csharp: 'c_sharp', swift: 'swift',
};

export function langOf(path: string): string {
  const name = path.split('/').pop()!;
  const ext = extname(name).toLowerCase();
  if (Object.hasOwn(BY_EXT, ext)) return BY_EXT[ext];
  if (ext && ext !== name) return ext.slice(1);
  return name.replace(/^\./, '').toLowerCase();
}

const TEST_DIRS = new Set(['__tests__', 'tests', 'test']);
const TEST_FILE = /\.(test|spec)\.[^./]+$|^test_[^/]*\.(py|gd)$|_test\.(py|go)$|Tests?\.(cs|swift)$/;

export function isTestPath(path: string): boolean {
  const segs = path.split('/');
  const name = segs.pop()!;
  return TEST_FILE.test(name) || segs.some((s) => TEST_DIRS.has(s.toLowerCase()));
}

let init: Promise<void> | null = null;
const parsers = new Map<string, Promise<Parser | null>>();

/** One parser per language, created on first use; null when there is no grammar for it. */
export function loadParser(lang: string): Promise<Parser | null> {
  const grammar = Object.hasOwn(GRAMMAR, lang) ? GRAMMAR[lang] : undefined;
  if (!grammar) return Promise.resolve(null);
  let p = parsers.get(lang);
  if (!p) {
    init ??= Parser.init().catch((e: unknown) => {
      init = null;
      throw e;
    });
    p = init.then(async () => {
      const language = await Language.load(require.resolve(`@repomix/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    });
    // A failed load is retried on the next call rather than cached.
    p.catch(() => parsers.delete(lang));
    parsers.set(lang, p);
  }
  return p;
}
