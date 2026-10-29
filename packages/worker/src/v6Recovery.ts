import { realpath, stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { redactSecrets, type ActivityStore, type DocsStore, type FactsStore, type KnowledgeStore } from '@fb/core';

export const V6_REPAIR_CURSOR = 'redaction-v6-source-repair-v9';
/** Reproduce only the three defective v6 patterns, to match an exact retained snapshot. */
export function v6FalsePositiveMask(text: string): string {
  return text.replace(/\b(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi, '$1[REDACTED]')
    .replace(/("auth"\s*:\s*")[A-Za-z0-9+/]{8,}={0,2}(?=")/g, '$1[REDACTED]')
    .replace(/^((?:[^:\r\n\\]|\\.)+:(?:\d+|\*):(?:[^:\r\n\\]|\\.)+:(?:[^:\r\n\\]|\\.)+:)[^\r\n]+/gm, '$1[REDACTED]');
}
export const safeRetainedOriginal = (masked: string, original: string) => original !== masked && !original.includes('[REDACTED]')
  && redactSecrets(original) === original && v6FalsePositiveMask(original) === masked;

type Deps = {
  facts: Pick<FactsStore, 'redactionRepairCandidates' | 'requestFilesScan' | 'requestScan'>;
  docs: Pick<DocsStore, 'getCursor' | 'setCursor' | 'queueRedactionRepair'>;
  knowledge: Pick<KnowledgeStore, 'listLessons' | 'updateLesson' | 'setLessonChecks'>;
  projects: () => Promise<{ key: string; repoPath: string }[]>;
  activity?: Pick<ActivityStore, 'record'>;
};
/** Never reopen masked facts: rebuild them from verified local sources, or request the owner's original. */
export async function repairV6Sources(d: Deps) {
  if (await d.docs.getCursor(V6_REPAIR_CURSOR) === 'scheduled') return null;
  const result = { suspectedFacts: 0, filesQueued: 0, uploadsQueued: 0, lessonsRestored: 0, lessonsNeedOriginal: 0, factsNeedOriginal: 0 };
  const projects = new Map((await d.projects()).map(p => [p.key, p]));
  const paths = new Map<string, Set<string>>();
  const docs = new Map<string, number>();
  for (let after = ''; ;) {
    const page = await d.facts.redactionRepairCandidates?.(after, 500) ?? [];
    if (!page.length) break;
    for (const fact of page) {
      result.suspectedFacts++;
      if (fact.docId) { docs.set(fact.docId, (docs.get(fact.docId) ?? 0) + 1); continue; }
      const project = projects.get(fact.projectKey);
      if (!project || !fact.path || isAbsolute(fact.path)) { result.factsNeedOriginal++; continue; }
      try {
        const root = await realpath(project.repoPath);
        const source = await realpath(resolve(root, fact.path));
        const rel = relative(root, source);
        if (rel.startsWith('..') || isAbsolute(rel) || !(await stat(source)).isFile()) throw new Error('source unavailable');
        const set = paths.get(project.key) ?? new Set<string>(); set.add(fact.path); paths.set(project.key, set);
      } catch { result.factsNeedOriginal++; }
    }
    const next = page[page.length - 1].id;
    if (next <= after) throw new Error('redaction recovery pagination did not advance');
    after = next;
  }
  for (const [key, files] of paths) {
    await d.facts.requestFilesScan(key, [...files]);
    const project = projects.get(key)!;
    await d.facts.requestScan({ ...project, name: key }, null);
    result.filesQueued += files.size;
  }
  for (const [id, count] of docs) {
    if (await d.docs.queueRedactionRepair?.(id)) result.uploadsQueued++;
    else result.factsNeedOriginal += count;
  }
  for (const lesson of await d.knowledge.listLessons({ status: 'approved', limit: 2147483647 })) {
    const patch: Partial<Pick<typeof lesson, 'title' | 'rule' | 'appliesWhen'>> = {};
    let damaged = false;
    for (const field of ['title', 'rule', 'appliesWhen'] as const) {
      if (!lesson[field].includes('[REDACTED]')) continue;
      const original = lesson.proposedAs?.[field];
      if (original && safeRetainedOriginal(lesson[field], original)) patch[field] = original;
      else damaged = true;
    }
    if (Object.keys(patch).length) {
      await d.knowledge.updateLesson(lesson.id, patch, { by: 'redaction-repair', note: 'Exact retained snapshot matches a defective v6 pattern and passes current redaction.' });
      result.lessonsRestored++;
    }
    if (damaged) {
      const why = 'Redaction v6 repair: original wording is unavailable. Restore from the source PR or a backup; masked words cannot be inferred safely.';
      await d.knowledge.setLessonChecks(lesson.id, [...(lesson.checks ?? []).filter(c => c.why !== why), { name: 'contradicts-evidence', why }]);
      result.lessonsNeedOriginal++;
    }
  }
  await d.activity?.record({ kind: 'secrets_redacted', actor: 'deterministic', projectKey: null,
    subject: 'Redaction v6 source recovery scheduled',
    why: `File rescans and retained upload originals are queued, not restored yet. Masked facts stay closed. ${result.lessonsRestored ? `${result.lessonsRestored} exact safe retained lesson snapshots restored.` : 'No lesson originals were restored.'} Unavailable originals require re-upload, source review or a backup. Counts are suspected damage, not proof of a false positive.`,
    details: { version: 9, recovery: 'v6-source-repair', ...result } });
  await d.docs.setCursor(V6_REPAIR_CURSOR, 'scheduled');
  return result;
}
