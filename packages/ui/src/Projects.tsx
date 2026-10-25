import { useEffect, useRef, useState } from 'react';
import { hashModule } from './links.ts';
import { FACT_KINDS, UNSCORED_RELEVANCE, type FactEvidence, type FactKind } from '@fb/core/types';
import { relevanceBand, type RelevanceBand } from '@fb/core/relevance';
import { ActivityEntry } from './Activity.tsx';
import { CodeMap } from './CodeMap.tsx';
import { ImportBundle } from './ImportBundle.tsx';
import { ProjectDocs } from './ProjectDocs.tsx';
import { ProjectLinks } from './ProjectLinks.tsx';
import { api, type Activity, type ProjectSummary, type StoredFact } from './api.ts';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, buttonClass, Input, Select } from './ui/controls.tsx';
import { Alert, Badge, Card, EmptyState, plural, SkeletonDetail, SkeletonList, StatGrid, StatTile, StatusBadge } from './ui/display.tsx';
import { ChevronIcon, DownloadIcon, FolderIcon, PinIcon, SearchIcon, UploadIcon } from './ui/icons.tsx';

/** '' means "worker default" (SCAN_LLM), so the request body stays empty. */
const PROVIDERS = [
  { value: '', label: 'default (SCAN_LLM)' },
  { value: 'ollama:gemma4', label: 'ollama · gemma4 (free, local)' },
  { value: 'claude-cli', label: 'Claude Code (subscription)' },
  { value: 'codex-cli', label: 'Codex (subscription)' },
];

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/**
 * Where a project's queued scan stands: 1 runs next. Scans waiting out a retry are not ahead of it (the worker passes
 * over them until then); null when its scan is not queued or is itself waiting. Approximate: the worker may also pass
 * over an agentic scan while another agentic one runs.
 */
export function queuePosition(projects: ProjectSummary[], key: string, now = Date.now()): number | null {
  const due = (j: ProjectSummary['lastScan']) => !!j && j.status === 'queued' && (!j.retryAt || Date.parse(j.retryAt) <= now);
  const queue = projects.map((p) => p.lastScan).filter(due).sort((a, b) => (a!.requestedAt < b!.requestedAt ? -1 : a!.requestedAt > b!.requestedAt ? 1 : a!.id < b!.id ? -1 : 1));
  const mine = projects.find((p) => p.key === key)?.lastScan;
  const i = mine ? queue.findIndex((j) => j!.id === mine.id) : -1;
  return i < 0 ? null : i + 1;
}

