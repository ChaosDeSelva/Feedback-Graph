import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GIT_SAFE, gitSafeEnv } from '../ingest/git.ts';
import { extract } from '../codegraph/extract.ts';
import { langOf } from '../codegraph/lang.ts';
import { chunkBySymbols, type Chunk } from './chunk.ts';
import { mapCap, rankCodePaths } from './rank.ts';
import { withoutDataDirs, type DataDir } from './data.ts';
import { gitChurn, hotScore, longCommentLines, scanOrder, type ScanSignals } from './priority.ts';
import { inScope, lowValueBudget, lowValueRule, shardBudget, shardFactBudget, shardRepo, shardScope, type Shard } from './shard.ts';
import { askJson, calibrateRelevance, clampRelevance, FACT_KINDS, holdsCredential, SCAN_PROMPT_VERSION, SCANNER_VERSION, type AgentMirror, isSecretPath, modelTimeoutReason, ProviderUnavailableError, providerUnavailableReason, redactSecrets, type ActivityStore, type CodeFact, type FactScope, type FactsStore, type LlmProvider, type ScanJob, type ScanShards } from '@fb/core';

const run = promisify(execFile);

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.cs', '.cpp', '.c', '.h',
  '.lua', '.gd', '.php', '.sql', '.graphql', '.proto', '.vue', '.svelte', '.css', '.scss', '.html', '.md', '.mdx', '.json',
  '.yaml', '.yml', '.toml', '.sh', '.tf', '.prisma',
]);
// project.godot marks where a Godot project's res:// starts (codegraph resolves GDScript paths against it).
// go.mod: Go imports resolve against its module path.
const CODE_NAMES = new Set(['Dockerfile', 'Makefile', '.gitignore', '.env.example', 'project.godot', 'go.mod']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage', 'vendor', '.venv', '__pycache__', 'target', '.turbo', '.cache']);
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock']);
/** Files that hold credentials are never read, whatever their extension (the list lives in core). */
const SECRET_FILE = { test: isSecretPath };
export const MIN_CONFIDENCE = 0.5;
// The scanner's versions live in core (scanner.ts): the API counts the files an older scanner read.
export { SCAN_PROMPT_VERSION, SCAN_READER_VERSION, SCANNER_VERSION } from '@fb/core';
const MAX_FILE_CHARS = 24_000;
/** Files in a row whose model call timed out before a per-file scan gives up on this run. */
const MAX_TIMEOUTS_IN_ROW = 3;

/** comments: long explanatory comment lines (priority.ts), when the listing was asked to count them. */
export type CodeFile = { path: string; hash: string; size: number; comments?: number };

const wanted = (path: string) => {
  const name = path.split('/').pop()!;
  if (LOCKFILES.has(name) || name.endsWith('.min.js') || SECRET_FILE.test(path)) return false;
  if (path.split('/').some((seg) => SKIP_DIRS.has(seg))) return false;
  return CODE_NAMES.has(name) || CODE_EXT.has(extname(name));
};

async function gitFiles(repoPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'ls-files', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env: gitSafeEnv() });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await walk(root, p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/** comments: also count each file's long explanatory comments (CodeFile.comments), for the scan order. */
export type ListOpts = { maxBytes: number; maxFiles: number | null; priority?: Iterable<string>; comments?: boolean };

/**
 * Source, docs and config worth reading; respects .gitignore when the dir is a git repo. Candidates are ranked before
 * the cap (rank.ts), so a capped list keeps source over config and docs, and `priority` paths (files sessions edited)
 * before anything. maxFiles null: the cap scales with the repo (mapCap). totalCandidates: how many files were worth
 * listing before the cap, so a capped map can say what it left out. dataDirs: folders of data left out (data.ts).
 */
export async function listCodeFilesWithTotal(repoPath: string, o: ListOpts): Promise<{ files: CodeFile[]; totalCandidates: number; cap: number; dataDirs: DataDir[] }> {
  const { paths: candidates, dataDirs } = await candidatesOf(repoPath);
  const cap = mapCap(o.maxFiles, candidates.length);
  const files: CodeFile[] = [];
  for (const path of rankCodePaths(candidates, { priority: o.priority })) {
    if (files.length >= cap) break;
    const s = await lstat(join(repoPath, path)).catch(() => null); // a symlink could point at a secret or outside the repo
    if (!s?.isFile() || s.size > o.maxBytes) continue;
    const content = await readFile(join(repoPath, path));
    files.push({ path, size: s.size, hash: createHash('sha1').update(content).digest('hex'), ...(o.comments && { comments: longCommentLines(path, content.toString('utf8')) }) });
  }
  return { files, totalCandidates: candidates.length, cap, dataDirs };
}

/**
 * Every file worth reading, as git lists it (else a walk), less the folders of data (transcripts, logs, exported
 * records: withoutDataDirs), which are left out of scans and the code map alike.
 */
async function candidatesOf(repoPath: string): Promise<{ paths: string[]; dataDirs: DataDir[] }> {
  return withoutDataDirs(((await gitFiles(repoPath)) ?? (await walk(repoPath))).filter(wanted));
}

/**
 * What the code map reads: every candidate that is a regular file within maxBytes, ranked by tier (rank.ts) with
 * `priority` first, at most `limit` of them; and the map's cap (mapCap). The map parses all of them for its import
 * index and keeps symbols for the first `cap` once it knows their importers.
 */
export async function listIndexPaths(repoPath: string, o: ListOpts & { limit: number }): Promise<{ paths: string[]; totalCandidates: number; cap: number }> {
  const { paths: candidates } = await candidatesOf(repoPath);
  const cap = mapCap(o.maxFiles, candidates.length);
  const paths: string[] = [];
  for (const path of rankCodePaths(candidates, { priority: o.priority })) {
    if (paths.length >= o.limit) break;
    const s = await lstat(join(repoPath, path)).catch(() => null); // a symlink could point at a secret or outside the repo
    if (s?.isFile() && s.size <= o.maxBytes) paths.push(path);
  }
  return { paths, totalCandidates: candidates.length, cap };
}

/** The files a scan or a map would consider, before ranking and the cap (repo-relative paths). */
export async function candidatePaths(repoPath: string): Promise<string[]> {
  return (await candidatesOf(repoPath)).paths;
}

/**
 * Whether the folder has any file worth scanning (a scan of one without finishes at once, with no model call). A folder
 * of only data (transcripts, logs) has none.
 */
export async function hasCodeFiles(repoPath: string): Promise<boolean> {
  return (await candidatesOf(repoPath)).paths.length > 0;
}

export async function listCodeFiles(repoPath: string, o: ListOpts): Promise<CodeFile[]> {
  return (await listCodeFilesWithTotal(repoPath, o)).files;
}

/** Manifests read without a model: package.json, pyproject.toml, go.mod, Cargo.toml, Makefile, compose files, .env.example. */
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|Makefile|\.env\.example|(docker-)?compose[^/]*\.ya?ml)$/;
export const isManifest = (path: string) => MANIFEST.test(path);

/** Instruction files agents read on their own (AGENTS.md, CLAUDE.md, ...): a fact restating one adds nothing. */
const INSTRUCTION_FILE = /(^|\/)((AGENTS|CLAUDE|GEMINI)\.md|\.cursorrules|\.github\/copilot-instructions\.md)$/i;
export const isInstructionFile = (path: string) => INSTRUCTION_FILE.test(path);

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const manifestFact = (kind: CodeFact['kind'], statement: string, path: string, relevance: number): CodeFact => ({
  kind, statement, path, lines: null, confidence: 1, why: `Read directly from ${baseName(path)}; no model involved.`, relevance, origin: 'manifest', evidence: 'file',
});

/** TOML split into its [sections] (name -> body); enough for the keys read here, no TOML library. */
function tomlSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/);
    if (h) name = h[1].trim();
    else out.set(name, `${out.get(name) ?? ''}${line}\n`);
  }
  return out;
}
const tomlString = (body: string | undefined, key: string) => body?.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm'))?.[1];
/** `name = "1.2"` or `name = { version = "1.2", ... }` lines of a dependency table, as "name 1.2" (or just the name). */
const tomlDeps = (body: string | undefined, skip: string[] = []) =>
  [...(body ?? '').matchAll(/^\s*([\w.-]+)\s*=\s*(.+)$/gm)]
    .filter(([, n]) => !skip.includes(n))
    .map(([, n, v]) => {
      const ver = v.trim().startsWith('{') ? v.match(/version\s*=\s*["']([^"']+)["']/)?.[1] : v.match(/^["']([^"']+)["']/)?.[1];
      return ver ? `${n} ${ver}` : n;
    });
const sentence = (label: string, xs: string[]) => (xs.length ? `${label}: ${xs.join(', ')}.` : '');

/**
 * A dependency fact's statement at most: how many, and the notable ones that fit. The full list is the manifest's
 * (and the code map's): 0.6.2 stored lists of up to 6,923 characters as one fact, which crowded out what agents need.
 */
