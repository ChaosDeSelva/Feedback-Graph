import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type CodeMapReport, type Hotspot, type ModuleContext } from './api.ts';
import { inboxHref, lessonHref } from './links.ts';
import { Button } from './ui/controls.tsx';
import { Alert, Badge, Card, CauseBadge, EmptyState, plural, SectionLabel, SkeletonDetail, SkeletonList, StatGrid, StatTile, tableClass, tdClass, thClass } from './ui/display.tsx';
import { ChevronIcon, CloseIcon } from './ui/icons.tsx';

type SortKey = 'path' | 'churn' | 'misses' | 'dependents' | 'score';
type Sort = { key: SortKey; desc: boolean };
const LABEL: Record<SortKey, string> = { path: 'file', churn: 'churn', misses: 'misses', dependents: 'dependents', score: 'score' };
const HINT: Record<SortKey, string> = {
  path: 'repo-relative path',
  churn: 'commits touching it in the last 90 days',
  misses: 'confirmed misses whose session edited it',
  dependents: 'files that import it',
  score: '4 × misses + log2(1 + churn) + log2(1 + dependents)',
};
/** Names read A to Z; numbers read biggest first. */
const defaultSort = (key: SortKey): Sort => ({ key, desc: key !== 'path' });
const ROWS = 25;

/** Test files are left out of hotspots unless this is ticked (the API's tests=1). */
export function IncludeTests({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted" title="test files are left out of hotspots unless included">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-[var(--color-accent-edge)]" />
      include tests
    </label>
  );
}

