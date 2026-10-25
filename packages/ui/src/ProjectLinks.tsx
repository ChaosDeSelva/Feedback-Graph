import { useEffect, useRef, useState } from 'react';
import { api, type LinkRelation, type ProjectLink } from './api.ts';
import { Button, Input, Select } from './ui/controls.tsx';
import { Badge, Card } from './ui/display.tsx';

const RELATIONS: { value: LinkRelation; label: string }[] = [
  { value: 'depends_on', label: 'depends on' },
  { value: 'same_product', label: 'same product' },
  { value: 'shares_code', label: 'shares code' },
  { value: 'related', label: 'related' },
];
const relationLabel = (r: LinkRelation) => RELATIONS.find((x) => x.value === r)?.label ?? r;
const otherEnd = (l: ProjectLink, key: string) => (l.a === key ? l.b : l.a);

/**
 * Projects that belong with this one. Confirmed links give agents here the best matches from the other project (and
 * the other way round); suggestions come from evidence the worker found and do nothing until you confirm them.
 */
export function ProjectLinks({ projectKey, projects, onError, undoMs = 6000 }: { projectKey: string; projects: string[]; onError: (e: string) => void; undoMs?: number }) {
  const [links, setLinks] = useState<ProjectLink[]>([]);
  // Suggestions you just confirmed or dismissed: they keep their row (faded, with Undo) for `undoMs`, so the list does
  // not close up under the pointer and a slip can be taken back. Only then do they move to their list.
  const [decided, setDecided] = useState<Map<string, 'confirmed' | 'dismissed'>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);
  const settle = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setDecided((d) => { const n = new Map(d); n.delete(id); return n; });
  };
  const [pick, setPick] = useState('');
  const [relation, setRelation] = useState<LinkRelation>('related');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    setLinks([]);
    for (const id of [...timers.current.keys()]) settle(id);
    api.links(projectKey).then((l) => { if (!stale) setLinks(l); }, (e) => { if (!stale) onError(String(e)); });
    return () => { stale = true; };
  }, [projectKey]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setLinks(await api.links(projectKey));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const decide = (other: string, patch: { status?: ProjectLink['status']; relation?: LinkRelation; note?: string }) => act(() => api.setLink({ a: projectKey, b: other, ...patch }));
  async function decideSuggestion(l: ProjectLink, status: 'confirmed' | 'dismissed') {
    setDecided((d) => new Map(d).set(l.id, status));
    await decide(otherEnd(l, projectKey), { status });
    timers.current.set(l.id, setTimeout(() => settle(l.id), undoMs));
  }
  async function undo(l: ProjectLink) {
    settle(l.id);
    await decide(otherEnd(l, projectKey), { status: 'suggested' });
  }

  // A manifest dependency first, then the strongest evidence.
  const rank = (l: ProjectLink) => (l.relation === 'depends_on' ? 1 : 0);
  const confirmed = links.filter((l) => l.status === 'confirmed' && !decided.has(l.id));
  const suggested = links.filter((l) => l.status === 'suggested' || decided.has(l.id)).sort((x, y) => rank(y) - rank(x) || y.score - x.score);
  const dismissed = links.filter((l) => l.status === 'dismissed' && !decided.has(l.id));
  const linked = new Set(confirmed.map((l) => otherEnd(l, projectKey)));
  const offer = projects.filter((p) => p !== projectKey && !linked.has(p));

  return (
    <Card title={`Linked projects (${confirmed.length})`}>
      <ul>
        {confirmed.map((l) => {
          const other = otherEnd(l, projectKey);
          return (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-b-0">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium">{other}</span>
                <Badge tone="accent">{relationLabel(l.relation)}</Badge>
                {l.note && <span className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">{l.note}</span>}
              </span>
              <Button size="sm" variant="ghost" aria-label={`unlink ${other}`} disabled={busy} onClick={() => act(() => api.deleteLink(l.id))} className="hover:text-bad-text">unlink</Button>
            </li>
          );
        })}
        {confirmed.length === 0 && (
          <li className="px-3 py-3 text-muted">
            Not linked to any project yet. Agents working here get the best lessons, misses, facts and docs from linked projects too.
          </li>
        )}
      </ul>

      {suggested.length > 0 && (
        <div className="border-t border-line">
          <div className="px-3 pt-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Suggested from what is in the projects</div>
          <ul>
            {suggested.map((l) => {
              const other = otherEnd(l, projectKey);
              const done = decided.get(l.id);
              return (
                <li key={l.id} className="grid gap-1 border-b border-line px-3 py-2 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={`flex items-center gap-2 transition-opacity ${done ? 'opacity-45' : ''}`}>
                      <span className="font-medium">{other}</span>
                      <Badge>{relationLabel(l.relation)}</Badge>
                      <span className="text-xs text-muted tabular-nums" title="strength of the evidence">{Math.round(l.score * 100)}%</span>
                    </span>
                    {done ? (
                      <span role="status" className="flex items-center gap-2 text-xs text-muted">
                        {done === 'confirmed' ? 'confirmed' : 'dismissed'} the link to {other}
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo(l)}>Undo</Button>
                      </span>
                    ) : (
                      <span className="flex gap-1">
                        <Button size="sm" variant="primary" aria-label={`confirm link to ${other}`} disabled={busy} onClick={() => void decideSuggestion(l, 'confirmed')}>Confirm</Button>
                        <Button size="sm" variant="ghost" aria-label={`dismiss link to ${other}`} disabled={busy} onClick={() => void decideSuggestion(l, 'dismissed')}>Dismiss</Button>
                      </span>
                    )}
                  </div>
                  <ul className={`grid gap-0.5 text-xs text-muted transition-opacity ${done ? 'opacity-45' : ''}`}>
                    {l.evidence.map((e, i) => (
                      <li key={i} className="[overflow-wrap:anywhere]">
                        {e.detail}
                        {e.path && <> (<span className="font-mono">{e.path}</span>)</>}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <form
        className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pick) return;
          void decide(pick, { status: 'confirmed', relation, ...(note.trim() ? { note: note.trim() } : {}) }).then(() => { setPick(''); setNote(''); });
        }}
      >
        <Select aria-label="project to link" size="sm" value={pick} onChange={(e) => setPick(e.target.value)} className="w-44">
          <option value="">link a project…</option>
          {offer.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select aria-label="relation" size="sm" value={relation} onChange={(e) => setRelation(e.target.value as LinkRelation)}>
          {RELATIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </Select>
        <Input aria-label="note" size="sm" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="how they fit together (optional)" className="min-w-40 flex-1" />
        <Button size="sm" type="submit" disabled={!pick || busy}>Link</Button>
      </form>

      {dismissed.length > 0 && (
        <details className="border-t border-line px-3 py-2 text-xs text-muted">
          <summary className="cursor-pointer">{dismissed.length} dismissed</summary>
          <ul className="mt-1 grid gap-1">
            {dismissed.map((l) => {
              const other = otherEnd(l, projectKey);
              return (
                <li key={l.id} className="flex items-center justify-between gap-2">
                  <span>{other}</span>
                  <Button size="sm" variant="ghost" aria-label={`reconsider ${other}`} disabled={busy} onClick={() => decide(other, { status: 'suggested' })}>reconsider</Button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </Card>
  );
}
