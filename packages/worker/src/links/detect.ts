import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isSecretPath, linkPair, MAX_EVIDENCE, NESTED_KEY_SEP, SECRET_GLOBS, SKIP_DIRS, type DetectedLink, type LinkEvidence, type LinkSignal } from '@fb/core';
import { GIT_SAFE } from '../ingest/git.ts';

const run = promisify(execFile);

/** A selected project as the detector sees it: its folder (container side) and normalized git remote. */
export type LinkProject = { key: string; repoPath: string; remote: string | null };

const MANIFESTS = new Set(['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml']);
const MAX_MANIFESTS = 300;
/** How strong each kind of evidence is; a pair's score combines one of each kind it has. */
const WEIGHT: Record<LinkSignal, number> = { manifest: 0.9, remote: 0.6, name: 0.4 };
/** A pair is suggested from here: a manifest alone, or a remote mention with name mentions, but never names alone. */
export const SUGGEST_FROM = 0.5;
/** Name mentions count from this many files, and only for names this long that are not everyday words. */
const NAME_MIN_FILES = 3;
const NAME_MIN_LENGTH = 6;
const GENERIC = new Set([
  'server', 'client', 'frontend', 'backend', 'common', 'shared', 'config', 'website', 'mobile', 'android', 'iphone', 'desktop',
  'plugin', 'plugins', 'library', 'utils', 'helpers', 'scripts', 'design', 'assets', 'public', 'source', 'sample', 'example',
  'examples', 'testing', 'project', 'projects', 'service', 'services', 'gateway', 'worker', 'docs', 'website',
]);

export type ManifestDep = { name: string; path: string };
export type LocalPath = { target: string; spec: string; path: string };
export type Manifests = { names: string[]; deps: ManifestDep[]; localPaths: LocalPath[] };

async function trackedFiles(repoPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    return stdout.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

async function walkManifests(root: string, rel = '', depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 6 || out.length >= MAX_MANIFESTS) return out;
  for (const e of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walkManifests(root, p, depth + 1, out);
    else if (e.isFile() && MANIFESTS.has(e.name)) out.push(p);
  }
  return out;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const LOCAL_SPEC = /^(file|link|portal):(.+)$/;

/** Names a project publishes, what it depends on, and dependencies given as local paths (resolved to absolute). */
export async function readManifests(repoPath: string): Promise<Manifests> {
  const listed = (await trackedFiles(repoPath)) ?? (await walkManifests(repoPath));
  const paths = listed
    .filter((p) => MANIFESTS.has(basename(p)) && !p.split('/').some((s) => SKIP_DIRS.has(s)) && !isSecretPath(p))
    .slice(0, MAX_MANIFESTS);
  const out: Manifests = { names: [], deps: [], localPaths: [] };
  for (const path of paths) {
    const text = await readFile(join(repoPath, path), 'utf8').catch(() => null);
    if (text === null) continue;
    const local = (spec: string, rel: string) => out.localPaths.push({ target: resolve(repoPath, dirname(path), rel), spec, path });
    const dep = (name: string) => name && out.deps.push({ name, path });
    const file = basename(path);
    if (file === 'package.json') {
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof p.name === 'string') out.names.push(p.name);
      for (const field of DEP_FIELDS) {
        for (const [name, spec] of Object.entries((p[field] as Record<string, unknown>) ?? {})) {
          dep(name);
          if (typeof spec !== 'string') continue;
          const m = LOCAL_SPEC.exec(spec);
          if (m) local(spec, m[2]);
          else if (/^\.{1,2}\//.test(spec)) local(spec, spec);
        }
      }
    } else if (file === 'go.mod') {
      const mod = /^module\s+(\S+)/m.exec(text);
      if (mod) out.names.push(mod[1]);
      for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) for (const line of block[1].split('\n')) dep(line.trim().split(/\s+/)[0] ?? '');
      for (const m of text.matchAll(/^require\s+([^\s(]+)/gm)) dep(m[1]);
      for (const m of text.matchAll(/=>\s*(\.{1,2}\/\S*)/g)) local(m[0], m[1]);
    } else {
      // TOML, read just far enough: [package]/[project]/[tool.poetry] names and the dependency tables.
      let section = '';
      for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        const head = /^\[([^\]]+)\]$/.exec(line);
        if (head) {
          section = head[1].trim();
          continue;
        }
        const name = /^name\s*=\s*"([^"]+)"/.exec(line);
        if (name && ['package', 'project', 'tool.poetry'].includes(section)) out.names.push(name[1]);
        if (/(^|\.)(dev-|build-)?dependencies$/.test(section) && section !== 'project.dependencies') {
          const key = /^([A-Za-z0-9_.-]+)\s*=/.exec(line);
          if (key && key[1] !== 'python') {
            dep(key[1]);
            const p = /path\s*=\s*"([^"]+)"/.exec(line);
            if (p) local(line, p[1]);
          }
        }
      }
      // PEP 621: dependencies = ["name>=1", ...] in [project], possibly over several lines.
      const list = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text);
      if (list) for (const m of list[1].matchAll(/"([A-Za-z0-9_.-]+)/g)) dep(m[1]);
    }
  }
  out.names = [...new Set(out.names)];
  const seen = new Set<string>();
  out.deps = out.deps.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An extended regex for a whole name or slug: not part of a longer name (letters, digits, `_`, `-` around it). */
