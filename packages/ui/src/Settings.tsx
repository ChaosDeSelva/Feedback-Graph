import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CloudSync } from './CloudSync.tsx';
import { api, CLEANUP_CONFIRM, type ProjectCandidate, type ProjectSettings } from './api.ts';
import { useUnsavedChanges } from './unsaved.ts';
import { PageHeader } from './ui/PageHeader.tsx';
import { Button, Input, Select } from './ui/controls.tsx';
import { ago, Alert, Badge, EmptyState, plural, Skeleton, SkeletonList, tdClass, thClass } from './ui/display.tsx';
import { ChevronIcon, FolderIcon, SearchIcon } from './ui/icons.tsx';


type Filter = 'all' | 'selected' | 'sessions' | 'data';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'selected', label: 'Selected' },
  { key: 'sessions', label: 'With sessions' },
  { key: 'data', label: 'Has data' },
];

type SortKey = 'activity' | 'name' | 'claude' | 'codex';
type Sort = { key: SortKey; desc: boolean };
const SORT_LABEL: Record<SortKey, string> = { activity: 'Last activity', name: 'Folder', claude: 'Claude Code', codex: 'Codex' };
/** Names read A to Z; counts and dates read biggest or newest first. */
const defaultSort = (key: SortKey): Sort => ({ key, desc: key !== 'name' });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Why a saved folder is no longer read, or null. It was tracked, then became another clone (its first session linked it
 * to a project with the same remote) or was added to EXCLUDE_PROJECTS. The server refuses to keep such a key, so it can
 * always be unticked, and saving drops it; nothing is lost, since its sessions were not being read.
 */
function staleReason(c: ProjectCandidate, saved: string[]): string | null {
  if (!saved.includes(c.key)) return null;
  if (c.excluded) return 'it is excluded by EXCLUDE_PROJECTS in .env';
  if (c.aliasOf) return `it is now another clone of ${c.aliasOf}, read with ${c.aliasOf}`;
  return null;
}

/** Why a folder's box cannot be ticked, or null when it can. */
function lockedReason(c: ProjectCandidate, saved: string[]): string | null {
  if (staleReason(c, saved)) return null;
  if (c.excluded) return 'Excluded by EXCLUDE_PROJECTS in .env: never read, whatever is selected.';
  if (c.aliasOf) return `Another clone of ${c.aliasOf}: its sessions are read with ${c.aliasOf}. Select ${c.aliasOf} to read both.`;
  // A folder that is gone can still be unticked (the server lets a tracked key stay or go), never newly ticked.
  if (!c.exists && !saved.includes(c.key)) {
    return c.path ? 'This folder no longer exists, so there is nothing new to read.' : 'Known only from stored data: there is no such folder under your roots.';
  }
  return null;
}

