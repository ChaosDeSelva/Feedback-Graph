import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GIT_SAFE } from '../ingest/git.ts';
import { extract } from '../codegraph/extract.ts';
import { langOf } from '../codegraph/lang.ts';
import { chunkBySymbols, type Chunk } from './chunk.ts';
import { mapCap, rankCodePaths } from './rank.ts';
import { inScope, shardBudget, shardRepo, shardScope } from './shard.ts';
import { askJson, clampRelevance, FACT_KINDS, isSecretPath, modelTimeoutReason, ProviderUnavailableError, providerUnavailableReason, redactSecrets, type ActivityStore, type CodeFact, type FactScope, type FactsStore, type LlmProvider, type ScanJob } from '@fb/core';

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
/** Bump when the extraction prompts change, so the log says which prompt produced a fact. */
export const SCAN_PROMPT_VERSION = 'scan-v4';
const MAX_FILE_CHARS = 24_000;
/** Files in a row whose model call timed out before a per-file scan gives up on this run. */
const MAX_TIMEOUTS_IN_ROW = 3;

export type CodeFile = { path: string; hash: string; size: number };

const wanted = (path: string) => {
  const name = path.split('/').pop()!;
  if (LOCKFILES.has(name) || name.endsWith('.min.js') || SECRET_FILE.test(path)) return false;
  if (path.split('/').some((seg) => SKIP_DIRS.has(seg))) return false;
  return CODE_NAMES.has(name) || CODE_EXT.has(extname(name));
};