export const mentionNeedle = (s: string) => `(^|[^A-Za-z0-9_-])${escapeRe(s)}([^A-Za-z0-9_-]|$)`;

/** Never read for evidence: the same files the scanner never reads. */
const EXCLUDES = SECRET_GLOBS.map((g) => `:(exclude,glob)${g}`);

/**
 * Which of `needles` (names or owner/name slugs) each tracked file mentions, in one `git grep` over the repo: lowercased
 * needle to the files naming it. A needle counts only as a whole name (not the start of a longer one). Secret files are
 * excluded; a folder that is not a git repo has none.
 */
export async function grepMentions(repoPath: string, needles: string[]): Promise<Map<string, string[]>> {
  const wanted = [...new Set(needles.map((n) => n.toLowerCase()))].filter(Boolean);
  const out = new Map<string, Set<string>>();
  if (!wanted.length) return new Map();
  const tests = wanted.map((n) => ({ n, re: new RegExp(mentionNeedle(n), 'i') }));
  let stdout = '';
  try {
    ({ stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'grep', '-z', '-o', '-I', '-i', '-E', '-e', wanted.map(mentionNeedle).join('|'), '--', '.', ...EXCLUDES], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }));
  } catch (err) {
    // Exit 1 is "no match"; a huge repo may still have printed what it found before a limit.
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('\0');
    if (at < 0) continue;
    const path = line.slice(0, at);
    if (isSecretPath(path) || path.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    const match = line.slice(at + 1);
    // One match can hold several needles ("me/orbital-server" names both the slug and the name).
    for (const t of tests) if (t.re.test(match)) (out.get(t.n) ?? out.set(t.n, new Set()).get(t.n)!).add(path);
  }
  return new Map([...out].map(([n, files]) => [n, [...files].sort()]));
}

/** The name other projects would use for this one: its folder's last segment. */
const shortName = (key: string) => key.split(NESTED_KEY_SEP).pop() ?? key;
const nameWorthSearching = (n: string) => n.length >= NAME_MIN_LENGTH && !GENERIC.has(n.toLowerCase());
/** owner/name of a hosted remote; null for a local bare repo or a one-segment path. */
const slugOf = (remote: string | null) => {
  if (!remote || remote.startsWith('local/')) return null;
  const parts = remote.split('/').slice(1);
  return parts.length >= 2 && parts[parts.length - 1].length >= 3 ? parts.slice(-2).join('/') : null;
};
/**
 * Two folders of one repo: the same normalized remote, or one cloned from the other on disk (`local/<name>` naming
 * the other's folder or key). A clone mentions its original everywhere, so it is never a link to suggest.
 */
export function sameRepo(x: LinkProject, y: LinkProject): boolean {
  if (x.remote && x.remote === y.remote) return true;
  const names = (p: LinkProject) => new Set([shortName(p.key), basename(p.repoPath)].map((n) => `local/${n.toLowerCase()}`));
  return (!!x.remote && names(y).has(x.remote.toLowerCase())) || (!!y.remote && names(x).has(y.remote.toLowerCase()));
}
/** Each project's repo: projects that are clones of one another (sameRepo, followed through) share one. */
function repoGroups(projects: LinkProject[]): Map<string, string> {
  const parent = new Map(projects.map((p) => [p.key, p.key]));
  const find = (k: string): string => (parent.get(k) === k ? k : find(parent.get(k)!));
  for (const [i, x] of projects.entries()) for (const y of projects.slice(i + 1)) if (sameRepo(x, y)) parent.set(find(y.key), find(x.key));
  return new Map(projects.map((p) => [p.key, find(p.key)]));
}
const inside = (target: string, dir: string) => target === dir || target.startsWith(`${dir.replace(/\/+$/, '')}/`);

