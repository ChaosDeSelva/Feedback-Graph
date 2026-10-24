import { useEffect, useState, type ReactNode } from 'react';
import { api, type ProjectSummary, type SessionDetail, type SessionListItem, type SessionState } from './api.ts';
import { hashFocus, inboxHref, lessonHref } from './links.ts';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, Select } from './ui/controls.tsx';
import { ago, Alert, Badge, Card, EmptyState, plural, SectionLabel, SkeletonDetail, SkeletonList, StatusBadge, tableClass, tdClass, thClass, type Tone } from './ui/display.tsx';
import { SessionIcon } from './ui/icons.tsx';

const STATE_TONE: Record<SessionState, Tone> = { active: 'info', idle: 'neutral' };
const STATE_TITLE: Record<SessionState, string> = {
  active: 'turns are still coming in, or came in recently',
  idle: 'quiet for a while and summarized to its last turn: complete for now',
};

const when = (ts: string | null) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown');

function StateBadge({ state }: { state: SessionState }) {
  return <Badge tone={STATE_TONE[state]} dot title={STATE_TITLE[state]}>{state}</Badge>;
}

export function Sessions() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState('');
  const [state, setState] = useState<SessionState | ''>('');
  const [items, setItems] = useState<SessionListItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => hashFocus('sessions'));
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(() => !!hashFocus('sessions'));
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => { api.projects().then(setProjects, () => {}); }, []);

  useEffect(() => {
    setItems(null);
    setError(null);
    // The answer for filters you have left must not fill the list for the ones you picked.
    let stale = false;
    api.sessions({ project: project || undefined, state: state || undefined }).then((p) => {
      if (stale) return;
      setItems(p.sessions);
      setNext(p.next);
      setSelected((cur) => cur ?? p.sessions[0]?.id ?? null);
    }, (e) => { if (!stale) { setError(String(e)); setItems([]); } });
    return () => { stale = true; };
  }, [project, state]);

  useEffect(() => {
    setDetail(null);
    setNotice(null);
    if (!selected) return;
    let stale = false;
    api.sessionDetail(selected).then((d) => { if (!stale) setDetail(d); }, (e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [selected]);

  async function more() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const p = await api.sessions({ project: project || undefined, state: state || undefined, cursor: next });
      setItems((xs) => [...(xs ?? []), ...p.sessions]);
      setNext(p.next);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function resummarize() {
    if (!detail) return;
    setError(null);
    try {
      await api.resummarize(detail.id);
      setDetail({ ...detail, rebuildRequested: true });
      setNotice('Queued: the worker rebuilds this summary from the first turn on its next pass. The current one stays until then.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const filtered = !!(project || state);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Sessions"
        description="What each agent session set out to do, did, decided and left open, summarized as it goes."
        actions={
          <>
            <Select aria-label="project" value={project} onChange={(e) => { setProject(e.target.value); setSelected(null); }} className="w-40">
              <option value="">all projects</option>
              {projects.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
            </Select>
            <Select aria-label="state" value={state} onChange={(e) => { setState(e.target.value as SessionState | ''); setSelected(null); }} className="w-32">
              <option value="">any state</option>
              <option value="active">active</option>
              <option value="idle">idle</option>
            </Select>
          </>
        }
      />
      <SplitPane
        listLabel="sessions"
        listWidth="24rem"
        listHeader={items && <span className="text-xs text-muted tabular-nums">{plural(items.length, 'session')}{next ? '+' : ''}</span>}
        detailOpen={open && !!selected}
        onBack={() => setOpen(false)}
        notice={error && <Alert>{error}</Alert>}
        list={
          items === null ? <SkeletonList /> : items.length === 0 ? (
            <EmptyState compact icon={<SessionIcon />} title={filtered ? 'No sessions match these filters' : 'No sessions yet'}
              action={filtered ? <Button size="sm" onClick={() => { setProject(''); setState(''); }}>Clear filters</Button> : undefined}>
              {filtered ? 'Try another project or state.' : 'Sessions of the projects selected in Settings appear here once the worker has read them.'}
            </EmptyState>
          ) : (
            <>
            <ul>
              {items.map((s) => (
                <li key={s.id}>
                  <ListRow selected={s.id === selected} onClick={() => { setSelected(s.id); setOpen(true); }}>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="truncate">{s.projectKey} · {s.source} · {plural(s.turnCount, 'turn')}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {s.pendingTurns > 0 && s.summarizedThrough && <Badge tone="accent">{s.pendingTurns} new</Badge>}
                        <StateBadge state={s.state} />
                      </span>
                    </div>
                    <div className={`mt-0.5 line-clamp-2 text-[13px] leading-snug ${s.snippet ? '' : 'text-muted italic'}`}>{s.snippet ?? 'Not summarized yet'}</div>
                    <div className="mt-0.5 text-xs text-muted" title={when(s.lastActivityAt)}>{s.lastActivityAt ? ago(s.lastActivityAt) : 'no activity time'}</div>
                  </ListRow>
                </li>
              ))}
            </ul>
            {next && (
              <div className="px-3 py-2.5">
                <Button size="sm" onClick={more} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</Button>
              </div>
            )}
            </>
          )
        }
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6">
          {error && <Alert className="mb-4">{error}</Alert>}
          {detail ? <Detail s={detail} notice={notice} onResummarize={resummarize} /> : selected ? <SkeletonDetail /> : null}
        </div>
      </SplitPane>
    </div>
  );
}

function List({ title, items, mono = false }: { title: string; items: string[]; mono?: boolean }) {
  if (!items.length) return null;
  return (
    <section className="grid gap-1.5">
      <SectionLabel>{title}</SectionLabel>
      <ul className="grid gap-1 pl-4 text-[13.5px] leading-relaxed [list-style:disc]">
        {items.map((x) => <li key={x} className={`[overflow-wrap:anywhere] ${mono ? 'font-mono text-xs' : ''}`}>{x}</li>)}
      </ul>
    </section>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return <div className="contents"><dt className="text-muted">{label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd></div>;
}

function Detail({ s, notice, onResummarize }: { s: SessionDetail; notice: string | null; onResummarize: () => void }) {
  const sum = s.summary;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{s.projectKey}</Badge>
          <Badge>{s.source === 'codex' ? 'Codex' : 'Claude Code'}</Badge>
          <StateBadge state={s.state} />
          {s.rebuildRequested && <Badge tone="info">rebuild queued</Badge>}
        </div>
        <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">{sum?.goal || 'Not summarized yet'}</h2>
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <Meta label="session"><span className="font-mono">{s.id}</span></Meta>
          {s.gitBranch && <Meta label="branch"><span className="font-mono">{s.gitBranch}</span></Meta>}
          <Meta label="started">{when(s.startedAt)}</Meta>
          <Meta label="last activity">{when(s.lastActivityAt)}</Meta>
          <Meta label="summarized">
            {s.summarizedThrough
              ? `through turn ${s.summarizedThrough.index} of ${s.turnCount}${s.pendingTurns ? ` · ${plural(s.pendingTurns, 'newer turn')} waiting` : ''}`
              : `not yet · ${plural(s.turnCount, 'turn')} waiting`}
          </Meta>
          {s.summaryModel && <Meta label="by">{<span className="font-mono">{s.summaryModel}</span>}{s.summaryUpdatedAt ? ` · ${when(s.summaryUpdatedAt)}` : ''}</Meta>}
        </dl>
      </header>

      {notice && <div role="status" className="rounded-md border border-line bg-sunken px-3 py-2 text-xs">{notice}</div>}
      {s.summaryError && (
        <Alert>
          The last update failed: {s.summaryError}.{s.summaryRetryAt ? ` It is tried again after ${when(s.summaryRetryAt)}.` : ''} The summary below is the last good one.
        </Alert>
      )}

      {sum ? (
        <Card title="Summary" bodyClass="grid gap-4 p-3.5">
          {sum.outcome && (
            <section className="grid gap-1.5">
              <SectionLabel>Where it stands</SectionLabel>
              <p className="text-[13.5px] [overflow-wrap:anywhere]">{sum.outcome}</p>
            </section>
          )}
          <List title="Done" items={sum.done} />
          <List title="Decisions" items={sum.decisions} />
          <List title="Open threads" items={sum.openThreads} />
          <List title="Pushback" items={sum.pushback} />
          <List title="Files touched" items={sum.filesTouched} mono />
          <p className="text-xs text-muted">Written by a model from the session transcript, redacted, and kept on this machine: never exported or synced.</p>
        </Card>
      ) : (
        <EmptyState icon={<SessionIcon />} title="Not summarized yet">
          The worker summarizes a session once it has been quiet for a few minutes, or sooner when many turns are waiting. Older sessions are summarized a few at a time, newest first.
        </EmptyState>
      )}

      {s.inbox.length > 0 && (
        <Card title="Flagged in this session">
          <ul>
            {s.inbox.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
                <StatusBadge status={k.status} />
                {k.label && <Badge>{k.label}</Badge>}
                <a href={inboxHref(k.id)} className="min-w-0 flex-1 text-[13px] text-accent-text hover:underline [overflow-wrap:anywhere]">{k.summary || k.id}</a>
                {k.lessonId && <a href={lessonHref(k.lessonId)} className="text-xs text-accent-text hover:underline">lesson ({k.lessonStatus})</a>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {s.history.length > 0 && (
        <Card title="Update history">
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr><th className={thClass}>#</th><th className={thClass}>Turns</th><th className={thClass}>New</th><th className={thClass}>Model</th><th className={thClass}>When</th></tr>
              </thead>
              <tbody>
                {[...s.history].reverse().map((u) => (
                  <tr key={u.version} className="last:[&>td]:border-b-0">
                    <td className={`${tdClass} tabular-nums`}>{u.version}</td>
                    <td className={`${tdClass} tabular-nums`}>{u.from ? u.from.index + 1 : 0}–{u.to.index}{u.rebuild ? <Badge className="ml-1.5" tone="info">rebuild</Badge> : null}</td>
                    <td className={`${tdClass} tabular-nums`}>{u.deltaTurns}</td>
                    <td className={`${tdClass} font-mono text-xs`}>{u.model}</td>
                    <td className={`${tdClass} text-xs text-muted`}>{when(u.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onResummarize} disabled={s.rebuildRequested || s.turnCount === 0}>Rebuild summary</Button>
        <span className="text-xs text-muted">Summarizes the whole session again from its first turn, replacing the merged one.</span>
      </div>
    </div>
  );
}