async function gitFiles(repoPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'ls-files', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
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

export type ListOpts = { maxBytes: number; maxFiles: number | null; priority?: Iterable<string> };

/**
 * Source, docs and config worth reading; respects .gitignore when the dir is a git repo. Candidates are ranked before
 * the cap (rank.ts), so a capped list keeps source over config and docs, and `priority` paths (files sessions edited)
 * before anything. maxFiles null: the cap scales with the repo (mapCap). totalCandidates: how many files were worth
 * listing before the cap, so a capped map can say what it left out.
 */
export async function listCodeFilesWithTotal(repoPath: string, o: ListOpts): Promise<{ files: CodeFile[]; totalCandidates: number; cap: number }> {
  const candidates = ((await gitFiles(repoPath)) ?? (await walk(repoPath))).filter(wanted);
  const cap = mapCap(o.maxFiles, candidates.length);
  const files: CodeFile[] = [];
  for (const path of rankCodePaths(candidates, { priority: o.priority })) {
    if (files.length >= cap) break;
    const s = await lstat(join(repoPath, path)).catch(() => null); // a symlink could point at a secret or outside the repo
    if (!s?.isFile() || s.size > o.maxBytes) continue;
    const content = await readFile(join(repoPath, path));
    files.push({ path, size: s.size, hash: createHash('sha1').update(content).digest('hex') });
  }
  return { files, totalCandidates: candidates.length, cap };
}

/** The files a scan or a map would consider, before ranking and the cap (repo-relative paths). */
export async function candidatePaths(repoPath: string): Promise<string[]> {
  return ((await gitFiles(repoPath)) ?? (await walk(repoPath))).filter(wanted);
}

/** Whether the folder has any file worth scanning (a scan of one without finishes at once, with no model call). */
export async function hasCodeFiles(repoPath: string): Promise<boolean> {
  return ((await gitFiles(repoPath)) ?? (await walk(repoPath))).some(wanted);
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

/** Facts we can read without a model, from the manifests (isManifest): scripts, targets, dependencies, services, env keys. */
export function deterministicFacts(files: { path: string; content: string }[]): CodeFact[] {
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

/** A cited range checked against the file: kept (clamped to its end) when it holds what the statement names. */
function checkLines(f: CodeFact, content: string): Pick<CodeFact, 'lines' | 'evidence'> {
  const r = parseRange(f.lines);
  if (!r) return { lines: null, evidence: 'file' };
  const all = content.split('\n');
  const count = all.length - (content.endsWith('\n') ? 1 : 0);
  if (r.start > count) return { lines: null, evidence: 'file' };
  const end = Math.min(r.end, count);
  const ids = identifiersIn(f.statement);
  const window = all.slice(Math.max(0, r.start - 1 - LINE_SLACK), end + LINE_SLACK).join('\n');
  if (ids.length && !ids.some((id) => mentions(window, id))) return { lines: null, evidence: 'file' };
  return { lines: r.start === end ? `${r.start}` : `${r.start}-${end}`, evidence: 'line' };
}

/**
 * Check what a model cited before its facts are saved. `read`: a repo file's text, null when it exists but is not read
 * (too large, a secret, not a regular file), undefined when it does not exist. A fact citing a missing file or an
 * instruction file (isInstructionFile) is dropped; lines past the end of the file, or that do not hold what the
 * statement names, are dropped from the fact; each kept fact gets its evidence level.
 */
export async function checkCitations(facts: CodeFact[], read: (path: string) => Promise<string | null | undefined>): Promise<{ kept: CodeFact[]; dropped: CodeFact[] }> {
  const kept: CodeFact[] = [];
  const dropped: CodeFact[] = [];
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
function repoReader(repoPath: string, maxBytes: number) {
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
  confidence: z.number().min(0).max(1),
  why: z.string().default(''),
  // Older or smaller models leave it out: the fact is kept unscored and the background scorer scores it later.
  relevance: z.number().nullable().optional().transform((r) => (typeof r === 'number' ? clampRelevance(r) : null)),
});

export const FACT_JSON = {
  type: 'object',
  required: ['kind', 'statement', 'path', 'lines', 'confidence', 'why', 'relevance'],
  properties: {
    kind: { type: 'string', enum: [...FACT_KINDS] },
    statement: { type: 'string', description: 'One self-contained sentence a coding agent can act on' },
    path: { type: 'string', description: "Repo-relative file path, or '.' for the whole project" },
    lines: { type: ['string', 'null'], description: 'e.g. "12-30", or null' },
    confidence: { type: 'number', description: '0..1' },
    why: { type: 'string', description: 'One short sentence: why an agent changing this code needs to know this' },
    relevance: { type: 'number', description: '0..1: how often an agent doing everyday coding here needs this (see the rubric)' },
  },
};

/** Shared with the background scorer and the docs reader, so every fact is scored on one scale. */
export const RELEVANCE_RUBRIC = `Give every fact a relevance from 0 to 1: how often an agent doing everyday coding in this project needs it.
- 0.8 to 1: needed in most changes (core conventions, invariants, the data model, auth and security rules, how modules fit together).
- 0.4 to 0.7: needed for some changes (one module's API, a config option, a gotcha in one area).
- 0 to 0.3: rarely needed while coding (installing, setting up or configuring an external tool, CI or deploy steps, editor or machine setup, history).`;

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
    facts.push(...r.facts.filter((f) => f.confidence >= MIN_CONFIDENCE).slice(0, 10).map((f) => clean({ ...f, path })));
  }
  return { summary: redactSecrets(summary), facts };
}

const AgenticResult = z.object({ facts: z.array(FactSchema).max(120) });

/** What one agent run is about: a shard of the repo (shard.ts), its files, and the paths its facts may cite. */
export type ShardTask = { key: string; roots: string[]; scope: FactScope; files: CodeFile[] };

/**
 * One agent run over one shard: the agent works in the whole repo (read-only) but is shown the shard's files and
 * asked for facts about them only, within a budget scaled to the shard (shardBudget). Facts about the shard as a
 * whole cite its directory ('.' for the shard holding the rest of the repo). Nothing is filtered here: runScan drops
 * facts outside the shard and checks citations before anything is saved.
 */
export async function extractShardFacts(llm: LlmProvider, repoPath: string, shard: ShardTask): Promise<CodeFact[]> {
  const budget = shardBudget(shard.files.length);
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
  // Agents sometimes answer with prose around (or instead of) the object: asked once more, strictly, before it counts.
  const r = await askJson(llm, {
    system: `${intro} ${WHAT_TO_KEEP}
Return ${Math.ceil(budget / 3)} to ${budget} facts. Every fact must cite the file it comes from (repo-relative)${whole ? '' : ', from the list'}, or '${wide}' for facts about ${whole ? 'the whole project' : 'this part as a whole'}.`,
    user: `SHARD: ${shard.key}\nFiles in ${whole ? 'the repository' : 'this part'}:\n${shard.files.map((f) => f.path).join('\n')}`,
    schema: { type: 'object', required: ['facts'], properties: { facts: { type: 'array', items: FACT_JSON } } },
    cwd: repoPath,
    timeoutMs: 30 * 60_000,
  }, (raw) => AgenticResult.parse(raw));
  return r.facts.filter((f) => f.confidence >= MIN_CONFIDENCE).map((f) => ({ ...f, origin: 'model' as const }));
}

/** One shard in a scan's result: its files, the facts saved for it, whether it was skipped (unchanged) or failed. */
export type ShardCoverage = { shard: string; files: number; facts: number; skipped: boolean; failed?: string };

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
  /** listFacts (optional): after a model switch, which shards still hold the other model's facts (others are skipped). */
  facts: Pick<FactsStore, 'fileHashes' | 'saveFileFacts' | 'markFilesRemoved' | 'replaceScopeFacts' | 'updateScanJob' | 'currentSources' | 'recordScanFailure'> & Partial<Pick<FactsStore, 'listFacts'>>;
  llm: LlmProvider;
  embed(texts: string[]): Promise<number[][]>;
  maxBytes: number;
  /** SCAN_MAX_FILES: changed files read per run (per-file models); null (unset): DEFAULT_SCAN_FILES. */
  maxFiles: number | null;
  /** Files the project's sessions edited, most recent first: listed (and so scanned) before the rest. */
  touched?: (projectKey: string) => Promise<string[]>;
  log?: (msg: string, extra?: object) => void;
  activity?: Pick<ActivityStore, 'record'>;
};

