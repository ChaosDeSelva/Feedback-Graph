import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GIT_SAFE } from '../ingest/git.ts';
import { askPromptOnly, FACT_KINDS, isSecretPath, ProviderUnavailableError, providerUnavailableReason, redactSecrets, type ActivityStore, type CodeFact, type FactsStore, type LlmProvider, type ScanJob } from '@fb/core';

const run = promisify(execFile);

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.cs', '.cpp', '.c', '.h',
  '.lua', '.gd', '.php', '.sql', '.graphql', '.proto', '.vue', '.svelte', '.css', '.scss', '.html', '.md', '.mdx', '.json',
  '.yaml', '.yml', '.toml', '.sh', '.tf', '.prisma',
]);
// project.godot marks where a Godot project's res:// starts (codegraph resolves GDScript paths against it).
const CODE_NAMES = new Set(['Dockerfile', 'Makefile', '.gitignore', '.env.example', 'project.godot']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage', 'vendor', '.venv', '__pycache__', 'target', '.turbo', '.cache']);
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock']);
/** Files that hold credentials are never read, whatever their extension (the list lives in core). */
const SECRET_FILE = { test: isSecretPath };
const MIN_CONFIDENCE = 0.5;
/** Bump when the extraction prompts change, so the log says which prompt produced a fact. */
export const SCAN_PROMPT_VERSION = 'scan-v2';
const DETERMINISTIC_WHY = 'Read directly from package.json; no model involved.';
const MAX_FILE_CHARS = 24_000;

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

/** Source, docs and config worth reading; respects .gitignore when the dir is a git repo. */
export async function listCodeFiles(repoPath: string, o: { maxBytes: number; maxFiles: number }): Promise<CodeFile[]> {
  const paths = ((await gitFiles(repoPath)) ?? (await walk(repoPath))).filter(wanted).sort();
  const files: CodeFile[] = [];
  for (const path of paths) {
    if (files.length >= o.maxFiles) break;
    const s = await lstat(join(repoPath, path)).catch(() => null); // a symlink could point at a secret or outside the repo
    if (!s?.isFile() || s.size > o.maxBytes) continue;
    const content = await readFile(join(repoPath, path));
    files.push({ path, size: s.size, hash: createHash('sha1').update(content).digest('hex') });
  }
  return files;
}

/** Facts we can read without a model: package.json scripts and dependencies. */
export function deterministicFacts(files: { path: string; content: string }[]): CodeFact[] {
  const facts: CodeFact[] = [];
  for (const f of files.filter((f) => f.path === 'package.json' || f.path.endsWith('/package.json'))) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(f.content);
    } catch {
      continue;
    }
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      facts.push({ kind: 'command', statement: `\`${name}\` script runs: ${cmd}`, path: f.path, lines: null, confidence: 1, why: DETERMINISTIC_WHY });
    }
    const list = (d?: Record<string, string>) => Object.entries(d ?? {}).map(([n, v]) => `${n} ${v}`).join(', ');
    const deps = list(pkg.dependencies);
    const dev = list(pkg.devDependencies);
    if (deps || dev) {
      facts.push({
        kind: 'dependency',
        statement: [deps && `Dependencies: ${deps}.`, dev && `Dev dependencies: ${dev}.`].filter(Boolean).join(' '),
        path: f.path,
        lines: null,
        confidence: 1,
        why: DETERMINISTIC_WHY,
      });
    }
  }
  return facts;
}

const FactSchema = z.object({
  kind: z.enum(FACT_KINDS),
  statement: z.string().min(1),
  path: z.string(),
  lines: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  why: z.string().default(''),
});

const FACT_JSON = {
  type: 'object',
  required: ['kind', 'statement', 'path', 'lines', 'confidence', 'why'],
  properties: {
    kind: { type: 'string', enum: [...FACT_KINDS] },
    statement: { type: 'string', description: 'One self-contained sentence a coding agent can act on' },
    path: { type: 'string', description: "Repo-relative file path, or '.' for the whole project" },
    lines: { type: ['string', 'null'], description: 'e.g. "12-30", or null' },
    confidence: { type: 'number', description: '0..1' },
    why: { type: 'string', description: 'One short sentence: why an agent changing this code needs to know this' },
  },
};