/**
 * Evidence that selected projects belong together, from what is in them (no model): a manifest naming another
 * project's package or a local path into it, another project's git remote, and its name in several files. Pairs whose
 * evidence reaches SUGGEST_FROM come back, depends_on (a manifest says so) first, then the strongest evidence; a
 * project and its own clone (sameRepo) never pair.
 */
export async function detectLinks(projects: LinkProject[]): Promise<DetectedLink[]> {
  const manifests = new Map<string, Manifests>();
  for (const p of projects) manifests.set(p.key, await readManifests(p.repoPath));
  const repo = repoGroups(projects);
  const evidence = new Map<string, { a: string; b: string; items: LinkEvidence[] }>();
  const add = (x: string, y: string, e: LinkEvidence) => {
    if (x === y) return;
    const [a, b] = linkPair(x, y);
    const k = `${a}\n${b}`;
    const cur = evidence.get(k) ?? { a, b, items: [] };
    if (!cur.items.some((i) => i.signal === e.signal && i.detail === e.detail)) cur.items.push(e);
    evidence.set(k, cur);
  };
  for (const from of projects) {
    const mine = manifests.get(from.key)!;
    const own = new Set(mine.names);
    // Every other project's slug and name, searched for in one pass over this project.
    const others = projects.filter((p) => p.key !== from.key);
    const slugs = new Map(others.map((p) => [p.key, slugOf(p.remote)]));
    const names = new Map(others.map((p) => [p.key, shortName(p.key)]));
    const mentions = await grepMentions(from.repoPath, [
      ...[...slugs.values()].filter((x): x is string => !!x && x !== slugOf(from.remote)),
      ...[...names.values()].filter((n) => nameWorthSearching(n) && n.toLowerCase() !== shortName(from.key).toLowerCase()),
    ]);
    for (const to of projects) {
      if (to.key === from.key || repo.get(to.key) === repo.get(from.key)) continue;
      const theirs = new Set(manifests.get(to.key)!.names.filter((n) => !own.has(n)));
      for (const d of mine.deps) {
        if (theirs.has(d.name)) add(from.key, to.key, { signal: 'manifest', detail: `${from.key} depends on ${d.name}, a package of ${to.key}`, path: d.path, from: from.key });
      }
      for (const l of mine.localPaths) {
        if (!inside(l.target, from.repoPath) && inside(l.target, to.repoPath)) {
          add(from.key, to.key, { signal: 'manifest', detail: `${from.key} has a dependency on a local path into ${to.key} (${l.spec.slice(0, 120)})`, path: l.path, from: from.key });
        }
      }
      const slug = slugs.get(to.key);
      if (slug && slug !== slugOf(from.remote)) {
        const files = mentions.get(slug.toLowerCase()) ?? [];
        if (files.length) add(from.key, to.key, { signal: 'remote', detail: `${from.key} mentions ${to.key}'s repository ${slug} in ${files.length} file${files.length === 1 ? '' : 's'}`, path: files[0], from: from.key });
      }
      const name = names.get(to.key)!;
      if (nameWorthSearching(name) && name.toLowerCase() !== shortName(from.key).toLowerCase()) {
        const files = mentions.get(name.toLowerCase()) ?? [];
        if (files.length >= NAME_MIN_FILES) add(from.key, to.key, { signal: 'name', detail: `${from.key} names ${to.key} in ${files.length} files`, path: files[0], from: from.key });
      }
    }
  }
  const order: LinkSignal[] = ['manifest', 'remote', 'name'];
  const out: DetectedLink[] = [];
  for (const { a, b, items } of evidence.values()) {
    const signals = new Set(items.map((i) => i.signal));
    const score = 1 - [...signals].reduce((p, s) => p * (1 - WEIGHT[s]), 1);
    if (score < SUGGEST_FROM) continue;
    const sorted = [...items].sort((x, y) => order.indexOf(x.signal) - order.indexOf(y.signal)).slice(0, MAX_EVIDENCE);
    out.push({ a, b, relation: signals.has('manifest') ? 'depends_on' : 'related', score: Math.round(score * 100) / 100, evidence: sorted });
  }
  // A dependency a manifest declares outranks any count of mentions.
  const rank = (l: DetectedLink) => (l.relation === 'depends_on' ? 1 : 0);
  return out.sort((x, y) => rank(y) - rank(x) || y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}