export function Projects({ pollMs = 5000 }: { pollMs?: number } = {}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  // A module link (#projects/<key>/<path>, from Ask or the Dashboard) opens on that project with the file's panel open.
  const [link] = useState(hashModule);
  const [selected, setSelected] = useState<string | null>(link?.project ?? null);
  const [facts, setFacts] = useState<StoredFact[] | null>(null);
  const [kind, setKind] = useState<FactKind | ''>('');
  const [sort, setSort] = useState<'file' | 'relevance'>('relevance');
  // A fact's file name opens its module panel in the code map card; `at` makes the same file clicked again a new ask.
  const [moduleFocus, setModuleFocus] = useState<{ path: string; at: number } | null>(null);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [error, setError] = useState<string | null>(null);
  // On a phone the list and the project take turns; this is true while the project is showing.
  const [open, setOpen] = useState(!!link);

  const load = () => api.projects().then((ps) => {
    setProjects(ps);
    setSelected((s) => (s && ps.some((p) => p.key === s) ? s : null) ?? ps.find((p) => p.facts > 0)?.key ?? ps[0]?.key ?? null);
  }, (e) => { setError(String(e)); setProjects((ps) => ps ?? []); });
  useEffect(() => { load(); }, []);

  const current = projects?.find((p) => p.key === selected);
  const scanning = current?.lastScan && ['queued', 'running'].includes(current.lastScan.status);

  // Refetch when the selection or filter changes, and when a scan finishes (its status flips to done).
  const scanState = current?.lastScan ? `${current.lastScan.id}:${current.lastScan.status}` : '';
  // Only the latest facts request may fill the card: a slow one for a project or search you have left is dropped.
  const factsReq = useRef(0);
  useEffect(() => {
    if (!selected) return;
    setQuery('');
    const n = ++factsReq.current;
    api.facts(selected, { kind: kind || undefined }).then((f) => { if (n === factsReq.current) setFacts(f); }, (e) => { if (n === factsReq.current) { setError(String(e)); setFacts([]); } });
  }, [selected, kind, scanning ? '' : scanState]);
  useEffect(() => { setFacts(null); }, [selected]);

  // Poll while a scan is in flight so progress and new facts show up.
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [scanning, pollMs]);

  async function scan() {
    if (!current) return;
    try {
      const job = await api.scan(current.key, provider || undefined);
      setProjects((ps) => ps && ps.map((p) => (p.key === current.key ? { ...p, lastScan: job } : p)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function pin(p: ProjectSummary) {
    try {
      await api.pinProject(p.key, !p.pinned);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function setRelevance(f: StoredFact, relevance: number) {
    if (!selected) return;
    try {
      await api.setFactRelevance(selected, f.id, relevance);
      setFacts((fs) => fs && fs.map((x) => (x.id === f.id ? { ...x, relevance, relevanceBy: 'you' } : x)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const n = ++factsReq.current;
    api.facts(selected, query.trim() ? { q: query.trim() } : { kind: kind || undefined }).then((f) => { if (n === factsReq.current) setFacts(f); }, (err) => { if (n === factsReq.current) setError(String(err)); });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Projects" description="The code map, code facts, docs and your data for each project folder the worker reads." actions={<ImportBundle onImported={load} />} />
      <SplitPane
        listLabel="projects"
        listWidth="19rem"
        listHeader={<span className="text-xs text-muted tabular-nums">{projects ? plural(projects.length, 'project') : 'Projects'}</span>}
        detailOpen={open && !!current}
        onBack={() => setOpen(false)}
        notice={error && <Alert>{error}</Alert>}
        list={
          !projects ? <SkeletonList /> : (
            <ul>
              {projects.map((p) => (
                <li key={p.key} className="relative">
                  <ListRow selected={p.key === selected} onClick={() => { setSelected(p.key); setOpen(true); }}>
                    <div className="truncate pr-7 text-[13px] font-medium">{p.key}</div>
                    {p.remote && <div className="truncate font-mono text-[11px] text-muted">{p.remote}</div>}
                    <div className="truncate text-xs text-muted tabular-nums">
                      {plural(p.sessions, 'session')} · {plural(p.lessons, 'lesson')} · {plural(p.facts, 'fact')}
                      {p.lastScan && ` · scan ${p.lastScan.status}`}
                    </div>
                  </ListRow>
                  <PinButton project={p} onToggle={() => pin(p)} className="absolute top-2 right-2" />
                </li>
              ))}
              {projects.length === 0 && (
                <li className="px-3 py-4 text-xs text-muted">No project folders found under the configured roots.</li>
              )}
            </ul>
          )
        }
      >
        <div className="mx-auto w-full max-w-4xl px-4 py-5 md:px-6">
          {error && <Alert className="mb-4">{error}</Alert>}
          {!projects ? (
            <SkeletonDetail />
          ) : !current ? (
            <EmptyState icon={<FolderIcon />} title="No project selected">
              Projects appear once the worker has read a session from their folder. Pick one on the left to scan its code and manage its docs.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-4">
              <header className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{current.key}</h2>
                  <div className="font-mono text-[11.5px] [overflow-wrap:anywhere] text-muted">{current.repoPath}</div>
                  {current.aliases.length > 0 && <div className="text-xs text-muted">also cloned in {current.aliases.join(", ")}</div>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="md" aria-pressed={current.pinned} onClick={() => pin(current)} title={current.pinned ? 'pinned: listed first everywhere' : 'pin to list it first everywhere'}>
                    <PinIcon size={13} filled={current.pinned} />
                    {current.pinned ? 'Pinned' : 'Pin'}
                  </Button>
                  <Select aria-label="provider" value={provider} onChange={(e) => setProvider(e.target.value)} className="w-56">
                    {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </Select>
                  <Button variant="primary" onClick={scan} disabled={!!scanning}>Scan</Button>
                </div>
              </header>

              <StatGrid className="grid-cols-2 sm:grid-cols-4">
                <StatTile label="sessions" value={current.sessions} hint="read from this folder" />
                <StatTile label="feedback" value={current.feedback} hint="pushback flagged" />
                <StatTile label="lessons" value={current.lessons} hint="drawn from confirmed misses" />
                {current.factsByOrigin
                  ? <StatTile label="facts" value={current.factsByOrigin.model} hint={`read from the code by a model; ${current.factsByOrigin.manifest} from manifests, ${current.factsByOrigin.document} from documents${current.factsByOrigin.you ? `, ${current.factsByOrigin.you} you wrote` : ''}`} />
                  : <StatTile label="facts" value={current.facts} hint="extracted from the code" />}
              </StatGrid>

              {current.lastScan && (
                <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-surface px-3 py-2 text-xs shadow-card ${current.lastScan.status === 'failed' ? 'border-bad/50' : 'border-line'}`}>
                  <span className="font-medium">Last scan</span>
                  <StatusBadge status={current.lastScan.status} />
                  <span className="font-mono text-muted">{current.lastScan.provider ?? 'default'}</span>
                  <span className="text-muted tabular-nums">{current.lastScan.filesScanned} files</span>
                  <span className="text-muted tabular-nums">{current.lastScan.factsAdded} facts</span>
                  {current.lastScan.shards && (
                    <span className="text-muted tabular-nums" title="An agentic scan runs once per package or service; one whose files did not change keeps its facts">
                      {current.lastScan.shards.rescanned} of {current.lastScan.shards.total} shards rescanned
                      {current.lastScan.shards.failed ? `, ${current.lastScan.shards.failed} failed` : ''}
                    </span>
                  )}
                  {(() => {
                    const pos = current.lastScan.status === 'queued' ? queuePosition(projects, current.key) : null;
                    return pos !== null && <span className="text-muted">{pos === 1 ? 'next in the queue' : `${ordinal(pos)} in the queue`}</span>;
                  })()}
                  {current.lastScan.status === 'queued' && current.lastScan.retryAt && (
                    <span className="text-muted">
                      retrying {new Date(current.lastScan.retryAt).toLocaleTimeString()}
                      {current.lastScan.attempts ? ` (attempt ${current.lastScan.attempts + 1})` : ''}
                    </span>
                  )}
                  {current.lastScan.error && <div className="w-full text-bad-text">{current.lastScan.error}</div>}
                </div>
              )}

              <ProjectLinks projectKey={current.key} projects={projects.map((p) => p.key)} onError={setError} />

              <CodeMap projectKey={current.key} initialModule={current.key === link?.project ? link.path : null} focus={moduleFocus} />

              <Card
                title="Code facts"
                actions={
                  <>
                    <form onSubmit={search} className="relative">
                      <SearchIcon size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
                      <Input aria-label="search facts" size="sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by meaning…" className="w-52 pl-7" />
                    </form>
                    <Select aria-label="sort facts" size="sm" value={sort} onChange={(e) => setSort(e.target.value as 'file' | 'relevance')}>
                      <option value="file">by file</option>
                      <option value="relevance">by relevance</option>
                    </Select>
                    <Select aria-label="kind" size="sm" value={kind} onChange={(e) => setKind(e.target.value as FactKind | '')}>
                      <option value="">all kinds</option>
                      {FACT_KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
                    </Select>
                  </>
                }
              >
                {facts === null ? (
                  <SkeletonList rows={4} />
                ) : facts.length === 0 ? (
                  <EmptyState title="No facts yet" action={<Button onClick={scan} disabled={!!scanning}>Scan this project</Button>}>
                    Scan the code to extract conventions, invariants and gotchas agents should know.
                  </EmptyState>
                ) : (
                  <FactGroups
                    key={`${current.key}:${sort}:${kind}`}
                    facts={facts}
                    sort={sort}
                    render={(f) => (
                      <FactCard key={f.id} f={f} projectKey={current.key} onRelevance={(relevance) => setRelevance(f, relevance)} onOpenFile={(path) => setModuleFocus({ path, at: Date.now() })} />
                    )}
                  />
                )}
              </Card>

              <ProjectDocs projectKey={current.key} onError={setError} pollMs={pollMs} />

              <DataControls projectKey={current.key} onDeleted={() => { setSelected(null); setFacts([]); load(); }} onError={setError} />
            </div>
          )}
        </div>
      </SplitPane>
    </div>
  );
}

/** Pin or unpin from the list, beside the row (a button cannot sit inside the row's own button). */
function PinButton({ project, onToggle, className = '' }: { project: ProjectSummary; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`${project.pinned ? 'unpin' : 'pin'} ${project.key}`}
      aria-pressed={project.pinned}
      title={project.pinned ? 'pinned: listed first everywhere' : 'pin to list it first everywhere'}
      onClick={onToggle}
      className={`grid size-6 place-items-center rounded-sm hover:bg-sunken hover:text-text ${project.pinned ? 'text-accent-text' : 'text-faint'} ${className}`}
    >
      <PinIcon size={13} filled={project.pinned} />
    </button>
  );
}

/** Highest relevance first; unscored facts after the scored ones; the list's own order breaks ties. */
const byRelevance = (facts: StoredFact[]) =>
  facts.map((f, i) => ({ f, i, r: f.relevance ?? -1 })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.f);

const BAND_TONE: Record<RelevanceBand, 'ok' | 'info' | 'neutral'> = { everyday: 'ok', sometimes: 'info', rare: 'neutral', unscored: 'neutral' };
const BAND_HINT: Record<RelevanceBand, string> = {
  everyday: 'needed in most changes: agents get it first',
  sometimes: 'needed for some changes',
  rare: 'rarely needed while coding (setup, tooling): agents get it only when a task is about it',
  unscored: `not scored yet: ranked as middling (${UNSCORED_RELEVANCE}) until the worker scores it`,
};
/** How well a fact's citation was checked when it was saved (older facts have none and show nothing). */
const EVIDENCE_LABEL: Record<FactEvidence, string> = { line: 'line checked', file: 'file only', none: 'not checkable (no file)' };
const EVIDENCE_HINT: Record<FactEvidence, string> = {
  line: 'the cited lines exist and hold what the fact names',
  file: 'the file exists; no lines were cited, or the cited ones did not hold what the fact names',
  none: 'the fact cites no file, so there was nothing to check it against',
};
/** What each button sets: the middle of its band. */
const MARKS: { band: Exclude<RelevanceBand, 'unscored'>; value: number }[] = [
  { band: 'everyday', value: 0.9 },
  { band: 'sometimes', value: 0.55 },
  { band: 'rare', value: 0.15 },
];

/** Files listed at a time; "show more" adds as many again. */
const GROUPS_PAGE = 25;

/**
 * Facts grouped by the file (or document) they are about: by relevance, the file holding the most relevant fact first;
 * by file, A to Z. Only the first group starts open, and 25 files show at a time, so 140 facts do not fill 70 screens.
 */
function FactGroups({ facts, sort, render }: { facts: StoredFact[]; sort: 'file' | 'relevance'; render: (f: StoredFact) => React.ReactNode }) {
  const groups = new Map<string, StoredFact[]>();
  for (const f of sort === 'relevance' ? byRelevance(facts) : facts) {
    const k = f.docId ? `doc:${f.path}` : f.path;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  // byRelevance put each group's best fact first and Map keeps first-seen order, so by relevance the order is right already.
  const list = [...groups.entries()];
  if (sort === 'file') list.sort(([a], [b]) => a.localeCompare(b));
  const [shown, setShown] = useState(GROUPS_PAGE);
  const [open, setOpen] = useState<Set<string>>(() => new Set(list.slice(0, 1).map(([k]) => k)));
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const rest = list.length - shown;
  return (
    <div>
      <ul>
        {list.slice(0, shown).map(([k, fs]) => {
          const isOpen = open.has(k);
          const best = relevanceBand(fs[0].relevance);
          return (
            <li key={k} className="border-b border-line last:border-b-0">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggle(k)}
                className="flex w-full items-center gap-2 bg-sunken/60 px-3 py-1.5 text-left text-xs hover:bg-sunken"
              >
                <ChevronIcon size={10} className={isOpen ? 'rotate-90' : ''} />
                <span className="min-w-0 flex-1 font-mono text-[11.5px] [overflow-wrap:anywhere]">{fs[0].docId ? `document ${fs[0].path}` : fs[0].path} · {plural(fs.length, 'fact')}</span>
                {sort === 'relevance' && <Badge tone={BAND_TONE[best]}>{best}</Badge>}
              </button>
              {isOpen && <ul>{fs.map(render)}</ul>}
            </li>
          );
        })}
      </ul>
      {rest > 0 && (
        <div className="border-t border-line px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + GROUPS_PAGE)}>Show {Math.min(rest, GROUPS_PAGE)} more file{Math.min(rest, GROUPS_PAGE) === 1 ? '' : 's'}</Button>
        </div>
      )}
    </div>
  );
}

/** A statement longer than this is cut short, with "show all". */
const LONG_FACT = 280;

/** A fact plus, on demand, how it came to exist: the model, its reason, the scan and file version, and the scan log. */
function FactCard({ f, projectKey, onRelevance, onOpenFile }: { f: StoredFact; projectKey: string; onRelevance: (relevance: number) => void; onOpenFile?: (path: string) => void }) {
  const [full, setFull] = useState(false);
  const long = f.statement.length > LONG_FACT;
  const band = relevanceBand(f.relevance);
  const [log, setLog] = useState<Activity[] | null>(null);
  const [open, setOpen] = useState(false);
  const yours = f.origin === 'you';
  function toggle() {
    setOpen(!open);
    // A fact from a document was made by its reading; one you wrote by converting a lesson; a code fact by the scan of its file.
    const history = f.docId ? { target: f.docId, kind: 'doc_read' as const }
      : yours ? { target: f.id, kind: 'lesson_to_fact' as const }
      : { target: `${projectKey}:${f.path}`, kind: 'facts_extracted' as const };
    if (!log) api.activity({ ...history, limit: 10 }).then(setLog, () => setLog([]));
  }
  return (
    <li className="border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        {f.docId || !onOpenFile ? (
          <span className="min-w-0 font-mono text-[11.5px] [overflow-wrap:anywhere] text-accent-text">{f.docId ? `from your document ${f.path}` : `${f.path}${f.lines ? `:${f.lines}` : ''}`}</span>
        ) : (
          <button type="button" aria-label={`open module ${f.path}`} title="open its module panel in the code map" onClick={() => onOpenFile(f.path)} className="min-w-0 text-left font-mono text-[11.5px] [overflow-wrap:anywhere] text-accent-text hover:underline">
            {f.path}{f.lines ? `:${f.lines}` : ''}
          </button>
        )}
        <span className="flex items-center gap-2 text-muted">
          <Badge tone={BAND_TONE[band]} title={BAND_HINT[band]}>{band}</Badge>
          <Badge>{f.kind.replace('_', ' ')}</Badge>
          {yours
            ? <Badge tone="accent" title={`written by ${f.source === 'you' ? 'you' : f.source} (a lesson converted to a fact): no scan replaces it`}>yours</Badge>
            : f.origin && f.origin !== 'model' && !f.docId && <Badge title="read from a manifest (package.json, go.mod, a Makefile...) without a model">{f.origin}</Badge>}
          {f.evidence && <span title={EVIDENCE_HINT[f.evidence]}>{EVIDENCE_LABEL[f.evidence]}</span>}
          <span className="font-mono text-[11px]">{f.source}</span>
        </span>
      </div>
      <p className="mt-1 text-[13.5px] [overflow-wrap:anywhere]">
        {long && !full ? `${f.statement.slice(0, LONG_FACT).trimEnd()}…` : f.statement}
        {long && (
          <button type="button" onClick={() => setFull(!full)} className="ml-1.5 text-xs text-muted underline decoration-line-strong underline-offset-2 hover:text-text">{full ? 'show less' : 'show all'}</button>
        )}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <button type="button" aria-expanded={open} onClick={toggle} className="underline decoration-line-strong underline-offset-2 hover:text-text">
          how was this created?
        </button>
        <span className="flex flex-wrap items-center gap-1">
          <span title={f.relevanceBy === 'you' ? (yours ? 'kept: you wrote this fact, and no scan replaces it' : f.docId ? 'kept until the document is uploaded again' : 'kept until a rescan of this file replaces the fact with new ones, scored again') : undefined}>
            relevance{f.relevance !== null ? ` ${f.relevance.toFixed(2)}` : ''}{f.relevanceBy === 'you' ? ', set by you' : ''}:
          </span>
          {MARKS.map((m) => (
            <button
              key={m.band}
              type="button"
              aria-label={`mark ${m.band}`}
              aria-pressed={band === m.band && f.relevanceBy === 'you'}
              onClick={() => onRelevance(m.value)}
              className="rounded-sm border border-line px-1.5 py-px hover:border-line-strong hover:text-text aria-pressed:border-accent aria-pressed:text-accent-text"
            >
              {m.band}
            </button>
          ))}
        </span>
      </div>
      {open && (
        <div className="mt-2 grid gap-2 rounded-sm border border-line bg-sunken p-2.5 text-xs">
          <dl className="grid gap-1 md:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-muted">why it matters</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{f.why || 'the model gave no reason'}</dd>
            <dt className="text-muted">extracted by</dt><dd>{f.source} on {new Date(f.createdAt).toLocaleString()}</dd>
            <dt className="text-muted">from</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-mono">{f.path} @ {f.fileHash?.slice(0, 7) ?? '?'}</span>
              {f.fileSummary && <span className="mt-0.5 block text-muted">{f.fileSummary}</span>}
            </dd>
            <dt className="text-muted">scan</dt><dd className="min-w-0 font-mono [overflow-wrap:anywhere]">{f.scanJobId ?? 'unknown'}</dd>
          </dl>
          {log && log.length > 0 && <ul className="rounded-sm border border-line bg-surface">{log.map((a) => <ActivityEntry key={a.id} a={a} />)}</ul>}
        </div>
      )}
    </li>
  );
}

/** Take the project's knowledge with you (export), or remove all of it (delete, in a dialog, confirmed by typing the name). */
function DataControls({ projectKey, onDeleted, onError }: { projectKey: string; onDeleted: () => void; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { setOpen(false); setFailed(null); }, [projectKey]);
  async function remove() {
    setBusy(true);
    setFailed(null);
    try {
      await api.deleteProject(projectKey);
      setOpen(false);
      onDeleted();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setFailed(why);
      onError(why);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Your data" bodyClass="grid gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href={api.exportUrl(projectKey)} className={buttonClass('secondary', 'sm')}><DownloadIcon size={13} />Export lessons, misses and facts (JSON)</a>
        <Button size="sm" variant="danger-outline" aria-haspopup="dialog" onClick={() => { setFailed(null); setOpen(true); }}>Delete project data…</Button>
      </div>
      <ConfirmDialog
        open={open}
        title={`Delete everything learned from ${projectKey}?`}
        confirmLabel={`Delete everything learned from ${projectKey}`}
        busyLabel="Deleting…"
        busy={busy}
        error={failed}
        typeToConfirm={projectKey}
        onCancel={() => setOpen(false)}
        onConfirm={() => void remove()}
      >
        This removes every session, flag, decision, post-mortem, lesson, fact, document and log entry for <b>{projectKey}</b>. It cannot be undone.
        New sessions in this folder will be read again while it is selected in Settings, unless you add it to <code className="font-mono">EXCLUDE_PROJECTS</code>.
      </ConfirmDialog>
    </Card>
  );
}