/** Changed files a per-file scan reads per run when SCAN_MAX_FILES is unset; the rest wait for the next scan. */
export const DEFAULT_SCAN_FILES = 400;

const embedFacts = async (facts: CodeFact[], embed: ScanDeps['embed']) => {
  if (!facts.length) return [];
  const vectors = await embed(facts.map((f) => `${f.path}: ${f.statement}`));
  return facts.map((f, i) => ({ ...f, embedding: vectors[i] }));
};

/** Incremental scan: only files whose hash changed are (re)analysed; removed files have their facts closed. */
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const factLog = (facts: CodeFact[]) => facts.map((f) => ({ kind: f.kind, statement: f.statement, why: f.why, confidence: f.confidence, ...(f.evidence ? { evidence: f.evidence } : {}) }));

/** failed: files (per-file scans) or shards (agentic scans) that failed. shards: an agentic scan's coverage per shard. */
export type ScanResult = { filesScanned: number; factsAdded: number; failed: number; remaining: number; shards?: ShardCoverage[] };

/** Upper bound on files listed per project, so a giant tree cannot exhaust memory. */
const LIST_LIMIT = 20_000;

export async function runScan(job: ScanJob, d: ScanDeps): Promise<ScanResult> {
  const note = (kind: 'scan_started' | 'facts_extracted' | 'scan_finished', subject: string, why: string, details: Record<string, unknown> = {}, targets: string[] = []) =>
    d.activity?.record({ kind, actor: d.llm.id, projectKey: job.projectKey, subject, why, details: { scanJobId: job.id, promptVersion: SCAN_PROMPT_VERSION, ...details }, targets });
  const fileId = (path: string) => `${job.projectKey}:${path}`;
  await d.facts.updateScanJob(job.id, { status: 'running' });
  try {
    // List everything, so files beyond the per-run cap are never mistaken for removed ones.
    // Ranked (rank.ts), so a capped run reads the files sessions edited and the source first.
    const touched = await d.touched?.(job.projectKey).catch(() => []);
    const files = await listCodeFiles(job.repoPath, { maxBytes: d.maxBytes, maxFiles: LIST_LIMIT, priority: touched });
    const stored = await d.facts.fileHashes(job.projectKey);
    // Facts from another model are replaced wholesale: unchanged hashes do not mean this model has seen the files.
    const sources = await d.facts.currentSources(job.projectKey);
    const modelChanged = sources.some((s) => s !== d.llm.id);
    const changed = modelChanged ? files : files.filter((f) => stored.get(f.path) !== f.hash);
    const present = new Set(files.map((f) => f.path));
    const removed = [...stored.keys()].filter((p) => !present.has(p));
    await note('scan_started', `scan of ${job.projectKey}: ${plural(changed.length, 'changed file')} of ${files.length}`,
      [
        job.provider ? `you asked for a scan with ${job.provider}` : 'you asked for a scan (default model)',
        ...(modelChanged ? [`every file is rescanned because the current facts came from a different model (${sources.join(', ')})`] : []),
      ].join('; '), { repoPath: job.repoPath });
    await d.facts.markFilesRemoved(job.projectKey, removed);
    for (const p of removed) await note('facts_extracted', `facts closed for removed file ${p}`, 'the file is no longer in the project', {}, [fileId(p)]);

    const perRun = d.maxFiles ?? DEFAULT_SCAN_FILES;
    let factsAdded = 0;
    let scanned = 0;
    const failed: string[] = [];
    let coverage: ShardCoverage[] | undefined;
    if (d.llm.agentic) {
      // One agent run per shard (a package or service, shard.ts), each with its own budget; a shard none of whose
      // files changed (or were removed) keeps its facts. Its stored file hashes are its fingerprint: they are written
      // only when its facts are, so a shard that failed is still "changed" next scan.
      const shards = files.length ? await shardRepo(job.repoPath, files.map((f) => f.path)) : [];
      const byPath = new Map(files.map((f) => [f.path, f]));
      // A shard is redone for a model switch only while its own facts are another model's: one that failed after the
      // switch keeps its old facts, and must not send every later scan through the whole repo again.
      const current = modelChanged && d.facts.listFacts ? await d.facts.listFacts({ projectKey: job.projectKey, limit: 100_000 }) : null;
      const otherModel = current?.filter((f) => !f.docId && f.origin !== 'you' && f.source !== d.llm.id) ?? null;
      const hashChanged = files.filter((f) => stored.get(f.path) !== f.hash);
      const changedPaths = new Set((otherModel ? hashChanged : changed).map((f) => f.path));
      const staleModel = (scope: FactScope) => (otherModel ? otherModel.some((f) => inScope(f.path, scope)) : false);
      const read = repoReader(job.repoPath, d.maxBytes);
      const cited = new Set<string>();
      const failedShards: { key: string; err: unknown }[] = [];
      let timeoutsInRow = 0;
      coverage = [];
      for (const s of shards) {
        const scope = shardScope(s, shards);
        const shard: ShardTask = { key: s.key, roots: s.roots, scope, files: s.files.map((p) => byPath.get(p)!) };
        const dirty = [...s.files.filter((p) => changedPaths.has(p)), ...removed.filter((p) => inScope(p, scope))];
        if (!dirty.length && !staleModel(scope)) {
          coverage.push({ shard: s.key, files: s.files.length, facts: 0, skipped: true });
          continue;
        }
        let raw: CodeFact[];
        try {
          raw = await extractShardFacts(d.llm, job.repoPath, shard);
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
          coverage.push({ shard: s.key, files: s.files.length, facts: 0, skipped: false, failed: redactSecrets(String(err)) });
          await note('facts_extracted', `could not extract facts from ${s.key}`, redactSecrets(String(err)), { shard: s.key }, [fileId(s.roots[0] || '.')]);
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
        const facts = [...model, ...deterministicFacts(contents)];
        await d.facts.replaceScopeFacts(job.projectKey, scope, await embedFacts(facts, d.embed), d.llm.id, shard.files, job.id);
        factsAdded += facts.length;
        coverage.push({ shard: s.key, files: s.files.length, facts: facts.length, skipped: false });
        const droppedWhy = [
          dropped.length ? `${plural(dropped.length, 'fact')} dropped for citing a file that does not exist or an instruction file (AGENTS.md, CLAUDE.md)` : '',
          outside.length ? `${plural(outside.length, 'fact')} dropped for citing a file outside this shard` : '',
        ].filter(Boolean).map((x) => `; ${x}`).join('');
        const where = shards.length === 1 ? 'the whole repository' : s.key;
        await note('facts_extracted', `${plural(facts.length, 'fact')} from ${where}`,
          `${plural(dirty.length, 'file')} changed or removed; ${d.llm.id} explored ${where} with read-only tools and replaced its earlier facts there${droppedWhy}`,
          { shard: s.key, facts: factLog(facts), ...(dropped.length || outside.length ? { dropped: factLog([...dropped, ...outside]) } : {}), changedFiles: dirty },
          [...new Set(facts.map((f) => fileId(f.path || '.')))]);
        d.log?.('scanned shard', { project: job.projectKey, shard: s.key, files: s.files.length, facts: facts.length });
      }
      scanned = cited.size;
      failed.push(...failedShards.map((x) => x.key));
      const rescanned = coverage.filter((c) => !c.skipped).length;
      // Every shard that was tried failed: the run fails as a counted attempt, like a whole-repo scan that failed.
      if (rescanned && failedShards.length === rescanned) {
        const last = failedShards.at(-1)!;
        throw rescanned === 1 ? last.err : new Error(`all ${rescanned} shards failed (last: ${last.key}): ${String(last.err)}`);
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
        const all = [...kept, ...deterministicFacts([{ path: f.path, content }])];
        await d.facts.saveFileFacts(job.projectKey, { path: f.path, hash: f.hash, summary }, await embedFacts(all, d.embed), d.llm.id, job.id);
        factsAdded += all.length;
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
    const shards = coverage?.length ? { total: coverage.length, rescanned: coverage.filter((c) => !c.skipped).length, failed: failed.length } : null;
    const unit = d.llm.agentic ? 'shard' : 'file';
    await d.facts.updateScanJob(job.id, {
      status: 'done', filesScanned: result.filesScanned, factsAdded,
      ...(failed.length ? { error: `${plural(failed.length, unit)} failed: ${failed.slice(0, 10).join(', ')}` } : {}),
      ...(shards ? { shards } : {}),
    });
    const left = result.remaining ? `; ${plural(result.remaining, 'changed file')} left for the next scan (SCAN_MAX_FILES)` : '';
    const shardLine = shards ? `; ${shards.rescanned} of ${plural(shards.total, 'shard')} rescanned` : '';
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
    // A real failure counts: retried after a backoff, failed for good after MAX_SCAN_ATTEMPTS.
    const error = redactSecrets(String(err));
    const next = await d.facts.recordScanFailure(job.id, error, { counted: true });
    await note('scan_finished', `scan failed (attempt ${next.attempts}); ${next.retryAt ? `retrying at ${next.retryAt}` : 'gave up, request a new scan to try again'}`,
      error, { attempts: next.attempts, retryAt: next.retryAt });
    throw err;
  }
}