/** Pick the project folders whose Claude Code and Codex sessions are read, and clear out data from the rest. */
export function Settings() {
  const [data, setData] = useState<ProjectSettings | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>(defaultSort('activity'));

  const load = () =>
    api.projectSettings().then(
      (d) => {
        // An older API (or a proxy page) answers with something else: say so instead of crashing.
        if (!Array.isArray(d?.candidates)) return setError('The server did not return the folder list. Is the API up to date?');
        setData(d);
        setDraft(new Set(d.tracked));
      },
      (e) => setError(message(e)),
    );
  useEffect(() => { load(); }, []);

  const saved = data?.tracked ?? [];
  const added = [...draft].filter((k) => !saved.includes(k)).sort();
  const removed = saved.filter((k) => !draft.has(k));
  const dirty = added.length + removed.length > 0;
  useUnsavedChanges(dirty, 'Your folder selection is not saved.');
  // A stale clone row shows its own key, so you can see (and untick) it; any other clone follows its project.
  const selected = (c: ProjectCandidate) => draft.has(staleReason(c, saved) ? c.key : (c.aliasOf ?? c.key));
  const stale = new Set(data?.candidates.filter((c) => staleReason(c, saved)).map((c) => c.key));

  function toggle(key: string) {
    setNotice(null);
    setDraft((d) => {
      const next = new Set(d);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const d = await api.saveProjectSelection([...draft].filter((k) => !stale.has(k)).sort());
      setData(d);
      setDraft(new Set(d.tracked));
      setNotice(`Saved. Reading ${plural(d.tracked.length, 'project')}; added folders are read from the next cycle, and stopped ones keep their data.`);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const keep = (c: ProjectCandidate) =>
      (!q || c.key.toLowerCase().includes(q) || c.path.toLowerCase().includes(q) || !!c.remote?.toLowerCase().includes(q)) &&
      (filter === 'all' ||
        (filter === 'selected' && selected(c)) ||
        (filter === 'sessions' && c.claudeSessions + c.codexSessions > 0) ||
        (filter === 'data' && c.hasData));
    const by = (a: ProjectCandidate, b: ProjectCandidate): number => {
      if (sort.key === 'name') return a.key.localeCompare(b.key);
      if (sort.key === 'claude') return a.claudeSessions - b.claudeSessions;
      if (sort.key === 'codex') return a.codexSessions - b.codexSessions;
      return (a.lastActivity ? Date.parse(a.lastActivity) : 0) - (b.lastActivity ? Date.parse(b.lastActivity) : 0);
    };
    return data.candidates.filter(keep).sort((a, b) => {
      // Folders with no activity at all stay at the bottom whichever way the dates run.
      if (sort.key === 'activity' && !a.lastActivity !== !b.lastActivity) return a.lastActivity ? -1 : 1;
      return (sort.desc ? -by(a, b) : by(a, b)) || a.key.localeCompare(b.key);
    });
  }, [data, draft, query, filter, sort]);

  const counts: Record<Filter, number> = data
    ? {
        all: data.candidates.length,
        selected: data.candidates.filter(selected).length,
        sessions: data.candidates.filter((c) => c.claudeSessions + c.codexSessions > 0).length,
        data: data.candidates.filter((c) => c.hasData).length,
      }
    : { all: 0, selected: 0, sessions: 0, data: 0 };

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : defaultSort(key)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Settings" description="Choose which project folders Feedback Graph reads sessions from." />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl gap-5 p-3 md:p-5">
          {error && (
            <Alert>
              {error}
              {!data && <Button size="sm" className="ml-3" onClick={() => { setError(null); load(); }}>Try again</Button>}
            </Alert>
          )}
          {notice && (
            <div role="status" className="rounded-md border border-ok/40 bg-ok-soft px-3 py-2 text-ok-text">{notice}</div>
          )}

          {!data && !error && <SettingsSkeleton />}

          {data && (!data.initialized || data.tracked.length === 0) && (
            <div className="rounded-md border border-accent-edge/50 bg-accent-soft px-4 py-3">
              <p className="font-semibold">Nothing is being read yet</p>
              <p className="mt-0.5 text-muted">
                No project folders are selected, so no Claude Code or Codex sessions are read and nothing new is learned. Tick the folders you want below,
                then press <b>Save selection</b>.
              </p>
            </div>
          )}

          {data && (
            <section aria-labelledby="settings-folders" className="grid gap-2.5">
              <SectionHead id="settings-folders" title="Project folders">
                Tick a folder to read its Claude Code and Codex sessions. Unticking stops reading it and keeps what was learned.
              </SectionHead>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-64">
                  <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
                  <Input aria-label="search folders" type="search" placeholder="Search folders, paths, remotes" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full pl-8" />
                </div>
                <div role="group" aria-label="filter folders" className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-line bg-sunken p-0.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={filter === f.key}
                      onClick={() => setFilter(f.key)}
                      className={`h-6 rounded-sm px-2.5 text-xs font-medium transition-colors ${
                        filter === f.key ? 'bg-surface text-text shadow-[0_0_0_1px_var(--color-line),var(--shadow-card)]' : 'text-muted hover:text-text'
                      }`}
                    >
                      {f.label}{' '}
                      <span className="ml-0.5 font-mono text-[10.5px] text-muted tabular-nums">{counts[f.key]}</span>
                    </button>
                  ))}
                </div>
                <Select aria-label="sort by" size="sm" value={sort.key} onChange={(e) => setSort(defaultSort(e.target.value as SortKey))} className="w-36 lg:hidden">
                  {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => <option key={k} value={k}>{k === 'name' ? 'Name' : SORT_LABEL[k]}</option>)}
                </Select>
                <span className="ml-auto text-xs text-muted tabular-nums">
                  {rows.length === data.candidates.length ? plural(rows.length, 'folder') : `${rows.length} of ${data.candidates.length} folders`}
                </span>
              </div>

              {(data.builtAt === null || data.codexSessionsFound === false) && (
                <p className="text-xs text-muted">
                  {data.builtAt === null && 'The worker has not counted sessions yet, so every folder shows 0 until its first pass. '}
                  {data.codexSessionsFound === false && 'No Codex sessions folder is mounted (CODEX_SESSIONS_DIR), so Codex counts are 0.'}
                </p>
              )}

              {/* Its own scroll box, so the header stays put and the sections below are a short scroll away even with a hundred folders. */}
              <div className="max-h-[70dvh] overflow-y-auto overscroll-contain rounded-md border border-line bg-surface shadow-card lg:max-h-[min(40rem,68vh)]">
                {data.candidates.length === 0 ? (
                  <EmptyState icon={<FolderIcon />} title="No project folders found">
                    Folders under your project roots appear here once they exist. The roots are listed below.
                  </EmptyState>
                ) : rows.length === 0 ? (
                  <EmptyState icon={<SearchIcon />} title="No folders match" action={<Button onClick={() => { setQuery(''); setFilter('all'); }}>Clear search and filters</Button>}>
                    Try another search or filter.
                  </EmptyState>
                ) : (
                  <table className="w-full border-separate border-spacing-0 text-left max-lg:block lg:table-fixed">
                    <thead className="max-lg:hidden">
                      <tr>
                        <th className={`${thClass} w-11`}><span className="sr-only">Read</span></th>
                        <SortHeader k="name" sort={sort} onSort={sortBy} />
                        <th className={`${thClass} w-[22%]`}>Git remote</th>
                        <SortHeader k="claude" sort={sort} onSort={sortBy} className="w-[7rem] text-right" />
                        <SortHeader k="codex" sort={sort} onSort={sortBy} className="w-[5rem] text-right" />
                        <SortHeader k="activity" sort={sort} onSort={sortBy} className="w-[7.5rem]" />
                        <th className={`${thClass} w-[11rem]`}>Status</th>
                      </tr>
                    </thead>
                    <tbody className="max-lg:block">
                      {rows.map((c) => (
                        <FolderRow key={c.key} c={c} checked={selected(c)} locked={lockedReason(c, saved)} stale={staleReason(c, saved)} change={added.includes(c.key) ? 'add' : removed.includes(c.key) ? 'stop' : null} onToggle={() => toggle(c.key)} />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          )}

          {data && <Sources data={data} />}
          {data && <CloudSync />}
          {data && <Cleanup data={data} dirty={dirty} onDone={load} onError={setError} />}
        </div>
      </div>

      {data && dirty && (
        <div role="region" aria-label="unsaved selection" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-surface px-3 py-2.5 shadow-pop md:px-5">
          <span className="text-[13px] font-medium">Unsaved changes</span>
          <span className="flex flex-wrap gap-1.5 text-xs">
            {added.length > 0 && <Badge tone="ok" title={added.join(', ')}>+{added.length} added</Badge>}
            {removed.length > 0 && <Badge tone="bad" title={removed.join(', ')}>-{removed.length} removed</Badge>}
          </span>
          <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">
            {[...added.map((k) => `+${k}`), ...removed.map((k) => `-${k}`)].join('  ')}
          </span>
          <span className="ml-auto flex gap-2">
            <Button onClick={() => { setDraft(new Set(saved)); setError(null); }} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving' : 'Save selection'}</Button>
          </span>
        </div>
      )}
    </div>
  );
}

function SectionHead({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div>
      <h2 id={id} className="text-[15px] font-semibold tracking-[-0.01em] [font-stretch:92%]">{title}</h2>
      {children && <p className="text-xs text-muted">{children}</p>}
    </div>
  );
}

function SortHeader({ k, sort, onSort, className = '' }: { k: SortKey; sort: Sort; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort.key === k;
  return (
    <th aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined} className={`${thClass} ${className}`}>
      <button type="button" onClick={() => onSort(k)} className={`inline-flex items-center gap-1 whitespace-nowrap uppercase hover:text-text ${active ? 'text-text' : ''}`}>
        {SORT_LABEL[k]}
        <ChevronIcon size={10} className={`${active ? '' : 'opacity-0'} ${sort.desc ? 'rotate-90' : '-rotate-90'}`} />
      </button>
    </th>
  );
}

// Table cells on wide screens; on narrow ones each row becomes a stacked card: box, name and path, then the rest indented under the name.
const cell = `${tdClass} max-lg:border-0 max-lg:p-0`;
const indent = 'max-lg:basis-full max-lg:pl-9';

function FolderRow({ c, checked, locked, stale, change, onToggle }: {
  c: ProjectCandidate; checked: boolean; locked: string | null; stale: string | null; change: 'add' | 'stop' | null; onToggle: () => void;
}) {
  const count = (n: number) => <span className={n ? 'text-text' : 'text-muted'}>{n}</span>;
  return (
    <tr aria-label={c.key} className={`max-lg:flex max-lg:flex-wrap max-lg:items-baseline max-lg:gap-y-1 max-lg:border-b max-lg:border-line max-lg:px-3 max-lg:py-2.5 ${checked ? 'bg-selected/60' : ''}`}>
      <td className={`${cell} max-lg:w-9`}>
        <label title={locked ?? undefined} className={`-m-1 grid size-7 place-items-center rounded-sm ${locked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-hover'}`}>
          <input
            type="checkbox"
            aria-label={`read ${c.key}`}
            checked={checked}
            disabled={!!locked}
            onChange={onToggle}
            className="size-3.5 cursor-[inherit] accent-[var(--color-accent-edge)]"
          />
        </label>
      </td>
      <td className={`${cell} min-w-0 max-lg:w-[calc(100%-2.25rem)]`}>
        <div className={`font-medium [overflow-wrap:anywhere] ${c.excluded || !c.exists ? 'text-muted' : ''}`}>{c.key}</div>
        <div title={c.path || undefined} className="truncate font-mono text-[11px] text-muted">{c.path || 'no folder: known only from stored data'}</div>
        {stale ? (
          <div className="text-xs text-bad-text">Still in your saved selection but not read: {stale}. Untick it, or just save: saving drops it.</div>
        ) : c.aliasOf && <div className="text-xs text-muted">follows {c.aliasOf}: select it to read both</div>}
      </td>
      <td className={`${cell} min-w-0 font-mono text-[11.5px] text-muted ${indent} ${c.remote ? '' : 'max-lg:hidden'}`}>
        <div title={c.remote ?? undefined} className="truncate">{c.remote ?? (c.git ? 'no remote' : 'not git')}</div>
      </td>
      <td className={`${cell} text-right tabular-nums max-lg:pl-9 max-lg:text-left max-lg:text-xs`}>
        {count(c.claudeSessions)}<span className="text-muted lg:hidden"> Claude Code</span>
      </td>
      <td className={`${cell} text-right tabular-nums max-lg:pl-3 max-lg:text-left max-lg:text-xs`}>
        {count(c.codexSessions)}<span className="text-muted lg:hidden"> Codex</span>
      </td>
      <td className={`${cell} text-muted tabular-nums max-lg:pl-3 max-lg:text-xs`}>
        {c.lastActivity ? <span title={new Date(c.lastActivity).toLocaleString()}>{ago(c.lastActivity)}</span> : 'never'}
      </td>
      <td className={`${cell} ${indent}`}>
        <div className="flex flex-wrap gap-1">
          {change === 'add' && <Badge tone="accent">adding</Badge>}
          {change === 'stop' && <Badge tone="accent">stopping</Badge>}
          {c.tracked && !c.aliasOf && <Badge tone="ok" dot>selected</Badge>}
          {c.excluded && <Badge title="EXCLUDE_PROJECTS">excluded</Badge>}
          {c.aliasOf && <Badge tone="info" title={`Sessions here are read with ${c.aliasOf}`}>clone of {c.aliasOf}</Badge>}
          {!c.exists && <Badge tone="bad">missing folder</Badge>}
          {c.hasData && <Badge>has data</Badge>}
        </div>
      </td>
    </tr>
  );
}

function Sources({ data }: { data: ProjectSettings }) {
  const { claudeSessions, codexSessions } = data.outsideRoots;
  return (
    <section aria-labelledby="settings-sources" className="grid gap-2.5">
      <SectionHead id="settings-sources" title="Where folders come from" />
      <div className="grid gap-3 rounded-md border border-line bg-surface p-4 shadow-card md:grid-cols-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Project roots</div>
          {data.roots.length ? (
            <ul className="mt-1 grid gap-0.5">
              {data.roots.map((r) => <li key={r} className="font-mono text-xs [overflow-wrap:anywhere]">{r}</li>)}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">No roots configured.</p>
          )}
          <p className="mt-1 text-xs text-muted">Each folder directly inside a root is listed above.</p>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Outside the roots</div>
          {claudeSessions + codexSessions > 0 ? (
            <>
              <p className="mt-1 font-medium">{claudeSessions} Claude Code and {codexSessions} Codex sessions ran outside your project folders.</p>
              <p className="mt-0.5 text-xs text-muted">They are never read. Add a root (<code className="font-mono">PROJECTS_DIR</code> in <code className="font-mono">.env</code>) to bring them in.</p>
            </>
          ) : (
            <p className="mt-1 text-muted">No sessions ran outside your project folders.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function Cleanup({ data, dirty, onDone, onError }: { data: ProjectSettings; dirty: boolean; onDone: () => void; onError: (e: string | null) => void }) {
  // The server removes every key with data that is not in the saved selection; this is the same set.
  // Data filed under a clone's folder belongs to the project it follows.
  const keys = data.candidates.filter((c) => c.hasData && !data.tracked.includes(c.key) && !(c.aliasOf && data.tracked.includes(c.aliasOf))).map((c) => c.key);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const SHOW = 24;
  const blocked = !data.initialized ? 'Choose and save your folders first: with nothing chosen this would remove everything.' : dirty ? 'Save or cancel your selection first: clean up uses the saved selection.' : null;

  async function run() {
    setBusy(true);
    onError(null);
    try {
      const r = await api.cleanupUnselected();
      setResult(r.removed.length ? `Removed data for ${r.removed.join(', ')} (${plural(r.nodesRemoved, 'node')}).` : 'Nothing to remove: every project with data is selected.');
      setConfirming(false);
      setTyped('');
      onDone();
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="settings-cleanup" className="grid gap-2.5">
      <SectionHead id="settings-cleanup" title="Clean up">
        Unselecting keeps what was learned. This deletes everything stored for projects that have data but are not selected: sessions, feedback, lessons,
        facts and docs.
      </SectionHead>
      <div className="grid gap-3 rounded-md border border-line bg-surface p-4 shadow-card">
        {keys.length ? (
          <ul aria-label="unselected projects with data" className="flex flex-wrap gap-1.5">
            {(showAll ? keys : keys.slice(0, SHOW)).map((k) => <li key={k} className="rounded-sm border border-line bg-sunken px-1.5 py-0.5 font-mono text-xs">{k}</li>)}
            {keys.length > SHOW && (
              <li>
                <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `and ${keys.length - SHOW} more`}</Button>
              </li>
            )}
          </ul>
        ) : (
          <p className="text-muted">Every project with data is selected. There is nothing to remove.</p>
        )}
        {result && <p role="status" className="text-ok-text">{result}</p>}
        {blocked && keys.length > 0 && <p className="text-xs text-muted">{blocked}</p>}
        {confirming && !blocked ? (
          <div className="grid gap-2 rounded-md border border-bad/40 bg-bad-soft p-3">
            <p className="text-bad-text">
              This permanently deletes the data of {plural(keys.length, 'project')}. Type <code className="font-mono font-semibold">{CLEANUP_CONFIRM}</code> to confirm.
            </p>
            <div className="flex flex-wrap gap-2">
              <Input aria-label={`type ${CLEANUP_CONFIRM} to confirm`} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={CLEANUP_CONFIRM} className="w-full font-mono sm:w-56" />
              <Button variant="danger" disabled={typed !== CLEANUP_CONFIRM || busy} onClick={run}>{busy ? 'Removing' : 'Remove data'}</Button>
              <Button variant="ghost" onClick={() => { setConfirming(false); setTyped(''); }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="danger-outline" disabled={!keys.length || !!blocked} onClick={() => { setResult(null); setConfirming(true); }}>
              Remove data for {plural(keys.length, 'unselected project')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function SettingsSkeleton() {
  return (
    <div className="grid gap-2.5">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-96 max-w-full" />
      <div className="flex gap-2"><Skeleton className="h-8 w-64" /><Skeleton className="h-8 w-72" /></div>
      <div className="overflow-hidden rounded-md border border-line bg-surface shadow-card"><SkeletonList rows={8} /></div>
    </div>
  );
}
