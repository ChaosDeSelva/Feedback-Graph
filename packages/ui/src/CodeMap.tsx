import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type CodeMapMeta, type CodeMapReport, type Hotspot, type MapCapped, type ModuleContext } from './api.ts';
import { inboxHref, lessonHref, moduleHref } from './links.ts';
import { Button } from './ui/controls.tsx';
import { scrollIntoPane } from './ui/scroll.ts';
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
  score: '4 × misses + log2(1 + churn) + log2(1 + dependents); docs and config files score 0 until a miss touches them',
};

/**
 * Whether the map is capped (SCAN_MAX_FILES): the API's answer when it gave one, else from the counted total. A map
 * built before the total was counted (candidates null) is capped only by the API's answer, `of: null`.
 */
export function mapCap(meta: CodeMapMeta | null | undefined, capped?: MapCapped): MapCapped {
  if (capped !== undefined) return capped;
  if (!meta || meta.candidates == null || meta.candidates <= meta.stats.files) return null;
  return { files: meta.stats.files, of: meta.candidates };
}

/** "400 of 10,290 files", or "capped at 4,000 files" when the total was not counted; null when the map is not capped. */
export function mapCapNote(meta: CodeMapMeta | null | undefined, capped?: MapCapped): string | null {
  const c = mapCap(meta, capped);
  if (!c) return null;
  return c.of !== null ? `${c.files.toLocaleString()} of ${c.of.toLocaleString()} files` : `capped at ${c.files.toLocaleString()} files`;
}
/** Names read A to Z; numbers read biggest first. */
const defaultSort = (key: SortKey): Sort => ({ key, desc: key !== 'path' });
const ROWS = 25;
/** The module route's answer for a file the map does not hold (GET /api/projects/:key/codemap/module, 404). */
const NOT_MAPPED = /not in the code map/;

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
/** How long the card waits for a rebuilt map before it stops asking. */
const REBUILD_WAIT_MS = 15 * 60_000;

