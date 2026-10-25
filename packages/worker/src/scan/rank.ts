import { extname } from 'node:path';
import { isTestPath } from '../codegraph/lang.ts';

/**
 * Which files a capped list keeps. Alphabetical order filled a monorepo's quota with `.github/`, `deploy/` and `docs/`
 * before `src/` was reached; candidates are ranked first, so the cap cuts the files an agent needs least.
 *
 * Tiers, best first: files sessions edited; the manifests imports are resolved against (few, and without them a map
 * of the rest has no edges); source in languages whose imports resolve; other programming languages; scripts, infra
 * and schemas; tests; other manifests; docs; everything else (YAML and JSON config, data). Within a tier, files under
 * a hidden folder (`.github/`, `.claude/`) come last, then code-point order.
 */
const RESOLVER_INPUT = /(^|\/)(package\.json|go\.mod|Cargo\.toml|Package\.swift|project\.godot|[tj]sconfig[^/]*\.json)$/;
const RESOLVABLE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.cs', '.swift', '.gd']);
const OTHER_LANG = new Set(['.rb', '.java', '.kt', '.cpp', '.c', '.h', '.lua', '.php', '.vue', '.svelte', '.css', '.scss', '.html']);
const SCRIPT_INFRA = new Set(['.sh', '.sql', '.tf', '.graphql', '.proto', '.prisma']);
const MANIFEST_NAMES = new Set(['Dockerfile', 'Makefile', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'composer.json', '.env.example', 'docker-compose.yml', 'compose.yaml']);
const DOCS = new Set(['.md', '.mdx']);

const TIER = { priority: 0, resolver: 1, resolvable: 2, otherLang: 3, scriptInfra: 4, test: 5, manifest: 6, docs: 7, other: 8 } as const;

function tierOf(path: string): number {
  const name = path.split('/').pop()!;
  if (RESOLVER_INPUT.test(path)) return TIER.resolver;
  const ext = extname(name).toLowerCase();
  const source = RESOLVABLE.has(ext) || OTHER_LANG.has(ext) || SCRIPT_INFRA.has(ext);
  if (source && isTestPath(path)) return TIER.test;
  if (RESOLVABLE.has(ext)) return TIER.resolvable;
  if (OTHER_LANG.has(ext)) return TIER.otherLang;
  if (SCRIPT_INFRA.has(ext)) return TIER.scriptInfra;
  if (MANIFEST_NAMES.has(name) || /(^|\/)(compose|docker-compose)[^/]*\.ya?ml$/.test(path) || ext === '.toml') return TIER.manifest;
  if (DOCS.has(ext)) return TIER.docs;
  return TIER.other;
}

const hidden = (path: string) => path.split('/').slice(0, -1).some((s) => s.startsWith('.'));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const TEST_DIR = new Set(['__tests__', 'tests', 'test']);
const stemOf = (name: string) => name.replace(/(\.d)?\.[^.]+$/, '');
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** Where the file a test is about would be (`dir/stem`): beside it, or above its __tests__/tests folder. */
function subjectKeys(test: string): string[] {
  const name = test.split('/').pop()!;
  const stem = stemOf(name).replace(/\.(test|spec)$/, '').replace(/_test$/, '').replace(/^test_/, '').replace(/Tests?$/, '');
  const dir = dirOf(test);
  const keys = [`${dir}/${stem}`];
  if (TEST_DIR.has(dir.split('/').pop()!.toLowerCase())) keys.push(`${dirOf(dir)}/${stem}`);
  return keys;
}

/**
 * The paths, best first (see above). `priority`: paths to put first, in their order (only ones among `paths`). A test
 * whose file sits beside it (or above its __tests__ folder) comes right after that file instead of in the test tier,
 * so a capped map that keeps a file keeps the tests that cover it.
 */
export function rankCodePaths(paths: string[], o: { priority?: Iterable<string> } = {}): string[] {
  const present = new Set(paths);
  const first = [...new Set(o.priority ?? [])].filter((p) => present.has(p));
  const taken = new Set(first);
  const rest = paths
    .filter((p) => !taken.has(p))
    .map((p) => ({ p, t: tierOf(p), h: hidden(p) ? 1 : 0 }))
    .sort((a, b) => a.t - b.t || a.h - b.h || cmp(a.p, b.p))
    .map((x) => x.p);
  const subjects = new Map<string, string>();
  for (const p of rest) if (tierOf(p) !== TIER.test) subjects.set(`${dirOf(p)}/${stemOf(p.split('/').pop()!)}`, p);
  const attached = new Map<string, string[]>();
  const placed = new Set<string>();
  for (const p of rest) {
    if (tierOf(p) !== TIER.test) continue;
    const subject = subjectKeys(p).map((k) => subjects.get(k)).find((s) => s !== undefined);
    if (!subject) continue;
    attached.set(subject, [...(attached.get(subject) ?? []), p]);
    placed.add(p);
  }
  return [...first, ...rest.filter((p) => !placed.has(p)).flatMap((p) => [p, ...(attached.get(p) ?? [])])];
}

// Defined in core, which also says from them whether a map is capped (mapCapped).
import { MAX_AUTO_MAP_FILES, MIN_MAP_FILES } from '@fb/core';
export { MAX_AUTO_MAP_FILES, MIN_MAP_FILES };
const AUTO_SHARE = 0.4;

/** How many files a map keeps: SCAN_MAX_FILES when set, else 40% of the candidates, at least 400 and at most 4000. */
export function mapCap(maxFiles: number | null, candidates: number): number {
  if (maxFiles !== null) return maxFiles;
  return Math.min(MAX_AUTO_MAP_FILES, Math.max(MIN_MAP_FILES, Math.ceil(candidates * AUTO_SHARE)));
}