export const DEPENDENCY_FACT_MAX = 300;
/** The least notable dependencies (type packages, lint and build plugins): listed last, so first left out. */
const MINOR_DEPENDENCY = /^@types\/|eslint|prettier|^@babel\/|-plugin-|^typescript\b|stylelint|^@commitlint\//;
const DEP_SECTION = /(Dependencies|Dev dependencies|Requires)(?: \(\d+\))?: (.+?)\.(?= (?:Dependencies|Dev dependencies|Requires)\b|$)/g;

/**
 * A dependency statement within DEPENDENCY_FACT_MAX: each list ("Dependencies: a 1, b 2, ...") becomes its count and
 * its most notable entries that fit ("Dependencies (120): react ^18, hono ^4 and 117 more."); what comes before the
 * lists (the Go module, the Python version) stays. A statement that already fits is returned as it is, so applying it
 * twice changes nothing.
 */
export function summarizeDependencies(statement: string): string {
  if (statement.length <= DEPENDENCY_FACT_MAX) return statement;
  const sections = [...statement.matchAll(DEP_SECTION)];
  if (!sections.length) return `${statement.slice(0, DEPENDENCY_FACT_MAX - 3).trimEnd()}...`;
  const head = statement.slice(0, sections[0].index).trim();
  const room = Math.floor((DEPENDENCY_FACT_MAX - head.length - (head ? 1 : 0)) / sections.length) - 1;
  const lists = sections.map(([whole, label, list]) => {
    const items = list.split(', ').filter(Boolean);
    if (whole.length <= room && !/\(\d+\):/.test(whole)) return whole;
    const notable = [...items.filter((x) => !MINOR_DEPENDENCY.test(x)), ...items.filter((x) => MINOR_DEPENDENCY.test(x))];
    const shown: string[] = [];
    const text = (k: number) => `${label} (${items.length}): ${shown.join(', ')}${k ? ` and ${k} more` : ''}.`;
    for (const x of notable) {
      shown.push(x);
      if (text(items.length - shown.length).length > room) {
        shown.pop();
        break;
      }
    }
    return text(items.length - shown.length);
  });
  return [head, ...lists].filter(Boolean).join(' ');
}

function packageJsonFacts(path: string, content: string): CodeFact[] {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(content);
  } catch {
    return [];
  }
  const facts = Object.entries(pkg.scripts ?? {}).map(([name, cmd]) => manifestFact('command', `\`${name}\` script runs: ${cmd}`, path, 0.7));
  const list = (d?: Record<string, string>) => Object.entries(d ?? {}).map(([n, v]) => `${n} ${v}`);
  const deps = [sentence('Dependencies', list(pkg.dependencies)), sentence('Dev dependencies', list(pkg.devDependencies))].filter(Boolean).join(' ');
  if (deps) facts.push(manifestFact('dependency', deps, path, 0.5));
  return facts;
}

function pyprojectFacts(path: string, content: string): CodeFact[] {
  const s = tomlSections(content);
  const scripts = [...(s.get('project.scripts') ?? ''), ...(s.get('tool.poetry.scripts') ?? '')].join('');
  const facts = [...scripts.matchAll(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/gm)].map(([, n, target]) => manifestFact('command', `\`${n}\` script runs: ${target}`, path, 0.6));
  const project = s.get('project');
  const listed = [...(project?.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? '').matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const poetry = tomlDeps(s.get('tool.poetry.dependencies'), ['python']);
  const python = tomlString(project, 'requires-python') ?? tomlString(s.get('tool.poetry.dependencies'), 'python');
  const text = [python ? `Python ${python}.` : '', sentence('Dependencies', [...listed, ...poetry])].filter(Boolean).join(' ');
  if (text) facts.push(manifestFact('dependency', text, path, 0.5));
  return facts;
}

function goModFacts(path: string, content: string): CodeFact[] {
  const mod = content.match(/^module\s+(\S+)/m)?.[1];
  if (!mod) return [];
  const go = content.match(/^go\s+(\S+)/m)?.[1];
  const block = [...content.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)].flatMap((m) => m[1].split('\n'));
  const single = [...content.matchAll(/^require\s+([^(\s].*)$/gm)].map((m) => m[1]);
  const reqs = [...block, ...single].map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
  return [manifestFact('dependency', [`Go module ${mod.replace(/^"|"$/g, '')}${go ? ` (go ${go})` : ''}.`, sentence('Requires', reqs)].filter(Boolean).join(' '), path, 0.5)];
}

function cargoFacts(path: string, content: string): CodeFact[] {
  const s = tomlSections(content);
  const name = tomlString(s.get('package'), 'name');
  const edition = tomlString(s.get('package'), 'edition');
  const text = [
    name ? `Crate ${name}${edition ? ` (edition ${edition})` : ''}.` : '',
    sentence('Dependencies', tomlDeps(s.get('dependencies'))),
    sentence('Dev dependencies', tomlDeps(s.get('dev-dependencies'))),
  ].filter(Boolean).join(' ');
  return text ? [manifestFact('dependency', text, path, 0.5)] : [];
}

function makefileFacts(path: string, content: string): CodeFact[] {
  const targets = [...new Set([...content.matchAll(/^([A-Za-z0-9_][\w./-]*)\s*:(?![=:])/gm)].map((m) => m[1]))];
  return targets.length ? [manifestFact('command', `Make targets: ${targets.join(', ')}.`, path, 0.6)] : [];
}

function composeFacts(path: string, content: string): CodeFact[] {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const services: string[] = [];
  let indent: number | null = null;
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const lead = l.length - l.trimStart().length;
    if (lead === 0) break;
    indent ??= lead;
    const key = lead === indent ? l.trim().match(/^([\w.-]+):/)?.[1] : undefined;
    if (key) services.push(key);
  }
  return services.length ? [manifestFact('config', `Compose services: ${services.join(', ')}.`, path, 0.4)] : [];
}

function envExampleFacts(path: string, content: string): CodeFact[] {
  // Keys only: a value in an example file can still be a real credential.
  const keys = [...new Set([...content.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]))];
  return keys.length ? [manifestFact('config', `Environment keys (from ${baseName(path)}): ${keys.join(', ')}.`, path, 0.5)] : [];
}

/**
 * Facts we can read without a model, from the manifests (isManifest): scripts, targets, dependencies, services, env keys.
 * A dependency fact is a summary (summarizeDependencies), never the full list.
 */
export function deterministicFacts(files: { path: string; content: string }[]): CodeFact[] {
  return manifestFacts(files).map((f) => (f.kind === 'dependency' ? { ...f, statement: summarizeDependencies(f.statement) } : f));
}

function manifestFacts(files: { path: string; content: string }[]): CodeFact[] {
  return files.flatMap(({ path, content }) => {
    const name = baseName(path);
    if (name === 'package.json') return packageJsonFacts(path, content);
    if (name === 'pyproject.toml') return pyprojectFacts(path, content);
    if (name === 'go.mod') return goModFacts(path, content);
    if (name === 'Cargo.toml') return cargoFacts(path, content);
    if (name === 'Makefile') return makefileFacts(path, content);
    if (name === '.env.example') return envExampleFacts(path, content);
    if (isManifest(path)) return composeFacts(path, content);
    return [];
  });
}