export function CodeMap({ projectKey, initialModule = null, focus = null, pollMs = 5000 }: {
  projectKey: string;
  /** How often the card asks for the new map after Rebuild map, until it arrives. */
  pollMs?: number;
  initialModule?: string | null;
  /** Open this file's panel (a fact's file name was clicked); `at` makes the same file asked again a new request. */
  focus?: { path: string; at: number } | null;
}) {
  const [report, setReport] = useState<CodeMapReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(defaultSort('score'));
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(initialModule);
  const [tests, setTests] = useState(false);
  // Every score 0: the table would only list docs and config by path, so it waits behind a button.
  const [showZero, setShowZero] = useState(false);
  useEffect(() => { if (focus) setOpen(focus.path); }, [focus?.path, focus?.at]);
  // The panel a link asked for survives the first load only (run twice in StrictMode); any other project or filter closes it.
  const linked = useRef(initialModule ? projectKey : null);
  const [rebuild, setRebuild] = useState<{ busy: boolean; said: string | null; error: string | null }>({ busy: false, said: null, error: null });
  // After Rebuild map: the builtAt of the map it replaces; the card polls until a map with another one arrives.
  const [awaiting, setAwaiting] = useState<{ builtAt: string | null; since: number } | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    if (linked.current !== projectKey || tests) {
      linked.current = null;
      setOpen(null);
    }
    setAll(false);
    setShowZero(false);
    setRebuild({ busy: false, said: null, error: null });
    setAwaiting(null);
    let stale = false;
    api.codeMap(projectKey, undefined, tests).then((r) => { if (!stale) setReport({ meta: r?.meta ?? null, hotspots: r?.hotspots ?? [], capped: r?.capped }); }, (e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [projectKey, tests]);

  useEffect(() => {
    if (!awaiting) return;
    let stale = false;
    const t = setInterval(() => {
      if (Date.now() - awaiting.since > REBUILD_WAIT_MS) {
        setAwaiting(null);
        setRebuild({ busy: false, said: 'The worker has not rebuilt the map yet: it may be busy with a long job. Reload this page later to see it.', error: null });
        return;
      }
      api.codeMap(projectKey, undefined, tests).then((r) => {
        if (stale || !r?.meta || r.meta.builtAt === awaiting.builtAt) return;
        setReport({ meta: r.meta, hotspots: r.hotspots ?? [], capped: r.capped });
        setAwaiting(null);
        setRebuild({ busy: false, said: `Map rebuilt ${new Date(r.meta.builtAt).toLocaleString()}.`, error: null });
      }, () => {});
    }, pollMs);
    return () => { stale = true; clearInterval(t); };
  }, [awaiting, projectKey, tests, pollMs]);

  const rows = useMemo(() => {
    const hs = [...(report?.hotspots ?? [])];
    const by = (a: Hotspot, b: Hotspot) => (sort.key === 'path' ? a.path.localeCompare(b.path) : a[sort.key] - b[sort.key]);
    return hs.sort((a, b) => (sort.desc ? -by(a, b) : by(a, b)) || a.path.localeCompare(b.path));
  }, [report, sort]);
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : defaultSort(key)));

  const meta = report?.meta;
  const cap = mapCap(meta, report?.capped);
  const cappedAt = mapCapNote(meta, report?.capped);
  const askRebuild = () => {
    setRebuild({ busy: true, said: null, error: null });
    api.rebuildCodeMap(projectKey).then(
      () => {
        setRebuild({ busy: false, said: 'Rebuild queued: the worker remaps this project from scratch at its next pass (a minute or so). This card updates when the new map is in.', error: null });
        setAwaiting({ builtAt: meta?.builtAt ?? null, since: Date.now() });
      },
      (e) => setRebuild({ busy: false, said: null, error: e instanceof Error ? e.message : String(e) }),
    );
  };
  return (
    <Card
      title="Code map"
      bodyClass="grid gap-3 p-3"
      actions={meta ? (
        <Button size="sm" onClick={askRebuild} disabled={rebuild.busy || !!awaiting} title="remap this project from scratch, whether or not the repo changed">
          Rebuild map
        </Button>
      ) : undefined}
    >
      {error && <Alert>{error}</Alert>}
      {rebuild.error && <Alert>{rebuild.error}</Alert>}
      {rebuild.said && <p role="status" className="text-xs text-muted">{rebuild.said}</p>}
      {!report && !error ? (
        <SkeletonList rows={3} />
      ) : !meta ? (
        <EmptyState title="No code map yet">
          The worker maps each selected project's code (files, imports, tests and recent churn) within a few minutes, and again whenever the repo changes.
        </EmptyState>
      ) : (
        <>
          <StatGrid className="grid-cols-2 sm:grid-cols-4">
            <StatTile
              label="files"
              value={cap?.of != null ? <span>{meta.stats.files.toLocaleString()} <span className="text-[13px] font-normal text-muted">of {cap.of.toLocaleString()}</span></span> : meta.stats.files.toLocaleString()}
              hint={cap?.of != null ? 'mapped, of the files worth mapping' : cap ? 'mapped, at the cap' : 'mapped source files'}
            />
            <StatTile label="symbols" value={meta.stats.symbols} hint="functions, classes, types…" />
            <StatTile label="edges" value={meta.stats.imports + meta.stats.tests} hint={`${meta.stats.imports} imports · ${meta.stats.tests} test links`} />
            <StatTile label="last built" value={<span className="text-[15px]">{new Date(meta.builtAt).toLocaleString()}</span>} hint="rebuilt when the repo changes" />
          </StatGrid>
          {cap && (
            <p role="note" className="rounded-md border border-line bg-sunken px-3 py-2 text-xs text-muted">
              {cap.of !== null
                ? `Showing ${cappedAt}: the map is capped`
                : `The map is ${cappedAt}; it was built before the total was counted, so Rebuild map to see how many it leaves out`}
              , keeping source and the files your sessions edited first. Files past the cap have no
              hotspot, module panel or impact. To map more, raise SCAN_MAX_FILES (unset, it is 40% of the files, between 400 and 4,000).
            </p>
          )}

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
            ) : rows.every((h) => h.score === 0) && !showZero ? (
              <div className="flex flex-wrap items-center gap-2 py-2 text-muted">
                <span>No hotspots yet: no file has misses, recent commits or importers, so every score is 0.</span>
                <Button size="sm" variant="ghost" onClick={() => setShowZero(true)}>Show the files anyway</Button>
              </div>
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
            {rows.length > ROWS && (showZero || rows.some((h) => h.score > 0)) && (
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
  // A file the map does not hold (404 "not in the code map"): cap is the map's cap note when it is capped, else null.
  const [outside, setOutside] = useState<{ cap: string | null } | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    setM(null);
    setError(null);
    let stale = false;
    setOutside(null);
    api.codeModule(projectKey, path).then((r) => { if (!stale) setM(r); }, (e) => {
      if (stale) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (!NOT_MAPPED.test(msg)) return setError(msg);
      // Not in the map: say why, from whether the map is capped (the API's own words stay out of it).
      api.codeMap(projectKey, 1).then((r) => { if (!stale) setOutside({ cap: mapCapNote(r.meta, r.capped) }); }, () => { if (!stale) setOutside({ cap: null }); });
    });
    scrollIntoPane(ref.current, { smooth: true });
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
        <span className="flex shrink-0 items-center gap-1">
          <a href={moduleHref(projectKey, path)} aria-label="link to this file" title="a link that opens this panel" className="px-1 text-xs text-muted underline decoration-line-strong underline-offset-2 hover:text-text">link</a>
          <Button size="sm" variant="ghost" aria-label="close module" onClick={onClose}><CloseIcon size={13} /></Button>
        </span>
      </header>

      {error ? (
        <Alert>{error}</Alert>
      ) : outside ? (
        <p role="note" className="text-[13px] text-muted">
          {outside.cap
            ? <>This file is past the code map's cap: the map {outside.cap.startsWith('capped') ? 'is' : 'keeps'} {outside.cap}, the ones it ranks first (files sessions edited, then source code over config and docs), so it has no symbols, importers or tests here. Raise <code className="font-mono">SCAN_MAX_FILES</code> and rebuild the map to include it.</>
            : <>This file is not in the code map: the map does not read it (ignored by git, a lock file or secret, too large, in a skipped folder, or not a code, docs or config file), or it is newer than the map. Rebuild map to check again.</>}
        </p>
      ) : !m ? (
        <SkeletonDetail />
      ) : (
        <div className={`grid gap-3 ${narrow ? '' : 'md:grid-cols-2'}`}>
          <Part title="What it is" wide={!narrow} count={m.facts.length} empty="No scan fact cites this file. A scan's facts are filed under the files they cite; project-wide ones are on the Projects page.">
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