const WHAT_TO_KEEP = `Extract durable, non-obvious facts a coding agent would need to change this code correctly:
conventions and patterns to follow, invariants and assumptions, public APIs and their contracts, data models,
config and environment, security/auth rules, gotchas and side effects, and the overall architecture.
Skip anything trivial or obvious from a file name. Prefer fewer, higher-value facts. Never include secrets.`;

const FileResult = z.object({ summary: z.string(), facts: z.array(FactSchema).max(15) });

export async function extractFileFacts(llm: LlmProvider, path: string, content: string): Promise<{ summary: string; facts: CodeFact[] }> {
  // The file's text is the whole input: an agentic model gets an empty folder, not the worker's.
  const raw = await askPromptOnly(llm, {
    system: `You analyse one source file from a codebase. ${WHAT_TO_KEEP} At most 10 facts.`,
    user: `FILE: ${path}\n\n${redactSecrets(content.slice(0, MAX_FILE_CHARS))}`,
    schema: {
      type: 'object',
      required: ['summary', 'facts'],
      properties: { summary: { type: 'string', description: 'One sentence: what this file is for' }, facts: { type: 'array', items: FACT_JSON } },
    },
    timeoutMs: 180_000,
  });
  const r = FileResult.parse(raw);
  const clean = (f: CodeFact) => ({ ...f, statement: redactSecrets(f.statement), why: redactSecrets(f.why) });
  return { summary: redactSecrets(r.summary), facts: r.facts.filter((f) => f.confidence >= MIN_CONFIDENCE).slice(0, 10).map((f) => clean({ ...f, path })) };
}

const AgenticResult = z.object({ facts: z.array(FactSchema).max(120) });