const parseRange = (lines: string | null) => {
  const m = lines?.match(/^\s*L?(\d+)(?:\s*[-–:]\s*L?(\d+))?\s*$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return a < 1 ? null : { start: Math.min(a, b), end: Math.max(a, b) };
};
/** Code names a statement mentions: anything in backticks, and camelCase, snake_case or UPPER_CASE words. */
function identifiersIn(statement: string): string[] {
  const ticked = [...statement.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].split(/[^\w$]+/)).filter(Boolean);
  const bare = [...statement.replace(/`[^`]*`/g, ' ').matchAll(/\b[A-Za-z_$][\w$]*(?:[a-z0-9][A-Z]|_[A-Za-z0-9])[\w$]*\b/g)].map((m) => m[0]);
  return [...new Set([...ticked, ...bare])];
}
const mentions = (text: string, id: string) => new RegExp(`(^|[^\\w$])${id.replace(/[$]/g, '\\$')}($|[^\\w$])`).test(text);
/** Lines either side of a cited range that still count: models are often off by a line or two. */
const LINE_SLACK = 2;
/**
 * How far above a cited range the name a statement gives may be declared: a fact about a function's body names the
 * function, declared at its top. 0.6.0 dropped 3 of 25 correct ranges for this.
 */
const ENCLOSING_LINES = 40;
/** How far below a cited range: a fact citing a doc comment names what it documents, a few lines (decorators) down. */
const DOCUMENTED_LINES = 3;

/** A cited range checked against the file: kept (clamped to its end) when it, or what encloses it, holds what the statement names. */
function checkLines(f: CodeFact, content: string): Pick<CodeFact, 'lines' | 'evidence'> {
  const r = parseRange(f.lines);
  if (!r) return { lines: null, evidence: 'file' };
  const all = content.split('\n');
  const count = all.length - (content.endsWith('\n') ? 1 : 0);
  if (r.start > count) return { lines: null, evidence: 'file' };
  const end = Math.min(r.end, count);
  const ids = identifiersIn(f.statement);
  const around = (above: number, below: number) => all.slice(Math.max(0, r.start - 1 - above), end + below).join('\n');
  const holds = (text: string) => ids.some((id) => mentions(text, id));
  if (ids.length && !holds(around(LINE_SLACK, LINE_SLACK)) && !holds(around(ENCLOSING_LINES, DOCUMENTED_LINES))) return { lines: null, evidence: 'file' };
  return { lines: r.start === end ? `${r.start}` : `${r.start}-${end}`, evidence: 'line' };
}

/**
 * The rules checkCitations applies, stamped on every fact a scan saves (CodeFact.checkVersion). Bump when they change:
 * at worker start, facts checked by an older version are checked again once (recheck.ts). check-v2: instruction files
 * (0.6.0) and the enclosing-declaration window (0.6.1).
 */
export const FACT_CHECK_VERSION = 'check-v3';

/**
 * Check what a model cited before its facts are saved. `read`: a repo file's text, null when it exists but is not read
 * (too large, a secret, not a regular file), undefined when it does not exist. A fact citing a missing file or an
 * instruction file (isInstructionFile) is dropped; lines past the end of the file, or that do not hold what the
 * statement names, are dropped from the fact; each kept fact gets its evidence level.
 */
export async function checkCitations<T extends CodeFact>(facts: T[], read: (path: string) => Promise<string | null | undefined>): Promise<{ kept: T[]; dropped: T[] }> {
  const kept: T[] = [];
  const dropped: T[] = [];
  const cache = new Map<string, Promise<string | null | undefined>>();
  for (const f of facts) {
    const path = f.path.trim().replace(/^\.\//, '') || '.';
    if (isInstructionFile(path)) {
      dropped.push(f);
      continue;
    }
    if (path === '.') {
      kept.push({ ...f, path, evidence: 'none' });
      continue;
    }
    if (!cache.has(path)) cache.set(path, read(path).catch(() => undefined));
    const content = await cache.get(path)!;
    if (content === undefined) dropped.push(f);
    else kept.push({ ...f, path, ...(content === null ? { evidence: 'file' as const } : checkLines(f, content)) });
  }
  return { kept, dropped };
}

/** A repo file for checkCitations: its text, null when it exists but is not read, undefined when it is not there. */
export function repoReader(repoPath: string, maxBytes: number) {
  return async (path: string): Promise<string | null | undefined> => {
    if (path.startsWith('/') || path.split('/').includes('..')) return undefined;
    const st = await lstat(join(repoPath, path)).catch(() => null);
    if (!st) return undefined;
    if (!st.isFile() || st.size > maxBytes || SECRET_FILE.test(path)) return null;
    return readFile(join(repoPath, path), 'utf8').catch(() => null);
  };
}

export const FactSchema = z.object({
  kind: z.enum(FACT_KINDS),
  statement: z.string().min(1),
  path: z.string(),
  lines: z.string().nullable(),
  // No longer asked for (every model answered 1.0); a model that still sends one below MIN_CONFIDENCE has it dropped.
  confidence: z.number().min(0).max(1).default(1),
  why: z.string().default(''),
  // Older or smaller models leave it out: the fact is kept unscored and the background scorer scores it later.
  relevance: z.number().nullable().optional().transform((r) => (typeof r === 'number' ? clampRelevance(r) : null)),
});

export const FACT_JSON = {
  type: 'object',
  required: ['kind', 'statement', 'path', 'lines', 'why', 'relevance'],
  properties: {
    kind: { type: 'string', enum: [...FACT_KINDS] },
    statement: { type: 'string', description: 'One self-contained sentence a coding agent can act on' },
    path: { type: 'string', description: "Repo-relative file path, or '.' for the whole project" },
    lines: { type: ['string', 'null'], description: 'e.g. "12-30", or null' },
    why: { type: 'string', description: 'One short sentence: why an agent changing this code needs to know this' },
    relevance: { type: 'number', description: '0..1: how often an agent doing everyday coding here needs this (see the rubric)' },
  },
};

/** Shared with the background scorer and the docs reader, so every fact is scored on one scale. */
export const RELEVANCE_RUBRIC = `Give every fact a relevance from 0 to 1: how often an agent doing everyday coding in this project needs it.
- 0.8 to 1: needed in most changes (core conventions, invariants, the data model, auth and security rules, how modules fit together).
- 0.4 to 0.7: needed for some changes (one module's API, a config option, a gotcha in one area).
- 0 to 0.3: rarely needed while coding (installing, setting up or configuring an external tool, CI or deploy steps, editor or machine setup, history).
Most facts are 0.4 to 0.7: keep 0.8 and above for the few rules that hold across the whole project or service, never for one function's or endpoint's behaviour.`;

const WHAT_TO_KEEP = `Extract durable, non-obvious facts a coding agent would need to change this code correctly:
conventions and patterns to follow, invariants and assumptions, public APIs and their contracts, data models,
config and environment, security/auth rules, gotchas and side effects, and the overall architecture.
Skip anything trivial or obvious from a file name. Prefer fewer, higher-value facts. Never include secrets.
Do not restate AGENTS.md, CLAUDE.md or other agent instruction files: agents read those already. Do not restate
package.json scripts or dependencies, Makefile targets or .gitignore patterns: they are read without you.
Cite the lines a fact comes from whenever it is about code. Never claim a file is missing or absent: the file list you
see is filtered to code, config and docs, so a file not in it may still exist.

${RELEVANCE_RUBRIC}`;

const FileResult = z.object({ summary: z.string(), facts: z.array(FactSchema).max(15) });

/** Model calls per file at most: the tail of a file longer than this many chunks is left out. */
const MAX_FILE_CHUNKS = 4;

/** The file as the model reads it: whole when it fits, else cut where top-level symbols start (chunk.ts). */
async function fileChunks(path: string, content: string): Promise<Chunk[]> {
  if (content.length <= MAX_FILE_CHARS) return [{ text: content, lines: '' }];
  const symbols = (await extract(langOf(path), content).catch(() => null))?.symbols ?? [];
  const starts = symbols.filter((s) => s.kind !== 'method').map((s) => Number.parseInt(s.lines, 10));
  return chunkBySymbols(content, starts, MAX_FILE_CHARS, MAX_FILE_CHUNKS);
}

export async function extractFileFacts(llm: LlmProvider, path: string, content: string): Promise<{ summary: string; facts: CodeFact[] }> {
  const chunks = await fileChunks(path, content);
  const clean = (f: CodeFact) => ({ ...f, statement: redactSecrets(f.statement), why: redactSecrets(f.why) });
  let summary = '';
  const facts: CodeFact[] = [];
  for (const [i, c] of chunks.entries()) {
    const part = chunks.length > 1 ? ` (lines ${c.lines}, part ${i + 1} of ${chunks.length})` : '';
    // The file's text is the whole input: an agentic model gets an empty folder, not the worker's.
    const r = await askJson(llm, {
      system: `You analyse one source file from a codebase${part ? ', one part at a time' : ''}. ${WHAT_TO_KEEP} At most 10 facts.`,
      user: `FILE: ${path}${part}\n\n${redactSecrets(c.text)}`,
      schema: {
        type: 'object',
        required: ['summary', 'facts'],
        properties: { summary: { type: 'string', description: 'One sentence: what this file is for' }, facts: { type: 'array', items: FACT_JSON } },
      },
      timeoutMs: 180_000,
    }, (raw) => FileResult.parse(raw), { promptOnly: true });
    summary ||= r.summary;
    // A fact that is a credential is never kept (holdsCredential): it would reach agents as a secret.
    facts.push(...r.facts.filter((f) => f.confidence >= MIN_CONFIDENCE).slice(0, 10).filter((f) => !holdsCredential(f.statement)).map((f) => clean({ ...f, path })));
  }
  return { summary: redactSecrets(summary), facts };
}

const AgenticResult = z.object({
  facts: z.array(FactSchema).max(120),
  // Older answers (and agents that reached everything) leave it out.
  unreached: z.array(z.string()).max(500).default([]),
});

/**
 * What one agent run is about: a shard of the repo (shard.ts), its files (best first: priority.ts), and the paths its
 * facts may cite. hot: files to read before the rest (asked for, or hotspots), best first.
 */
/** lowValue: which of the repo's files are low-value (lowValueRule over the whole listing; absent: over the shard's files). */
export type ShardTask = { key: string; roots: string[]; scope: FactScope; files: CodeFile[]; hot?: string[]; lowValue?: (path: string) => boolean };

/** A directory with at least this many of a shard's files gets a minimum of facts of its own. */
const LARGE_DIR_FILES = 30;
/** Hotspots listed before the directories, at most. */
const HOT_LISTED = 25;
/** What an agent says it did not reach, kept per shard. */
const MAX_UNREACHED = 100;

/** Low-value files (tests, fixtures, archives: isLowValue) listed to the agent at most, and at least. */
const LOW_VALUE_LISTED_MAX = 15;
const LOW_VALUE_LISTED_MIN = 3;
/** A shard with at least this many source files must return a third of its budget (the floor, enforced in code). */
const FLOOR_FILES = 20;
/** How long one agent run over a shard may take; a shard of only low-value files gets the shorter one. */
const SHARD_TIMEOUT_MS = 30 * 60_000;
const LOW_VALUE_SHARD_TIMEOUT_MS = 10 * 60_000;
/** The one top-up run after a pass under the floor: it asks for a few facts more, not a shard's worth. */
const TOP_UP_TIMEOUT_MS = 5 * 60_000;
/** Statements an agent asked for more facts is told it already gave, at most. */
const TOP_UP_LISTED = 60;

const dirOfPath = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const underDir = (path: string, dir: string) => dirOfPath(path) === dir;
/** A fact restated: the same file and the same statement, whatever the case, spacing or final full stop. */
export const factKey = (f: Pick<CodeFact, 'path' | 'statement'>) => `${f.path.trim().replace(/^\.\//, '')}\u0000${f.statement.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '')}`;
const relevanceOrMiddling = (f: CodeFact) => (typeof f.relevance === 'number' ? f.relevance : 0.5);
/** The `n` most relevant of `facts`, in their own order. */
function mostRelevant<T extends CodeFact>(facts: T[], n: number): T[] {
  if (facts.length <= n) return facts;
  const keep = new Set([...facts].sort((a, b) => relevanceOrMiddling(b) - relevanceOrMiddling(a)).slice(0, n));
  return facts.filter((f) => keep.has(f));
}

/**
 * How one shard's run is budgeted, all enforced in code: its source files and its low-value ones (tests, fixtures,
 * archives), the fact budget from that mix (shardFactBudget), the share low-value files may take (lowValueBudget), the
 * floor (a third of the budget, for a shard of FLOOR_FILES source files or more) and each large source directory's
 * minimum (half its proportional share of the source budget, so one directory cannot take the whole run).
 */
function shardPlan(shard: ShardTask) {
  const isLow = shard.lowValue ?? lowValueRule(shard.files.map((f) => f.path));
  const core = shard.files.filter((f) => !isLow(f.path));
  const low = shard.files.filter((f) => isLow(f.path));
  const budget = shardFactBudget(core.length, low.length);
  const coreBudget = core.length ? shardBudget(core.length) : 0;
  const groups = new Map<string, string[]>();
  for (const f of core) {
    const d = dirOfPath(f.path);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(f.path);
  }
  const mins = new Map([...groups].map(([d, paths]) => [d, paths.length >= LARGE_DIR_FILES ? Math.max(1, Math.round((Math.min(coreBudget, budget) * paths.length) / core.length / 2)) : 0]));
  return { isLow, core, low, budget, lowBudget: lowValueBudget(low.length), floor: core.length >= FLOOR_FILES ? Math.ceil(budget / 3) : 0, groups, mins };
}

/**
 * The file list an agent is given: hotspots first (`hot`), then every source file grouped by directory, directories in
 * the order of their best file, a large one (LARGE_DIR_FILES) with its minimum; then a sample of the low-value files
 * (best first), with how many there are and the most facts they may take.
 */
function shardListing(shard: ShardTask, plan: ReturnType<typeof shardPlan>): string {
  const hot = (shard.hot ?? []).slice(0, HOT_LISTED);
  const lines = hot.length
    ? ['Read these first (an agent asked for them, they changed recently, PRs discuss them, or they carry long explanatory comments, where traps are written down):', ...hot, '']
    : [];
  lines.push('Files in this part, by directory:');
  for (const [d, paths] of plan.groups) {
    const min = plan.mins.get(d) ?? 0;
    lines.push(`## ${d} (${plural(paths.length, 'file')})${min ? `: at least ${plural(min, 'fact')} from here` : ''}`, ...paths);
  }
  if (plan.low.length) {
    const sample = plan.low.slice(0, Math.min(LOW_VALUE_LISTED_MAX, Math.max(LOW_VALUE_LISTED_MIN, Math.ceil(plan.low.length / 10))));
    lines.push(`## Tests, fixtures, archived, vendored and generated files (${plural(plan.low.length, 'file')}, ${sample.length} listed): at most ${plural(plan.lowBudget, 'fact')} from these; read the source first`, ...sample.map((f) => f.path));
  }
  return lines.join('\n');
}

/** What the code cut from a shard's answer: facts past the low-value share, and facts past the budget. */
export type ShardHidden = { lowValue: number; overBudget: number };

/**
 * One agent run over one shard: the agent works in the whole repo (read-only; `cwd`, the repo or a mirror of it) but
 * is shown the shard's files and asked for facts about them only, within a budget scaled to the shard's mix
 * (shardPlan), and for what it did not reach. Facts about the shard as a whole cite its directory ('.' for the shard
 * holding the rest of the repo). The budget is enforced here, not only asked for: an answer under the floor (or
 * leaving a large directory under its minimum) is followed by one more run asking for the missing facts there
 * (toppedUp; a fact given twice counts once), facts about low-value files past their share and facts past the budget
 * are cut, least relevant first (hidden says how many). runScan then drops facts outside the shard and checks citations
 * before anything is saved.
 */
export async function extractShardFacts(llm: LlmProvider, cwd: string, shard: ShardTask, o: { log?: (msg: string, extra?: object) => void } = {}): Promise<{ facts: CodeFact[]; unreached: string[]; hidden: ShardHidden; toppedUp: boolean }> {
  const plan = shardPlan(shard);
  const { budget } = plan;
  const whole = shard.scope.prefixes.includes('') && !shard.scope.except.length;
  const rest = shard.scope.prefixes.includes('');
  const named = shard.roots.filter(Boolean);
  const part = rest
    ? `the repository outside ${shard.scope.except.join(', ')}${named.length ? ` (its top level and ${named.join(', ')})` : ''}`
    : `the files under ${named.join(', ')}`;
  const wide = rest ? '.' : named[0];
  const intro = whole
    ? 'You analyse a whole codebase (your current directory, read-only). Explore it with your tools.'
    : `You analyse one part of a codebase: ${part}. Your current directory is the whole repository (read-only): explore it with your tools, and read outside this part when that explains it, but report facts only about files in this part.`;
  const cite = `Every fact must cite the file it comes from (repo-relative)${whole ? '' : ', from the list'}, or '${wide}' for facts about ${whole ? 'the whole project' : 'this part as a whole'}.`;
  const schema = {
    type: 'object', required: ['facts', 'unreached'],
    properties: { facts: { type: 'array', items: FACT_JSON }, unreached: { type: 'array', items: { type: 'string' }, description: 'Repo-relative directories or files of this part you did not read' } },
  };
  const timeoutMs = plan.core.length ? SHARD_TIMEOUT_MS : LOW_VALUE_SHARD_TIMEOUT_MS;
  const usable = (r: z.infer<typeof AgenticResult>) => r.facts.filter((f) => f.confidence >= MIN_CONFIDENCE && !holdsCredential(f.statement)).map((f) => ({ ...f, origin: 'model' as const }));
  // Agents sometimes answer with prose around (or instead of) the object: asked once more, strictly, before it counts.
  const r = await askJson(llm, {
    system: `${intro} ${WHAT_TO_KEEP}
Return ${Math.ceil(budget / 3)} to ${budget} facts. ${cite}
Read the files listed first before the rest, and cover every directory: a directory marked with a minimum needs at least that many facts from its files.
In unreached, list the directories (or files) of ${whole ? 'the repository' : 'this part'} you did not get to read, so they can be read another time; an empty list means you read them all.`,
    user: `SHARD: ${shard.key}\n${shardListing(shard, plan)}`,
    schema,
    cwd,
    timeoutMs,
  }, (raw) => AgenticResult.parse(raw));
  const seen = new Set<string>();
  const once = (fs: CodeFact[]) => fs.filter((f) => !seen.has(factKey(f)) && !!seen.add(factKey(f)));
  let facts = once(usable(r));
  const unreachedRaw = [...r.unreached];
  // The floor, in code: under it (or a large directory under its minimum), one more run asks for what is missing.
  const inDir = (d: string) => facts.filter((f) => underDir(f.path.trim().replace(/^\.\//, ''), d)).length;
  const short = [...plan.mins].map(([d, min]) => [d, min - inDir(d)] as const).filter(([, n]) => n > 0);
  const missing = Math.max(plan.floor - facts.length, short.reduce((n, [, k]) => n + k, 0));
  let toppedUp = false;
  if (missing > 0 && facts.length < budget) {
    const dirs = short.length ? short : [...plan.groups.keys()].map((d) => [d, 0] as const);
    const listed = facts.slice(0, TOP_UP_LISTED).map((f) => `- ${f.path}: ${f.statement}`).join('\n');
    // A top-up that fails (times out, answers badly) keeps the first pass: its facts are saved, not thrown away with
    // the shard. Only the provider being unavailable stops the scan, as for any run.
    const more = await askJson(llm, {
      system: `${intro} ${WHAT_TO_KEEP}
An earlier pass over this part returned ${plural(facts.length, 'fact')}, too few for it. Return at least ${missing} more facts (${budget - facts.length} at most), from the directories listed, that are not already among these:
${listed || '(none)'}
${cite}
In unreached, list the directories (or files) you did not get to read; an empty list means you read them all.`,
      user: `SHARD: ${shard.key}\nDirectories short of facts:\n${dirs.map(([d, n]) => `## ${d} (${plural(plan.groups.get(d)?.length ?? 0, 'file')})${n ? `: at least ${n} more ${n === 1 ? 'fact' : 'facts'} from here` : ''}\n${(plan.groups.get(d) ?? []).join('\n')}`).join('\n')}`,
      schema,
      cwd,
      timeoutMs: Math.min(timeoutMs, TOP_UP_TIMEOUT_MS),
    }, (raw) => AgenticResult.parse(raw)).catch((err: unknown) => {
      if (providerUnavailableReason(err)) throw err;
      o.log?.(`scan: the top-up for ${shard.key} failed (${redactSecrets(String(err))}); keeping the first pass's ${plural(facts.length, 'fact')}`, { shard: shard.key });
      return null;
    });
    if (more) {
      facts = [...facts, ...once(usable(more))];
      unreachedRaw.push(...more.unreached);
      toppedUp = true;
    }
  }
  // The low-value share and the budget, in code: the least relevant facts past them are cut.
  const lowFacts = facts.filter((f) => plan.isLow(f.path.trim()));
  const lowKept = new Set(mostRelevant(lowFacts, plan.lowBudget));
  const withinLow = facts.filter((f) => !plan.isLow(f.path.trim()) || lowKept.has(f));
  const kept = mostRelevant(withinLow, budget);
  const unreached = [...new Set(unreachedRaw.map((p) => p.trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter((p) => p && p !== '.' && inScope(p, shard.scope)))];
  return { facts: kept, unreached: unreached.slice(0, MAX_UNREACHED), hidden: { lowValue: facts.length - withinLow.length, overBudget: withinLow.length - kept.length }, toppedUp };
}

/**
 * One shard in a scan's result: its files, the facts saved for it, whether it was skipped (unchanged) or failed, and
 * the directories or files its agent said it did not reach (absent: none).
 */
export type ShardCoverage = { shard: string; files: number; facts: number; skipped: boolean; failed?: string; unreached?: string[] };

/** A shard's model facts, kept to its scope: '.' becomes the shard's own directory, facts outside it are dropped. */
function inShard(facts: CodeFact[], shard: ShardTask): { inside: CodeFact[]; outside: CodeFact[] } {
  const wide = shard.scope.prefixes.includes('') ? '.' : shard.roots.find(Boolean)!;
  const moved = facts.map((f) => {
    const path = f.path.trim().replace(/^\.\//, '') || '.';
    return { ...f, path: path === '.' ? wide : path };
  });
  return { inside: moved.filter((f) => inScope(f.path, shard.scope)), outside: moved.filter((f) => !inScope(f.path, shard.scope)) };
}

export type ScanDeps = {
  /**
   * listFacts (optional): after a model switch, which shards still hold the other model's facts (others are skipped).
   * fileScanVersions (optional): files an older scanner read are rescanned (absent: every stored file counts as current).
   */
  facts: Pick<FactsStore, 'fileHashes' | 'saveFileFacts' | 'markFilesRemoved' | 'replaceScopeFacts' | 'updateScanJob' | 'currentSources' | 'recordScanFailure'>
    & Partial<Pick<FactsStore, 'listFacts' | 'fileScanVersions' | 'scanRequests' | 'clearScanRequests' | 'requeueScanJob'>>;
  llm: LlmProvider;
  embed(texts: string[]): Promise<number[][]>;
  maxBytes: number;
  /** SCAN_MAX_FILES: changed files read per run (per-file models); null (unset): DEFAULT_SCAN_FILES. */
  maxFiles: number | null;
  /** Files the project's sessions edited, most recent first: listed (and so scanned) before the rest. */
  touched?: (projectKey: string) => Promise<string[]>;
  /** Repo files review comments or PR discussions are about, when known: hotspots (priority.ts). */
  prPaths?: (projectKey: string) => Promise<string[]>;
  log?: (msg: string, extra?: object) => void;
  activity?: Pick<ActivityStore, 'record'>;
  /**
   * Whether another scan waits for this one's slot (ScanRunner.waiting): asked after each shard an agent ran while
   * another is still to run. True: the job goes back in the queue (requeueScanJob) and this run ends; it goes on from
   * the next shard when its turn comes again. Absent: a sharded scan runs to its end.
   */
  yieldTurn?: () => Promise<boolean>;
  /** Where a sharded scan that gives way keeps its listing, shard plan and mirror for its next turn. Absent: built each turn. */
  plans?: ScanPlans;
};

/**
 * What a sharded scan builds before its first shard (the repo listed and hashed, its churn, the shard plan), kept while
 * it waits its turn again so going on costs no re-list. Never codex's mirror: a copy of one project's repo left in the
 * shared scratch space while another project's scan runs could be read by that scan, so the mirror is removed when the
 * scan gives way and made again when it goes on. Only for the same repo and HEAD: once a commit lands the next turn lists
 * again (an uncommitted edit meanwhile is picked up by the next scan, as one made during an uninterrupted run is).
 */
export type ScanPlan = { head: string; repoPath: string; listed: CodeFile[]; churn: Map<string, number>; planned: Shard[] };

/** Scan plans kept by job id between turns, at most `max` (the oldest goes first). */
export class ScanPlans {
  private readonly plans = new Map<string, ScanPlan>();
  private readonly max: number;
  /** Turns that went on from a kept plan. */
  reused = 0;

  constructor(max = 3) {
    this.max = max;
  }

  /** The job's plan if it was kept for this repo at this HEAD, handed over; one for another repo or HEAD is dropped. */
  take(jobId: string, repoPath: string, head: string): ScanPlan | null {
    const plan = this.plans.get(jobId);
    if (!plan) return null;
    this.plans.delete(jobId);
    if (plan.head !== head || plan.repoPath !== repoPath) return null;
    this.reused++;
    return plan;
  }

  keep(jobId: string, plan: ScanPlan): void {
    this.plans.delete(jobId);
    this.plans.set(jobId, plan);
    for (const id of this.plans.keys()) {
      if (this.plans.size <= this.max) break;
      this.plans.delete(id);
    }
  }

  /** Forget every kept plan (shutdown). */
  clear(): void {
    this.plans.clear();
  }
}

/** The repo's HEAD commit, or null (not a repo, no commit yet). */
async function repoHead(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'rev-parse', '-q', '--verify', 'HEAD'], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Changed files a per-file scan reads per run when SCAN_MAX_FILES is unset; the rest wait for the next scan. */
export const DEFAULT_SCAN_FILES = 400;

const embedFacts = async (facts: CodeFact[], embed: ScanDeps['embed']) => {
  if (!facts.length) return [];
  const vectors = await embed(facts.map((f) => `${f.path}: ${f.statement}`));
  return facts.map((f, i) => ({ ...f, embedding: vectors[i] }));
};

/** Incremental scan: only files whose hash changed are (re)analysed; removed files have their facts closed. */
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** A fact that went through checkCitations (or needs none: a manifest's), stamped with the rule that checked it. */
const checked = <T extends CodeFact>(f: T): T => ({ ...f, checkVersion: FACT_CHECK_VERSION });
const factLog = (facts: CodeFact[]) => facts.map((f) => ({ kind: f.kind, statement: f.statement, why: f.why, ...(f.evidence ? { evidence: f.evidence } : {}) }));

/**
 * failed: files (per-file scans) or shards (agentic scans) that failed. shards: an agentic scan's coverage per shard (of
 * this run). paused: it gave up its slot to another scan with `remaining` shards to go (the counts are the scan's so far).
 */
export type ScanResult = { filesScanned: number; factsAdded: number; failed: number; remaining: number; shards?: ShardCoverage[]; paused?: true };

/** Upper bound on files listed per project, so a giant tree cannot exhaust memory. */
const LIST_LIMIT = 20_000;
/** What the agents said they did not reach, kept on the job at most. */
const JOB_UNREACHED = 200;
const cmpKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function runScan(job: ScanJob, d: ScanDeps): Promise<ScanResult> {
  const note = (kind: 'scan_started' | 'facts_extracted' | 'scan_finished', subject: string, why: string, details: Record<string, unknown> = {}, targets: string[] = []) =>
    d.activity?.record({ kind, actor: d.llm.id, projectKey: job.projectKey, subject, why, details: { scanJobId: job.id, promptVersion: SCAN_PROMPT_VERSION, ...details }, targets });
  const fileId = (path: string) => `${job.projectKey}:${path}`;
  let mirror: AgentMirror | null = null;
  // A sharded scan that gave up its slot earlier goes on from where it was (ScanShards.processed).
  const resume = d.llm.agentic && job.shards?.processed ? job.shards : null;
  /** The shard progress last saved on the job (by this run, or the one it goes on from). */
  let lastShards: ScanShards | null = resume;
  await d.facts.updateScanJob(job.id, { status: 'running' });
  // A sharded scan going on at the same HEAD reuses what its last turn built (ScanPlans); one starting over does not.
  const head = d.plans && d.llm.agentic ? await repoHead(job.repoPath) : null;
  const taken = head ? d.plans!.take(job.id, job.repoPath, head) : null;
  const kept = resume ? taken : null;
  try {
    // List everything, so files beyond the per-run cap are never mistaken for removed ones. Ranked (rank.ts), then put
    // in scan order (priority.ts): files an agent asked for, files sessions edited, then hotspots (churn, PR
    // discussions, long explanatory comments), so a capped or interrupted run has read the files that matter.
    const touched = (await d.touched?.(job.projectKey).catch(() => [])) ?? [];
    const requested = (await d.facts.scanRequests?.(job.projectKey).catch(() => [])) ?? [];
    // Folders of data (transcripts, logs: data.ts) are not listed; the scan says which it left out.
    const fresh = kept ? null : await listCodeFilesWithTotal(job.repoPath, { maxBytes: d.maxBytes, maxFiles: LIST_LIMIT, priority: [...requested, ...touched], comments: true });
    const listed = kept?.listed ?? fresh!.files;
    const dataLeft = fresh?.dataDirs ?? [];
    const dataFiles = dataLeft.reduce((n, x) => n + x.files, 0);
    const signals: ScanSignals = {
      requested, touched, churn: kept?.churn ?? await gitChurn(job.repoPath),
      prPaths: new Set((await d.prPaths?.(job.projectKey).catch(() => [])) ?? []),
      comments: new Map(listed.map((f) => [f.path, f.comments ?? 0])),
    };
    const files = scanOrder(listed, signals);
    const asked = new Set(requested);
    const stored = await d.facts.fileHashes(job.projectKey);
    // A file another scanner version read is due again although its hash is the same (SCANNER_VERSION).
    const versions = await d.facts.fileScanVersions?.(job.projectKey);
    const olderScanner = (f: CodeFile) => !!versions && stored.get(f.path) === f.hash && versions.get(f.path) !== SCANNER_VERSION;
    const outdated = files.filter(olderScanner);
    // Facts from another model are replaced wholesale: unchanged hashes do not mean this model has seen the files.
    const sources = await d.facts.currentSources(job.projectKey);
    const modelChanged = sources.some((s) => s !== d.llm.id);
    // In scan order, so a capped per-file run reads the best files first. A file an agent asked for is due as well.
    const due = files.filter((f) => stored.get(f.path) !== f.hash || olderScanner(f) || asked.has(f.path));
    const changed = modelChanged ? files : due;
    const present = new Set(files.map((f) => f.path));
    const removed = [...stored.keys()].filter((p) => !present.has(p));
    // Asked for but not in the repo (or not worth scanning): nothing to read, so no longer asked for.
    const gone = requested.filter((p) => !present.has(p));
    if (gone.length) await d.facts.clearScanRequests?.(job.projectKey, gone);
    if (resume) d.log?.('scan resumed', { project: job.projectKey, shardsDone: resume.done ?? resume.processed!.length, shards: resume.total, keptPlan: !!kept });
    else await note('scan_started', `scan of ${job.projectKey}: ${plural(changed.length, 'changed file')} of ${files.length}`,
      [
        job.provider ? `you asked for a scan with ${job.provider}` : 'you asked for a scan (default model)',
        ...(modelChanged ? [`every file is rescanned because the current facts came from a different model (${sources.join(', ')})`] : []),
        ...(!modelChanged && outdated.length ? [`${plural(outdated.length, 'file')} ${outdated.length === 1 ? 'was' : 'were'} read by an older scanner and ${outdated.length === 1 ? 'is' : 'are'} read again with ${SCANNER_VERSION}`] : []),
        ...(requested.length - gone.length > 0 ? [`${plural(requested.length - gone.length, 'file')} an agent asked for ${requested.length - gone.length === 1 ? 'is' : 'are'} read first`] : []),
        ...(dataLeft.length ? [`${plural(dataFiles, 'file')} in data folders ${dataFiles === 1 ? 'is' : 'are'} left out: ${dataLeft.slice(0, 5).map((x) => `${x.dir}/ (${x.files})`).join(', ')}${dataLeft.length > 5 ? ', ...' : ''}`] : []),
      ].join('; '), {
        repoPath: job.repoPath, scannerVersion: SCANNER_VERSION, olderScanner: outdated.length, requested: requested.filter((p) => present.has(p)).slice(0, 50),
        ...(dataLeft.length ? { dataDirs: dataLeft.slice(0, 50) } : {}),
      });
    await d.facts.markFilesRemoved(job.projectKey, removed);
    for (const p of removed) await note('facts_extracted', `facts closed for removed file ${p}`, 'the file is no longer in the project', {}, [fileId(p)]);

    const perRun = d.maxFiles ?? DEFAULT_SCAN_FILES;
    let factsAdded = resume ? job.factsAdded : 0;
    let scanned = 0;
    const failed: string[] = [];
    let coverage: ShardCoverage[] | undefined;
    // An agentic scan's totals over all its runs (it may give way to other scans between shards).
    const unreachedAll: string[] = [];
    let totalShards = 0;
    let rescannedAll = 0;
    if (d.llm.agentic) {
      // One agent run per shard (a package or service, shard.ts), each with its own budget; a shard none of whose
      // files changed (or were removed) keeps its facts. Its stored file hashes are its fingerprint: they are written
      // only when its facts are, so a shard that failed is still "changed" next scan.
      const planned = kept?.planned ?? (files.length ? await shardRepo(job.repoPath, files.map((f) => f.path)) : []);
      const rank = new Map(files.map((f, i) => [f.path, i]));
      const hotOf = (p: string) => hotScore(p, signals);
      // Shards holding a file an agent asked for run first, then source before shards of only tests or archives (the
      // attic), then the hottest, then by key.
      const isLow = lowValueRule(files.map((f) => f.path));
      const heat = new Map(planned.map((s) => [s.key, { asked: s.files.some((p) => asked.has(p)), low: s.files.every(isLow), hot: s.files.reduce((m, p) => Math.max(m, hotOf(p)), 0) }]));
      const shards = [...planned].sort((a, b) => Number(heat.get(b.key)!.asked) - Number(heat.get(a.key)!.asked) || Number(heat.get(a.key)!.low) - Number(heat.get(b.key)!.low)
        || heat.get(b.key)!.hot - heat.get(a.key)!.hot || cmpKey(a.key, b.key));
      const byPath = new Map(files.map((f) => [f.path, f]));
      // A shard is redone for a model switch only while its own facts are another model's: one that failed after the
      // switch keeps its old facts, and must not send every later scan through the whole repo again.
      const current = modelChanged && d.facts.listFacts ? await d.facts.listFacts({ projectKey: job.projectKey, limit: 100_000 }) : null;
      const otherModel = current?.filter((f) => !f.docId && f.origin !== 'you' && f.source !== d.llm.id) ?? null;
      const changedPaths = new Set((otherModel ? due : changed).map((f) => f.path));
      const staleModel = (scope: FactScope) => (otherModel ? otherModel.some((f) => inScope(f.path, scope)) : false);
      const read = repoReader(job.repoPath, d.maxBytes);
      const cited = new Set<string>();
      const failedShards: { key: string; err: unknown }[] = [];
      let timeoutsInRow = 0;
      coverage = [];
      // What earlier runs of this job got through: those shards are not run again, and the counts go on from theirs.
      const processed = new Set(resume?.processed ?? []);
      const failedKeys = [...(resume?.failedKeys ?? [])];
      const rescannedBefore = resume?.rescanned ?? 0;
      const citedBefore = resume ? job.filesScanned : 0;
      unreachedAll.push(...(resume?.unreached ?? []));
      // A shard run again for a file asked for since is one shard rescanned, not two.
      const rescannedNow = () => Math.min(shards.length, rescannedBefore + coverage!.filter((x) => !x.skipped).length);
      // A file an agent asked for since this scan got through its shard (those it read were cleared): read now, not
      // at the next scan. A failed shard is not retried for it here.
      const askedAgain = (s: (typeof shards)[number]) => processed.has(s.key) && !failedKeys.includes(s.key) && s.files.some((p) => asked.has(p));
      // After each shard it ran, the job says how far it has got (fg scan --wait and the Projects page read it), and
      // what a run picking it up again needs.
      const progress = () => d.facts.updateScanJob(job.id, {
        factsAdded, filesScanned: citedBefore + cited.size,
        shards: lastShards = {
          total: shards.length, done: shards.filter((s) => processed.has(s.key)).length, rescanned: rescannedNow(), failed: failedKeys.length,
          processed: [...processed], ...(failedKeys.length ? { failedKeys: [...failedKeys] } : {}), ...(unreachedAll.length ? { unreached: unreachedAll.slice(0, JOB_UNREACHED) } : {}),
        },
      });
      const dirtyOf = (s: (typeof shards)[number], scope: FactScope) => [...s.files.filter((p) => changedPaths.has(p) || asked.has(p)), ...removed.filter((p) => inScope(p, scope))];
      // A shard still to run in this scan: not got through yet, and changed or holding another model's facts.
      const toRun = (s: (typeof shards)[number]) => {
        if (processed.has(s.key)) return askedAgain(s);
        const scope = shardScope(s, shards);
        return dirtyOf(s, scope).length > 0 || staleModel(scope);
      };
      /** After a shard: true when another scan waits for the slot and this one has more to run, so it gives way. */
      const giveWay = async () => !!d.yieldTurn && !!d.facts.requeueScanJob && shards.some(toRun) && (await d.yieldTurn().catch(() => false));
      // Gave way to another scan: back in the queue with its progress (saved after the shard), to go on from there.
      const paused = async (): Promise<ScanResult> => {
        // Kept for its next turn; the mirror is not (removed below with the rest of this turn).
        if (head) d.plans!.keep(job.id, { head, repoPath: job.repoPath, listed, churn: signals.churn ?? new Map(), planned });
        await d.facts.requeueScanJob!(job.id);
        const remaining = shards.filter(toRun).length;
        d.log?.('scan gave way to another scan', { project: job.projectKey, shardsDone: shards.filter((x) => processed.has(x.key)).length, shards: shards.length, remaining });
        return { filesScanned: citedBefore + cited.size, factsAdded, failed: failedKeys.length, remaining, shards: coverage, paused: true };
      };
      // Codex explores a filtered copy of the repo: made once for the whole scan (removed at its end), not per shard.
      const agentCwd = async () => (d.llm.mirror ? (mirror ??= await d.llm.mirror(job.repoPath)).dir : job.repoPath);
      // A file an agent asked for in a shard this scan already got through is read on its own (0.6.2 ran the whole
      // shard again: minutes of agent time, and its facts counted twice). Its facts replace the file's, merged with the
      // ones the shard gave it, a fact given again kept and counted once.
      const readAskedFiles = async (s: (typeof shards)[number]) => {
        let added = 0;
        const read: string[] = [];
        for (const p of s.files.filter((x) => asked.has(x))) {
          const f = byPath.get(p)!;
          let content: string;
          let extracted: Awaited<ReturnType<typeof extractFileFacts>>;
          try {
            content = await readFile(join(job.repoPath, p), 'utf8');
            extracted = isInstructionFile(p) ? { summary: '', facts: [] } : await extractFileFacts(d.llm, p, content);
          } catch (err) {
            if (providerUnavailableReason(err)) throw err;
            await note('facts_extracted', `could not read ${p}, which an agent asked for`, redactSecrets(String(err)), { shard: s.key }, [fileId(p)]);
            continue;
          }
          const { kept } = await checkCitations(extracted.facts.map((x) => ({ ...x, origin: 'model' as const })), async (q) => (q === p ? content : undefined));
          const before = ((await d.facts.listFacts?.({ projectKey: job.projectKey, path: p }).catch(() => [])) ?? []).filter((x) => !x.docId && x.origin !== 'you' && x.path === p);
          const known = new Set(before.map(factKey));
          const fresh = [...calibrateRelevance(kept), ...deterministicFacts([{ path: p, content }])].map(checked);
          const seenNow = new Set<string>();
          const newOnes = fresh.filter((x) => !known.has(factKey(x)) && !seenNow.has(factKey(x)) && !!seenNow.add(factKey(x)));
          const earlier: CodeFact[] = before.map((x) => ({
            kind: x.kind, statement: x.statement, path: x.path, lines: x.lines, confidence: x.confidence, why: x.why, relevance: x.relevance,
            ...(x.origin ? { origin: x.origin } : {}), ...(x.evidence ? { evidence: x.evidence } : {}), checkVersion: x.checkVersion ?? null,
          }));
          await d.facts.saveFileFacts(job.projectKey, { path: p, hash: f.hash, summary: extracted.summary, version: SCANNER_VERSION }, await embedFacts([...earlier, ...newOnes], d.embed), d.llm.id, job.id);
          added += newOnes.length;
          cited.add(p);
          read.push(p);
          await note('facts_extracted', `${plural(newOnes.length, 'new fact')} from ${p}`,
            `an agent asked for this file after this scan got through ${s.key}: the file was read on its own instead of the whole shard again; ${plural(fresh.length - newOnes.length, 'fact')} it gave again ${fresh.length - newOnes.length === 1 ? 'was' : 'were'} kept once`,
            { shard: s.key, facts: factLog(newOnes), restated: fresh.length - newOnes.length }, [fileId(p)]);
        }
        if (read.length) await d.facts.clearScanRequests?.(job.projectKey, read);
        factsAdded += added;
        // Tried once this run, read or not (one that failed stays asked for, for the next scan).
        for (const p of s.files) asked.delete(p);
        await progress();
      };
      for (const s of shards) {
        if (processed.has(s.key)) {
          if (askedAgain(s)) await readAskedFiles(s);
          continue;
        }
        const scope = shardScope(s, shards);
        const ordered = [...s.files].sort((a, b) => rank.get(a)! - rank.get(b)!);
        const hot = ordered.filter((p) => asked.has(p) || hotOf(p) > 0);
        const shard: ShardTask = { key: s.key, roots: s.roots, scope, files: ordered.map((p) => byPath.get(p)!), hot, lowValue: isLow };
        const dirty = dirtyOf(s, scope);
        if (!dirty.length && !staleModel(scope)) {
          coverage.push({ shard: s.key, files: s.files.length, facts: 0, skipped: true });
          processed.add(s.key);
          continue;
        }
        let raw: CodeFact[];
        let unreached: string[];
        let hidden: ShardHidden = { lowValue: 0, overBudget: 0 };
        let toppedUp = false;
        try {
          ({ facts: raw, unreached, hidden, toppedUp } = await extractShardFacts(d.llm, await agentCwd(), shard, { log: d.log }));
          timeoutsInRow = 0;
        } catch (err) {
          // The model could not be asked: every other shard would fail the same way, so the whole scan waits
          // (shards saved so far are not redone: their hashes match now).
          if (providerUnavailableReason(err)) throw err;
          const timeout = modelTimeoutReason(err);
          timeoutsInRow = timeout ? timeoutsInRow + 1 : 0;
          if (timeout && timeoutsInRow >= MAX_TIMEOUTS_IN_ROW) throw new Error(`${MAX_TIMEOUTS_IN_ROW} shards in a row timed out (last: ${s.key}): ${timeout}`);
          // Not saved, so its hashes stay stale and the next scan tries it again; the other shards go on.
          failedShards.push({ key: s.key, err });
          failedKeys.push(s.key);
          processed.add(s.key);
          coverage.push({ shard: s.key, files: s.files.length, facts: 0, skipped: false, failed: redactSecrets(String(err)) });
          await note('facts_extracted', `could not extract facts from ${s.key}`, redactSecrets(String(err)), { shard: s.key }, [fileId(s.roots[0] || '.')]);
          await progress();
          if (await giveWay()) return await paused();
          continue;
        }
        const { inside, outside } = inShard(raw, shard);
        // The shard's own directory is not a file to check: those facts are about the shard as a whole.
        const own = inside.filter((f) => f.path !== '.' && s.roots.includes(f.path));
        const { kept, dropped } = await checkCitations(inside.filter((f) => !own.includes(f)), read);
        const model = [...kept, ...own.map((f) => ({ ...f, evidence: 'none' as const }))];
        // What the model cited is what it read (as far as anyone can tell); the list it was shown is not coverage.
        for (const f of kept) if (f.path !== '.') cited.add(f.path);
        // Only manifests feed the deterministic facts; a file gone since listing is simply skipped.
        const contents = (await Promise.all(
          shard.files.filter((f) => isManifest(f.path)).map(async (f) => {
            const content = await readFile(join(job.repoPath, f.path), 'utf8').catch(() => null);
            return content === null ? null : { path: f.path, content };
          }),
        )).filter((c): c is { path: string; content: string } => c !== null);
        const facts = [...calibrateRelevance(model), ...deterministicFacts(contents)].map(checked);
        await d.facts.replaceScopeFacts(job.projectKey, scope, await embedFacts(facts, d.embed), d.llm.id, shard.files.map((f) => ({ path: f.path, hash: f.hash, version: SCANNER_VERSION })), job.id);
        factsAdded += facts.length;
        coverage.push({ shard: s.key, files: s.files.length, facts: facts.length, skipped: false, ...(unreached.length ? { unreached } : {}) });
        processed.add(s.key);
        unreachedAll.push(...unreached);
        const readAsked = s.files.filter((p) => asked.has(p));
        if (readAsked.length) await d.facts.clearScanRequests?.(job.projectKey, readAsked);
        await progress();
        const droppedWhy = [
          dropped.length ? `${plural(dropped.length, 'fact')} dropped for citing a file that does not exist or an instruction file (AGENTS.md, CLAUDE.md)` : '',
          outside.length ? `${plural(outside.length, 'fact')} dropped for citing a file outside this shard` : '',
          unreached.length ? `the agent did not reach ${unreached.length}: ${unreached.slice(0, 10).join(', ')}${unreached.length > 10 ? ', ...' : ''}` : '',
          toppedUp ? 'its first answer was under the fact floor, so it was asked once more for the directories short of facts' : '',
          hidden.lowValue ? `${plural(hidden.lowValue, 'fact')} about tests, fixtures or archived files cut (they get a small share of the budget)` : '',
          hidden.overBudget ? `${plural(hidden.overBudget, 'fact')} past the budget of this shard cut, least relevant first` : '',
        ].filter(Boolean).map((x) => `; ${x}`).join('');
        const where = shards.length === 1 ? 'the whole repository' : s.key;
        await note('facts_extracted', `${plural(facts.length, 'fact')} from ${where}`,
          `${plural(dirty.length, 'file')} changed, removed or asked for; ${d.llm.id} explored ${where} with read-only tools and replaced its earlier facts there${droppedWhy}`,
          { shard: s.key, facts: factLog(facts), ...(dropped.length || outside.length ? { dropped: factLog([...dropped, ...outside]) } : {}), changedFiles: dirty, ...(unreached.length ? { unreached } : {}),
            ...(hidden.lowValue || hidden.overBudget ? { cut: hidden } : {}), ...(toppedUp ? { toppedUp } : {}) },
          [...new Set(facts.map((f) => fileId(f.path || '.')))]);
        d.log?.('scanned shard', { project: job.projectKey, shard: s.key, files: s.files.length, facts: facts.length, unreached: unreached.length });
        if (await giveWay()) return await paused();
      }
      scanned = citedBefore + cited.size;
      failed.push(...failedKeys);
      totalShards = shards.length;
      rescannedAll = rescannedNow();
      // Every shard that was tried failed: the run fails as a counted attempt, like a whole-repo scan that failed.
      if (rescannedAll && failedKeys.length === rescannedAll) {
        const last = failedShards.at(-1);
        if (rescannedAll === 1 && last) throw last.err;
        throw new Error(`all ${rescannedAll} shards failed (last: ${failedKeys.at(-1)}): ${last ? String(last.err) : 'see the earlier runs'}`);
      }
    } else {
      let done = 0;
      let timeoutsInRow = 0;
      // The cap bounds one run's model calls; the rest stay changed and are picked up next scan.
      for (const f of changed.slice(0, perRun)) {
        let content: string;
        let extracted: Awaited<ReturnType<typeof extractFileFacts>>;
        try {
          content = await readFile(join(job.repoPath, f.path), 'utf8'); // may be gone since listing
          // Agents read their instruction files themselves: no model call, but the file counts as scanned.
          extracted = isInstructionFile(f.path) ? { summary: '', facts: [] } : await extractFileFacts(d.llm, f.path, content);
          timeoutsInRow = 0;
        } catch (err) {
          // The model could not be asked: every other file would fail the same way, so the whole scan waits.
          if (providerUnavailableReason(err)) throw err;
          // A timeout is that file's failure, but a model timing out on file after file is stuck: the run fails as a
          // counted attempt (files saved so far stay) rather than waiting out the timeout on every remaining file.
          const timeout = modelTimeoutReason(err);
          timeoutsInRow = timeout ? timeoutsInRow + 1 : 0;
          if (timeout && timeoutsInRow >= MAX_TIMEOUTS_IN_ROW) throw new Error(`${MAX_TIMEOUTS_IN_ROW} files in a row timed out (last: ${f.path}): ${timeout}`);
          // Not saved, so its hash stays stale and the next scan tries it again.
          failed.push(f.path);
          await note('facts_extracted', `could not extract facts from ${f.path}`, String(err), { hash: f.hash }, [fileId(f.path)]);
          continue;
        }
        const { summary } = extracted;
        const { kept } = await checkCitations(extracted.facts.map((x) => ({ ...x, origin: 'model' as const })), async (p) => (p === f.path ? content : undefined));
        const all = [...calibrateRelevance(kept), ...deterministicFacts([{ path: f.path, content }])].map(checked);
        await d.facts.saveFileFacts(job.projectKey, { path: f.path, hash: f.hash, summary, version: SCANNER_VERSION }, await embedFacts(all, d.embed), d.llm.id, job.id);
        factsAdded += all.length;
        if (asked.has(f.path)) await d.facts.clearScanRequests?.(job.projectKey, [f.path]);
        const previousHash = stored.get(f.path) ?? null;
        await note('facts_extracted', `${plural(all.length, 'fact')} from ${f.path}`,
          previousHash ? `the file changed since the last scan (${previousHash.slice(0, 7)} → ${f.hash.slice(0, 7)})` : 'new file, never scanned before',
          { hash: f.hash, previousHash, summary, facts: factLog(all) }, [fileId(f.path)]);
        done++;
        if (done % 10 === 0) await d.facts.updateScanJob(job.id, { filesScanned: done, factsAdded });
        d.log?.('scanned file', { project: job.projectKey, path: f.path, facts: all.length });
      }
    }
    if (!d.llm.agentic) scanned = Math.min(changed.length, perRun) - failed.length;
    const result: ScanResult = {
      filesScanned: scanned, factsAdded, failed: failed.length, remaining: d.llm.agentic ? 0 : Math.max(0, changed.length - perRun),
      ...(coverage?.length ? { shards: coverage } : {}),
    };
    const unreached = unreachedAll;
    const shards = totalShards
      ? { total: totalShards, rescanned: rescannedAll, failed: failed.length, ...(unreached.length ? { unreached: unreached.slice(0, JOB_UNREACHED) } : {}) }
      : null;
    const unit = d.llm.agentic ? 'shard' : 'file';
    await d.facts.updateScanJob(job.id, {
      status: 'done', filesScanned: result.filesScanned, factsAdded,
      ...(failed.length ? { error: `${plural(failed.length, unit)} failed: ${failed.slice(0, 10).join(', ')}` } : {}),
      ...(shards ? { shards } : {}),
    });
    const left = result.remaining ? `; ${plural(result.remaining, 'changed file')} left for the next scan (SCAN_MAX_FILES)` : '';
    const shardLine = shards ? `; ${shards.rescanned} of ${plural(shards.total, 'shard')} rescanned${unreached.length ? `, ${plural(unreached.length, 'place')} not reached` : ''}` : '';
    await note('scan_finished', `scanned ${plural(result.filesScanned, 'file')}, ${plural(factsAdded, 'fact')}${shardLine}${left}`,
      failed.length ? `scan completed; ${failed.length} failed and will be retried next scan` : 'scan completed', result);
    return result;
  } catch (err) {
    const unavailable = providerUnavailableReason(err);
    if (unavailable) {
      // Not the job's fault: it goes back in the queue (files already saved are not redone) without counting an
      // attempt, and waits a little before asking the model again, so an outage costs one call every few minutes.
      const next = await d.facts.recordScanFailure(job.id, `model unavailable: ${unavailable}; the scan runs again once it answers`, { counted: false });
      d.log?.('scan waiting for its model', { project: job.projectKey, retryAt: next.retryAt });
      throw err instanceof ProviderUnavailableError ? err : new ProviderUnavailableError(unavailable);
    }
    // A real failure counts: retried after a backoff, failed for good after MAX_SCAN_ATTEMPTS. The retry starts the
    // shards afresh (those saved are skipped by their hashes), so the ones that failed are tried again; the counts stay.
    if (lastShards?.processed) {
      const { processed: _p, failedKeys: _f, ...counts } = lastShards;
      await d.facts.updateScanJob(job.id, { shards: counts });
    }
    const error = redactSecrets(String(err));
    const next = await d.facts.recordScanFailure(job.id, error, { counted: true });
    await note('scan_finished', `scan failed (attempt ${next.attempts}); ${next.retryAt ? `retrying at ${next.retryAt}` : 'gave up, request a new scan to try again'}`,
      error, { attempts: next.attempts, retryAt: next.retryAt });
    throw err;
  } finally {
    await (mirror as AgentMirror | null)?.dispose().catch(() => {});
  }
}
