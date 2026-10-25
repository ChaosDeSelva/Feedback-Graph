import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityStore, FactCheck, FactsStore, StoredFact } from '@fb/core';
import { checkCitations, FACT_CHECK_VERSION, repoReader } from './scan.ts';

export type RecheckDeps = {
  facts: Pick<FactsStore, 'factsToRecheck' | 'applyFactChecks' | 'listFacts' | 'markFilesRemoved'>;
  /** The selected projects and their folders as the worker sees them. */
  projects: () => Promise<{ key: string; repoPath: string }[]>;
  maxBytes: number;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
  /** Facts per store round trip. */
  batch?: number;
};

export type RecheckResult = { checked: number; closed: number; linesDropped: number };

/** Facts listed in an Activity entry at most (the counts are always whole). */
const LISTED = 50;
/**
 * More than this share of a project's distinct cited files missing (and more than one) means the folder is not the
 * repo the facts are about (a wrong mount, where package.json and the README may still be there): the project is skipped.
 */
const MISSING_RATIO = 0.3;
/** Current facts per page when counting a project's cited files. */
const PAGE = 500;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;
const exists = async (p: string) => (await lstat(p).catch(() => null)) !== null;

/** The distinct files the project's current facts cite, and how many of them are not in the folder. */
async function citedFiles(d: RecheckDeps, key: string, repoPath: string): Promise<{ cited: number; missing: number }> {
  const paths = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await d.facts.listFacts({ projectKey: key, limit: PAGE, offset });
    // As factsToRecheck sees them: a document's facts and yours cite no repo file.
    for (const f of page) if (f.path && f.path !== '.' && !f.docId && f.origin !== 'you') paths.add(f.path);
    if (page.length < PAGE) break;
  }
  let missing = 0;
  for (const path of paths) if (!(await exists(join(repoPath, path)))) missing++;
  return { cited: paths.size, missing };
}

/**
 * A rule change migrates its data: current scan facts last checked by an older citation rule (FACT_CHECK_VERSION) are
 * checked again against the repo as it is now, once. A fact citing an instruction file (AGENTS.md, CLAUDE.md) or a file
 * that is gone is closed, so it is no longer served; cited lines that no longer hold what the fact names are dropped
 * (the fact stays, evidence 'file'); every fact checked is stamped, so the next start does nothing. A file that is gone
 * is marked removed (its hash forgotten), so if it was only missing at start-up (an older branch checked out) the next
 * scan reads it again. What changed is in Activity, per project. A project whose folder is not there, or where too many
 * of the cited files are missing (MISSING_RATIO), is left alone, and the log says so.
 */
export async function recheckFacts(d: RecheckDeps): Promise<RecheckResult> {
  const total: RecheckResult = { checked: 0, closed: 0, linesDropped: 0 };
  const batch = d.batch ?? 500;
  for (const p of await d.projects()) {
    if (!p.repoPath || !(await isDir(p.repoPath))) continue;
    const first = await d.facts.factsToRecheck({ projectKey: p.key, version: FACT_CHECK_VERSION, limit: 1 });
    if (!first.length) continue;
    const files = await citedFiles(d, p.key, p.repoPath);
    if (files.missing > Math.max(1, MISSING_RATIO * files.cited)) {
      d.log?.('facts recheck skipped: too many of the files they cite are missing from the folder, which is likely not the repo they are about', {
        project: p.key, repoPath: p.repoPath, citedFiles: files.cited, missingFiles: files.missing,
      });
      continue;
    }
    const read = repoReader(p.repoPath, d.maxBytes);
    const mine: RecheckResult = { checked: 0, closed: 0, linesDropped: 0 };
    const closed: StoredFact[] = [];
    const unlined: StoredFact[] = [];
    for (;;) {
      const facts = await d.facts.factsToRecheck({ projectKey: p.key, version: FACT_CHECK_VERSION, limit: batch });
      if (!facts.length) break;
      // A shard's fact about its own directory is about the shard as a whole: nothing to check.
      const dirs = new Set<string>();
      for (const f of facts) if (f.path !== '.' && (await lstat(join(p.repoPath, f.path)).catch(() => null))?.isDirectory()) dirs.add(f.id);
      // Checked as the scan checks what a model cites (a stored fact has a null evidence where an extracted one has none).
      const { kept, dropped } = await checkCitations(facts.filter((f) => !dirs.has(f.id)).map((f) => ({ ...f, evidence: f.evidence ?? undefined })), read);
      const checks: FactCheck[] = [
        ...facts.filter((f) => dirs.has(f.id)).map((f) => ({ id: f.id, keep: true, lines: null, evidence: 'none' as const })),
        ...kept.map((f) => ({ id: f.id, keep: true, lines: f.lines, evidence: f.evidence ?? null })),
        ...dropped.map((f) => ({ id: f.id, keep: false, lines: f.lines, evidence: f.evidence ?? null })),
      ];
      mine.closed += await d.facts.applyFactChecks(FACT_CHECK_VERSION, checks);
      const gone: string[] = [];
      for (const path of new Set(dropped.map((f) => f.path))) if (path !== '.' && !(await exists(join(p.repoPath, path)))) gone.push(path);
      await d.facts.markFilesRemoved(p.key, gone);
      mine.checked += checks.length;
      closed.push(...dropped);
      const lost = kept.filter((f) => f.lines === null && f.evidence === 'file' && facts.find((x) => x.id === f.id)?.lines);
      unlined.push(...lost);
      mine.linesDropped += lost.length;
      if (facts.length < batch) break;
    }
    total.checked += mine.checked;
    total.closed += mine.closed;
    total.linesDropped += mine.linesDropped;
    if (!mine.closed && !mine.linesDropped) continue;
    const row = (f: StoredFact) => ({ id: f.id, path: f.path, statement: f.statement });
    await d.activity?.record({
      kind: 'facts_extracted',
      actor: 'deterministic',
      projectKey: p.key,
      subject: `rechecked ${plural(mine.checked, 'fact')} of ${p.key}: ${mine.closed} closed, ${mine.linesDropped} lost ${mine.linesDropped === 1 ? 'its' : 'their'} line range`,
      why: `the citation checks changed (${FACT_CHECK_VERSION}), so facts saved before were checked again against the repo: a fact citing AGENTS.md, CLAUDE.md or a file that is gone is no longer served, and cited lines that do not hold what a fact names were dropped from it`,
      details: { checkVersion: FACT_CHECK_VERSION, checked: mine.checked, closed: closed.slice(0, LISTED).map(row), linesDropped: unlined.slice(0, LISTED).map(row) },
      targets: [...new Set([...closed, ...unlined].slice(0, LISTED).map((f) => `${p.key}:${f.path}`))],
    });
    d.log?.('facts rechecked', { project: p.key, ...mine });
  }
  return total;
}
