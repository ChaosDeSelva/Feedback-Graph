import { useEffect, useRef, useState } from 'react';
import { FACT_KINDS, type FactKind } from '@fb/core/types';
import { ActivityEntry } from './Activity.tsx';
import { CodeMap } from './CodeMap.tsx';
import { ImportBundle } from './ImportBundle.tsx';
import { api, type Activity, type DocSummary, type ProjectSummary, type StoredFact } from './api.ts';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, buttonClass, Input, Select } from './ui/controls.tsx';
import { Alert, Badge, Card, EmptyState, plural, SkeletonDetail, SkeletonList, StatGrid, StatTile, StatusBadge } from './ui/display.tsx';
import { DownloadIcon, FolderIcon, SearchIcon, UploadIcon } from './ui/icons.tsx';

/** '' means "worker default" (SCAN_LLM), so the request body stays empty. */
const PROVIDERS = [
  { value: '', label: 'default (SCAN_LLM)' },
  { value: 'ollama:gemma4', label: 'ollama · gemma4 (free, local)' },
  { value: 'claude-cli', label: 'Claude Code (subscription)' },
  { value: 'codex-cli', label: 'Codex (subscription)' },
];

export function Projects({ pollMs = 5000 }: { pollMs?: number } = {}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [facts, setFacts] = useState<StoredFact[] | null>(null);
  const [kind, setKind] = useState<FactKind | ''>('');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [error, setError] = useState<string | null>(null);
  // On a phone the list and the project take turns; this is true while the project is showing.
  const [open, setOpen] = useState(false);

  const load = () => api.projects().then((ps) => {
    setProjects(ps);
    setSelected((s) => s ?? ps.find((p) => p.facts > 0)?.key ?? ps[0]?.key ?? null);
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
                <li key={p.key}>
                  <ListRow selected={p.key === selected} onClick={() => { setSelected(p.key); setOpen(true); }}>
                    <div className="truncate text-[13px] font-medium">{p.key}</div>
                    {p.remote && <div className="truncate font-mono text-[11px] text-muted">{p.remote}</div>}
                    <div className="truncate text-xs text-muted tabular-nums">
                      {plural(p.sessions, 'session')} · {plural(p.lessons, 'lesson')} · {plural(p.facts, 'fact')}
                      {p.lastScan && ` · scan ${p.lastScan.status}`}
                    </div>
                  </ListRow>
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
                <StatTile label="facts" value={current.facts} hint="extracted from the code" />
              </StatGrid>

              {current.lastScan && (
                <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-surface px-3 py-2 text-xs shadow-card ${current.lastScan.status === 'failed' ? 'border-bad/50' : 'border-line'}`}>
                  <span className="font-medium">Last scan</span>
                  <StatusBadge status={current.lastScan.status} />
                  <span className="font-mono text-muted">{current.lastScan.provider ?? 'default'}</span>
                  <span className="text-muted tabular-nums">{current.lastScan.filesScanned} files</span>
                  <span className="text-muted tabular-nums">{current.lastScan.factsAdded} facts</span>
                  {current.lastScan.error && <div className="w-full text-bad-text">{current.lastScan.error}</div>}
                </div>
              )}

              <CodeMap projectKey={current.key} />

              <Card
                title="Code facts"
                actions={
                  <>
                    <form onSubmit={search} className="relative">
                      <SearchIcon size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
                      <Input aria-label="search facts" size="sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by meaning…" className="w-52 pl-7" />
                    </form>
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
                  <ul>{facts.map((f) => <FactCard key={f.id} f={f} projectKey={current.key} />)}</ul>
                )}
              </Card>

              <Docs projectKey={current.key} onError={setError} />

              <DataControls projectKey={current.key} onDeleted={() => { setSelected(null); setFacts([]); load(); }} onError={setError} />
            </div>
          )}
        </div>
      </SplitPane>
    </div>
  );
}

/** A fact plus, on demand, how it came to exist: the model, its reason, the scan and file version, and the scan log. */
function FactCard({ f, projectKey }: { f: StoredFact; projectKey: string }) {
  const [log, setLog] = useState<Activity[] | null>(null);
  const [open, setOpen] = useState(false);
  function toggle() {
    setOpen(!open);
    if (!log) api.activity({ target: `${projectKey}:${f.path}`, kind: 'facts_extracted', limit: 10 }).then(setLog, () => setLog([]));
  }
  return (
    <li className="border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="min-w-0 font-mono text-[11.5px] [overflow-wrap:anywhere] text-accent-text">{f.path}{f.lines ? `:${f.lines}` : ''}</span>
        <span className="flex items-center gap-2 text-muted">
          <Badge>{f.kind.replace('_', ' ')}</Badge>
          <span className="tabular-nums">{Math.round(f.confidence * 100)}%</span>
          <span className="font-mono text-[11px]">{f.source}</span>
        </span>
      </div>
      <p className="mt-1 text-[13.5px] [overflow-wrap:anywhere]">{f.statement}</p>
      <button type="button" aria-expanded={open} onClick={toggle} className="mt-1 text-xs text-muted underline decoration-line-strong underline-offset-2 hover:text-text">
        how was this created?
      </button>
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

const readText = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(f);
  });

/** The server only accepts plain file names. */
const safeName = (n: string) => n.replace(/[^\w .()-]/g, '_').replace(/^[^\w]+/, '') || 'document.txt';

/** Context that isn't code: your uploads, PR discussions and tickets synced for this project. */
function Docs({ projectKey, onError }: { projectKey: string; onError: (e: string) => void }) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const load = (stale = () => false) => api.docs(projectKey).then((d) => { if (!stale()) setDocs(d); }, (e) => { if (!stale()) onError(String(e)); });
  useEffect(() => {
    let stale = false;
    load(() => stale);
    return () => { stale = true; };
  }, [projectKey]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) await api.uploadDoc(projectKey, { title: f.name, name: safeName(f.name), text: await readText(f) });
      await load();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteDoc(id);
      setDocs((ds) => ds.filter((d) => d.id !== id));
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <Card
      title={`Docs and discussions (${docs.length})`}
      actions={
        <label className={buttonClass('secondary', 'sm', `cursor-pointer focus-within:outline-2 focus-within:outline-focus ${busy ? 'opacity-60' : ''}`)}>
          <UploadIcon size={13} />
          {busy ? 'uploading…' : 'upload text / markdown'}
          <input aria-label="upload document" type="file" multiple accept=".md,.txt,.markdown,.rst,.json,.yaml,.yml,.csv,text/*" className="sr-only" onChange={(e) => upload(e.target.files)} disabled={busy} />
        </label>
      }
    >
      <ul>
        {docs.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-b-0 hover:bg-sunken">
            <span className="flex min-w-0 items-center gap-2">
              <Badge>{d.source}</Badge>
              <span className="truncate">
                {d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:text-accent-text">{d.title}</a> : d.title}
              </span>
              <span className="shrink-0 text-xs text-muted tabular-nums">{d.chunks} chunks</span>
            </span>
            <Button size="sm" variant="ghost" aria-label={`remove ${d.title}`} onClick={() => remove(d.id)} className="hover:text-bad-text">remove</Button>
          </li>
        ))}
        {docs.length === 0 && <li className="px-3 py-3 text-muted">No docs yet. Upload specs or notes; agents get matching excerpts with their task context.</li>}
      </ul>
    </Card>
  );
}

/** Take the project's knowledge with you (export), or remove all of it (delete, confirmed by typing the name). */
function DataControls({ projectKey, onDeleted, onError }: { projectKey: string; onDeleted: () => void; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOpen(false); setTyped(''); }, [projectKey]);
  async function remove() {
    setBusy(true);
    try {
      await api.deleteProject(projectKey);
      onDeleted();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Your data" bodyClass="grid gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href={api.exportUrl(projectKey)} className={buttonClass('secondary', 'sm')}><DownloadIcon size={13} />Export lessons, misses and facts (JSON)</a>
        <Button size="sm" variant="danger-outline" aria-expanded={open} onClick={() => setOpen(!open)}>Delete project data…</Button>
      </div>
      {open && (
        <div className="grid gap-2.5 rounded-md border border-bad/50 bg-bad-soft p-3 text-xs">
          <p>
            This removes every session, flag, decision, post-mortem, lesson, fact, document and log entry for <b>{projectKey}</b>. It cannot be undone.
            New sessions in this folder will be read again unless you add it to <code className="font-mono">EXCLUDE_PROJECTS</code>.
          </p>
          <Input aria-label="type the project name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={projectKey} className="max-w-xs" />
          <Button variant="danger" onClick={remove} disabled={typed !== projectKey || busy} className="justify-self-start">
            {busy ? 'deleting…' : `Delete everything learned from ${projectKey}`}
          </Button>
        </div>
      )}
    </Card>
  );
}