export async function extractRepoFacts(llm: LlmProvider, repoPath: string, files: CodeFile[]): Promise<CodeFact[]> {
  const raw = await llm.json({
    system: `You analyse a whole codebase (your current directory, read-only). Explore it with your tools. ${WHAT_TO_KEEP}
Return 20 to 80 facts. Every fact must cite the file it comes from (repo-relative), or '.' for project-wide facts.`,
    user: `Files in the repository:\n${files.map((f) => f.path).join('\n')}`,
    schema: { type: 'object', required: ['facts'], properties: { facts: { type: 'array', items: FACT_JSON } } },
    cwd: repoPath,
    timeoutMs: 30 * 60_000,
  });
  const known = new Set(files.map((f) => f.path));
  return AgenticResult.parse(raw)
    .facts.filter((f) => f.confidence >= MIN_CONFIDENCE)
    .map((f) => ({ ...f, path: known.has(f.path.replace(/^\.\//, '')) ? f.path.replace(/^\.\//, '') : '.' }));
}

export type ScanDeps = {
  facts: Pick<FactsStore, 'fileHashes' | 'saveFileFacts' | 'markFilesRemoved' | 'replaceProjectFacts' | 'updateScanJob' | 'currentSources' | 'recordScanFailure'>;
  llm: LlmProvider;
  embed(texts: string[]): Promise<number[][]>;
  maxBytes: number;
  maxFiles: number;
  log?: (msg: string, extra?: object) => void;
  activity?: Pick<ActivityStore, 'record'>;
};

const embedFacts = async (facts: CodeFact[], embed: ScanDeps['embed']) => {
  if (!facts.length) return [];
  const vectors = await embed(facts.map((f) => `${f.path}: ${f.statement}`));
  return facts.map((f, i) => ({ ...f, embedding: vectors[i] }));
};

/** Incremental scan: only files whose hash changed are (re)analysed; removed files have their facts closed. */
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const factLog = (facts: CodeFact[]) => facts.map((f) => ({ kind: f.kind, statement: f.statement, why: f.why, confidence: f.confidence }));

export type ScanResult = { filesScanned: number; factsAdded: number; failed: number; remaining: number };

/** Upper bound on files listed per project, so a giant tree cannot exhaust memory. */
const LIST_LIMIT = 20_000;

export async function runScan(job: ScanJob, d: ScanDeps): Promise<ScanResult> {
  const note = (kind: 'scan_started' | 'facts_extracted' | 'scan_finished', subject: string, why: string, details: Record<string, unknown> = {}, targets: string[] = []) =>
    d.activity?.record({ kind, actor: d.llm.id, projectKey: job.projectKey, subject, why, details: { scanJobId: job.id, promptVersion: SCAN_PROMPT_VERSION, ...details }, targets });
  const fileId = (path: string) => `${job.projectKey}:${path}`;
  await d.facts.updateScanJob(job.id, { status: 'running' });
  try {
    // List everything, so files beyond the per-run cap are never mistaken for removed ones.
    const files = await listCodeFiles(job.repoPath, { maxBytes: d.maxBytes, maxFiles: LIST_LIMIT });
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

    let factsAdded = 0;
    let scanned = changed.length;
    const failed: string[] = [];
    if (changed.length && d.llm.agentic) {
      // Only package.json feeds the deterministic facts; a file gone since listing is simply skipped.
      const contents = (await Promise.all(
        files.filter((f) => f.path === 'package.json' || f.path.endsWith('/package.json')).map(async (f) => {
          const content = await readFile(join(job.repoPath, f.path), 'utf8').catch(() => null);
          return content === null ? null : { path: f.path, content };
        }),
      )).filter((c): c is { path: string; content: string } => c !== null);
      const facts = [...(await extractRepoFacts(d.llm, job.repoPath, files)), ...deterministicFacts(contents)];
      await d.facts.replaceProjectFacts(job.projectKey, await embedFacts(facts, d.embed), d.llm.id, files, job.id);
      factsAdded = facts.length;
      await note('facts_extracted', `${plural(facts.length, 'fact')} from the whole repository`,
        `${plural(changed.length, 'file')} changed; ${d.llm.id} explored the repo with read-only tools and replaced its earlier facts`,
        { facts: factLog(facts), changedFiles: changed.map((f) => f.path) }, [...new Set(facts.map((f) => fileId(f.path || '.')))]);
    } else {
      let done = 0;
      // The cap bounds one run's model calls; the rest stay changed and are picked up next scan.
      for (const f of changed.slice(0, d.maxFiles)) {
        let content: string;
        let extracted: Awaited<ReturnType<typeof extractFileFacts>>;
        try {
          content = await readFile(join(job.repoPath, f.path), 'utf8'); // may be gone since listing
          extracted = await extractFileFacts(d.llm, f.path, content);
        } catch (err) {
          // The model could not be asked: every other file would fail the same way, so the whole scan waits.
          if (providerUnavailableReason(err)) throw err;
          // Not saved, so its hash stays stale and the next scan tries it again.
          failed.push(f.path);
          await note('facts_extracted', `could not extract facts from ${f.path}`, String(err), { hash: f.hash }, [fileId(f.path)]);
          continue;
        }
        const { summary, facts } = extracted;
        const all = [...facts, ...deterministicFacts([{ path: f.path, content }])];
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
    if (!d.llm.agentic) scanned = Math.min(changed.length, d.maxFiles) - failed.length;
    const result: ScanResult = { filesScanned: scanned, factsAdded, failed: failed.length, remaining: d.llm.agentic ? 0 : Math.max(0, changed.length - d.maxFiles) };
    await d.facts.updateScanJob(job.id, {
      status: 'done', filesScanned: result.filesScanned, factsAdded,
      ...(failed.length ? { error: `${plural(failed.length, 'file')} failed: ${failed.slice(0, 10).join(', ')}` } : {}),
    });
    const left = result.remaining ? `; ${plural(result.remaining, 'changed file')} left for the next scan (SCAN_MAX_FILES)` : '';
    await note('scan_finished', `scanned ${plural(result.filesScanned, 'file')}, ${plural(factsAdded, 'fact')}${left}`,
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