/** The Projects page's code map: its size, its hotspots (sortable), and a module panel for the file you pick. */
export function CodeMap({ projectKey }: { projectKey: string }) {
  const [report, setReport] = useState<CodeMapReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(defaultSort('score'));
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [tests, setTests] = useState(false);

  useEffect(() => {
    setReport(null);
    setError(null);
    setOpen(null);
    setAll(false);
    let stale = false;
    api.codeMap(projectKey, undefined, tests).then((r) => { if (!stale) setReport({ meta: r?.meta ?? null, hotspots: r?.hotspots ?? [] }); }, (e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [projectKey, tests]);

  const rows = useMemo(() => {
    const hs = [...(report?.hotspots ?? [])];
    const by = (a: Hotspot, b: Hotspot) => (sort.key === 'path' ? a.path.localeCompare(b.path) : a[sort.key] - b[sort.key]);
    return hs.sort((a, b) => (sort.desc ? -by(a, b) : by(a, b)) || a.path.localeCompare(b.path));
  }, [report, sort]);
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : defaultSort(key)));

  const meta = report?.meta;
  return (
    <Card title="Code map" bodyClass="grid gap-3 p-3">
      {error && <Alert>{error}</Alert>}
      {!report && !error ? (
        <SkeletonList rows={3} />
      ) : !meta ? (
        <EmptyState title="No code map yet">
          The worker maps each selected project's code (files, imports, tests and recent churn) within a few minutes, and again whenever the repo changes.
        </EmptyState>
      ) : (
        <>
          <StatGrid className="grid-cols-2 sm:grid-cols-4">
            <StatTile label="files" value={meta.stats.files} hint="mapped source files" />
            <StatTile label="symbols" value={meta.stats.symbols} hint="functions, classes, types…" />
            <StatTile label="edges" value={meta.stats.imports + meta.stats.tests} hint={`${meta.stats.imports} imports · ${meta.stats.tests} test links`} />
            <StatTile label="last built" value={<span className="text-[15px]">{new Date(meta.builtAt).toLocaleString()}</span>} hint="rebuilt when the repo changes" />
          </StatGrid>

          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <SectionLabel as="div">Hotspots</SectionLabel>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <IncludeTests checked={tests} onChange={setTests} />
                <span className="text-xs text-muted">score = 4 × misses + log2(1 + churn) + log2(1 + dependents)</span>
              </span>
            </div>
            {rows.length === 0 ? (
              <p className="py-3 text-muted">The map has no files yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-sm border border-line">
                <table className={`${tableClass} text-[13px]`}>
                  <thead>
                    <tr>
                      {(Object.keys(LABEL) as SortKey[]).map((k) => (
                        <SortHeader key={k} k={k} sort={sort} onSort={sortBy} className={k === 'path' ? 'min-w-[14rem]' : 'w-[5.5rem] text-right'} />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(all ? rows : rows.slice(0, ROWS)).map((h) => (
                      <tr key={h.path} className={`last:[&>td]:border-b-0 ${open === h.path ? 'bg-selected' : 'hover:bg-sunken'}`}>
                        <td className={`${tdClass} min-w-0`}>
                          <button type="button" aria-expanded={open === h.path} onClick={() => setOpen(open === h.path ? null : h.path)} className="text-left font-mono text-[12px] [overflow-wrap:anywhere] text-accent-text hover:underline">
                            {h.path}
                          </button>
                        </td>
                        <Num>{h.churn}</Num>
                        <Num strong={h.misses > 0}>{h.misses}</Num>
                        <Num>{h.dependents}</Num>
                        <Num strong>{h.score.toFixed(2)}</Num>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length > ROWS && (
              <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setAll(!all)}>{all ? `Show the top ${ROWS}` : `Show all ${rows.length}`}</Button>
            )}
          </div>

          {open && <ModulePanel projectKey={projectKey} path={open} onOpen={setOpen} onClose={() => setOpen(null)} />}
        </>
      )}
    </Card>
  );
}

function SortHeader({ k, sort, onSort, className = '' }: { k: SortKey; sort: Sort; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort.key === k;
  return (
    <th aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined} className={`${thClass} ${className}`}>
      <button type="button" title={HINT[k]} onClick={() => onSort(k)} className={`inline-flex items-center gap-1 whitespace-nowrap uppercase hover:text-text ${active ? 'text-text' : ''}`}>
        {LABEL[k]}
        <ChevronIcon size={10} className={`${active ? '' : 'opacity-0'} ${sort.desc ? 'rotate-90' : '-rotate-90'}`} />
      </button>
    </th>
  );
}

const Num = ({ children, strong = false }: { children: ReactNode; strong?: boolean }) => (
  <td className={`${tdClass} text-right tabular-nums ${strong ? 'font-semibold' : 'text-muted'}`}>{children}</td>
);

/**
 * One file of the map: what it is, its symbols, who imports it and what it imports, its tests, and the lessons and
 * misses tied to it. The Graph page's Code mode shows it too, `narrow` (one column) in its side panel.
 */
export function ModulePanel({ projectKey, path, onOpen, onClose, narrow = false }: { projectKey: string; path: string; onOpen: (p: string) => void; onClose: () => void; narrow?: boolean }) {
  const [m, setM] = useState<ModuleContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    setM(null);
    setError(null);
    let stale = false;
    api.codeModule(projectKey, path).then((r) => { if (!stale) setM(r); }, (e) => { if (!stale) setError(e instanceof Error ? e.message : String(e)); });
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    return () => { stale = true; };
  }, [projectKey, path]);

  const fileLink = (p: string) => (
    <button type="button" onClick={() => onOpen(p)} className="text-left font-mono text-[12px] [overflow-wrap:anywhere] text-accent-text hover:underline">{p}</button>
  );

  return (
    <section ref={ref} aria-label={`module ${path}`} className="grid gap-3 rounded-md border border-line-strong bg-surface p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[13px] font-semibold [overflow-wrap:anywhere]">{path}</div>
          {m && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <span>{m.file.lang}</span>
              <span className="tabular-nums">{plural(m.file.loc, 'line')}</span>
              <span className="tabular-nums">{m.file.churn ? `${plural(m.file.churn.commits, 'commit')} in 90 days, last ${m.file.churn.lastTs.slice(0, 10)}` : 'no commits in 90 days'}</span>
              {m.file.isTest && <Badge tone="info">test file</Badge>}
            </div>
          )}
        </div>
        <Button size="sm" variant="ghost" aria-label="close module" onClick={onClose}><CloseIcon size={13} /></Button>
      </header>

      {error ? (
        <Alert>{error}</Alert>
      ) : !m ? (
        <SkeletonDetail />
      ) : (
        <div className={`grid gap-3 ${narrow ? '' : 'md:grid-cols-2'}`}>
          <Part title="What it is" wide={!narrow} count={m.facts.length} empty="No facts yet: Scan the project to have a model read this file.">
            {m.facts.map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-x-2">
                <Badge>{f.kind.replace('_', ' ')}</Badge>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{f.statement}</span>
                {f.lines && <span className="font-mono text-[11px] text-muted">{f.lines}</span>}
              </li>
            ))}
          </Part>

          <Part title="Symbols" count={m.symbols.length} empty="No symbols found.">
            {m.symbols.map((s, i) => (
              <li key={`${s.id}:${i}`} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[12px] [overflow-wrap:anywhere]">{s.name}</span>
                <span className="text-xs text-muted">{s.kind} · {s.lines}</span>
                {s.exported && <Badge tone="accent">exported</Badge>}
              </li>
            ))}
          </Part>

          <Part title="Imported by" count={m.importers.length} empty="No file in the map imports it.">
            {m.importers.map((p) => <li key={p}>{fileLink(p)}</li>)}
          </Part>

          <Part title="Imports" count={m.imports.length} empty="It imports nothing.">
            {m.imports.map((i) => (
              <li key={i.to} className="flex flex-wrap items-baseline gap-x-2">
                {i.to.startsWith('pkg:') ? <span className="font-mono text-[12px] text-muted">{i.to}</span> : fileLink(i.to)}
                {i.names.length > 0 && <span className="min-w-0 text-xs [overflow-wrap:anywhere] text-muted">{i.names.join(', ')}</span>}
              </li>
            ))}
          </Part>

          <Part title="Tests that cover it" count={m.tests.length} empty="No test imports it, directly or through one file.">
            {m.tests.map((p) => <li key={p}>{fileLink(p)}</li>)}
          </Part>

          <Part title="Approved lessons" count={m.lessons.length} empty="No approved lesson is tied to this file.">
            {m.lessons.map((l) => (
              <li key={l.id} className="grid gap-0.5">
                <a href={lessonHref(l.id)} className="font-medium text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{l.title}</a>
                <span className="text-xs text-muted [overflow-wrap:anywhere]">{l.rule}</span>
              </li>
            ))}
          </Part>

          <Part title="Past misses" wide={!narrow} count={m.misses.length} empty="No confirmed miss has edited this file.">
            {[...m.misses].reverse().map((x) => (
              <li key={x.missId} className="grid gap-1 border-l-2 border-line pl-2.5">
                <span className="[overflow-wrap:anywhere]">{x.missed}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <CauseBadge cause={x.cause} />
                  {x.fixedHere && <Badge tone="ok">fixed here</Badge>}
                  <span className="tabular-nums">{x.ts.slice(0, 10)}</span>
                  <a href={inboxHref(x.feedbackId)} className="underline decoration-line-strong underline-offset-2 hover:text-text">your feedback</a>
                  {x.lessonId && <a href={lessonHref(x.lessonId)} className="underline decoration-line-strong underline-offset-2 hover:text-text">its lesson</a>}
                </span>
              </li>
            ))}
          </Part>
        </div>
      )}
    </section>
  );
}

function Part({ title, count, empty, wide = false, children }: { title: string; count: number; empty: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`grid content-start gap-1.5 ${wide ? 'md:col-span-2' : ''}`}>
      <SectionLabel as="div">{title} ({count})</SectionLabel>
      {count ? <ul className="grid max-h-64 gap-1.5 overflow-y-auto">{children}</ul> : <p className="text-xs text-muted">{empty}</p>}
    </div>
  );
}
