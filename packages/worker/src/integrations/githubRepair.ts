import { createHash } from 'node:crypto';
import { IntegrationError, prContextToChunks, redactSecrets, type DocsStore, type FetchPrOpts, type PrContext } from '@fb/core';

type Progress = { after: string; status: 'scanning' | 'waiting' | 'verified'; checked: number; repaired: number; literal: number; protected: number; pending: number; nextRetryAt?: string; errorKind?: string; blockedDoc?: string };
type Outcome = { fingerprint: string; status: 'repaired' | 'literal' | 'protected' | 'retry'; attempts: number; nextRetryAt?: string };
const masks = (chunks: string[]) => chunks.reduce((n, text) => n + (text.match(/\[REDACTED\]/g)?.length ?? 0), 0);
const fingerprint = (chunks: string[]) => createHash('sha256').update(JSON.stringify([...chunks].sort())).digest('hex');
const parse = <T>(raw: string | null): T | null => { try { return raw ? JSON.parse(raw) as T : null; } catch { return null; } };
export const githubRepairCursor = (project: string) => `github-redaction-repair-v9:${project}`;

/** Five damaged documents per turn, direct PR fetches, durable progress after each result. Literal masks are not damage. */
export async function repairGithubDocs(d: {
  projectKey: string; repo: string; token: string; docs: Pick<DocsStore, 'getCursor' | 'setCursor' | 'githubRepairDocs' | 'githubDocChunks'>;
  fetchPrs(o: FetchPrOpts): Promise<PrContext[]>; store(pr: PrContext): Promise<void>; now: string;
}): Promise<{ progress: Progress; repairedMasks: number; fetchedDocs: number; attemptedDocs: number; rateLimited: boolean }> {
  const key = githubRepairCursor(d.projectKey);
  const prior = parse<Progress>(await d.docs.getCursor(key));
  const progress: Progress = prior?.after ? prior : { after: '', status: 'scanning', checked: 0, repaired: 0, literal: 0, protected: 0, pending: 0 };
  if (!d.docs.githubRepairDocs || !d.docs.githubDocChunks) return { progress: { ...progress, status: 'waiting' }, repairedMasks: 0, fetchedDocs: 0, attemptedDocs: 0, rateLimited: false };
  const docs = await d.docs.githubRepairDocs(d.projectKey, progress.after, 5);
  let repairedMasks = 0;
  let fetchedDocs = 0;
  let attemptedDocs = 0;
  for (const doc of docs) {
    const signature = fingerprint(doc.chunks);
    const itemKey = `${key}:doc:${createHash('sha256').update(doc.id).digest('hex')}`;
    const last = parse<Outcome>(await d.docs.getCursor(itemKey));
    if (progress.blockedDoc === doc.id) { progress.pending = Math.max(0, progress.pending - 1); delete progress.blockedDoc; }
    if (last?.fingerprint === signature && last.status !== 'retry') {
      progress[last.status === 'literal' ? 'literal' : last.status === 'protected' ? 'protected' : 'repaired']++;
    } else if (last?.nextRetryAt && Date.parse(last.nextRetryAt) > Date.parse(d.now)) {
      progress.pending++;
      progress.nextRetryAt = last.nextRetryAt;
    } else {
      attemptedDocs++;
      try {
        const number = Number(doc.ref.match(/#(\d+)$/)?.[1]);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error('stored GitHub document has no PR number');
        const prs = await d.fetchPrs({ repo: d.repo, token: d.token, numbers: [number], includeFiles: false });
        const pr = prs.find(value => value.number === number);
        if (!pr) throw new Error('GitHub did not return the requested PR');
        const original = prContextToChunks(pr).map(chunk => chunk.text);
        const safe = original.map(redactSecrets);
        const remaining = masks(safe);
        const removed = Math.max(0, masks(doc.chunks) - remaining);
        await d.store(pr);
        const persisted = await d.docs.githubDocChunks(doc.id);
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(safe)) throw new Error('GitHub repair did not persist the expected chunks');
        fetchedDocs++;
        const status: Outcome['status'] = remaining === 0 ? 'repaired' : remaining > masks(original) ? 'protected' : 'literal';
        await d.docs.setCursor(itemKey, JSON.stringify({ fingerprint: fingerprint(safe.filter(text => text.includes('[REDACTED]'))), status, attempts: 0 } satisfies Outcome));
        progress[status]++;
        repairedMasks += removed;
      } catch (error) {
        const attempts = (last?.attempts ?? 0) + 1;
        const retryAt = error instanceof IntegrationError && error.retryAt ? error.retryAt : new Date(Date.parse(d.now) + Math.min(3600_000, 60_000 * 2 ** Math.min(attempts - 1, 6))).toISOString();
        await d.docs.setCursor(itemKey, JSON.stringify({ fingerprint: signature, status: 'retry', attempts, nextRetryAt: retryAt } satisfies Outcome));
        progress.pending++;
        progress.blockedDoc = doc.id;
        progress.nextRetryAt = retryAt;
        progress.status = 'waiting';
        progress.errorKind = error instanceof IntegrationError ? error.kind : 'other';
        // Do not advance past a failed PR: retry from its persisted predecessor after backoff.
        await d.docs.setCursor(key, JSON.stringify(progress));
        return { progress, repairedMasks, fetchedDocs, attemptedDocs, rateLimited: error instanceof IntegrationError && error.kind === 'rate_limit' };
      }
    }
    if (!progress.pending) { delete progress.nextRetryAt; delete progress.errorKind; }
    progress.after = doc.id;
    progress.checked++;
    progress.status = 'scanning';
    await d.docs.setCursor(key, JSON.stringify(progress));
  }
  if (docs.length < 5) { progress.after = ''; progress.status = progress.pending ? 'waiting' : 'verified'; }
  await d.docs.setCursor(key, JSON.stringify(progress));
  return { progress, repairedMasks, fetchedDocs, attemptedDocs, rateLimited: false };
}
