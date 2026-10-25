import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Candidate, type CandidateDetail as Detail, type CandidateStatus, type FeedbackSource } from './api.ts';
import { isSelfReview } from '@fb/core/feedback-rules';
import { SelfReviewBadge, SOURCE_LABEL, SourceBadge } from './CandidateDetail.tsx';
import { CandidateDetail } from './CandidateDetail.tsx';
import { FirstRun } from './FirstRun.tsx';
import { hashFocus } from './links.ts';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, buttonClass, Input, Select, Tabs } from './ui/controls.tsx';
import { Alert, Badge, Card, EmptyState, Kbd, plural, SkeletonDetail, SkeletonList } from './ui/display.tsx';
import { InboxIcon } from './ui/icons.tsx';

const TABS: CandidateStatus[] = ['pending', 'confirmed', 'rejected'];

/**
 * An order that does not move under you during a long triage: pending items by when they arrived in the Inbox (oldest
 * first, so new arrivals join the end), decided ones by when you decided (latest first); the id breaks ties. The API
 * orders by the turn's own time, which a comment synced later can place anywhere in the list.
 */
function stableOrder(status: CandidateStatus, c: Candidate[]): Candidate[] {
  const byId = (a: Candidate, b: Candidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (status === 'pending') return [...c].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || byId(a, b));
  return [...c].sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt) || byId(a, b));
}

export function Inbox() {
  // A link to one item (#inbox/<id>, from a module panel) opens it in the tab of its status; a link to a tab
  // (#inbox/confirmed, from the Dashboard) opens that tab.
  const [link] = useState(() => hashFocus('inbox'));
  const tabLink = TABS.find((t) => t === link);
  const focus = tabLink ? null : link;
  const [status, setStatus] = useState<CandidateStatus>(tabLink ?? 'pending');
  const [project, setProject] = useState('');
  const [all, setItems] = useState<Candidate[]>([]);
  // Where the feedback came from: a Claude Code or Codex session, or a comment on GitHub or Linear. Filtered here.
  const [source, setSource] = useState<FeedbackSource | ''>('');
  const items = source ? all.filter((c) => (c.source ?? 'claude') === source) : all;
  useEffect(() => { setSelected(0); setOpen(false); }, [source]);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // On a phone the list and the item take turns; this is true while the item is showing.
  const [open, setOpen] = useState(false);
  // Every project, not just those in the list on screen: a filtered or empty list must not shrink the filter's choices.
  const [allProjects, setAllProjects] = useState<string[]>([]);
  useEffect(() => { api.projects().then((ps) => setAllProjects(ps.map((p) => p.key)), () => {}); }, []);
  // One decision at a time: until it is saved the list has not moved on, so a second one would land on the same item.
  const deciding = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (focus) api.candidate(focus).then((d) => { if (d?.candidate) setStatus(d.candidate.status); }).catch(() => {});
  }, [focus]);

  useEffect(() => {
    setLoaded(false);
    setOpen(false);
    setError(null);
    // The answer for a tab or project you have left must not fill the one you are on.
    let stale = false;
    api.candidates(status, project || undefined).then((c) => {
      if (stale) return;
      c = stableOrder(status, c);
      const at = focus ? c.findIndex((x) => x.id === focus) : -1;
      setItems(c);
      setSelected(Math.max(0, at));
      setOpen(at >= 0);
      setLoaded(true);
    }, (e) => { if (!stale) { setError(String(e)); setLoaded(true); } });
    return () => { stale = true; };
  }, [status, project]);

  const current = items[selected];
  useEffect(() => {
    setDetail(null);
    setNote('');
    setError(null);
    if (!current) return;
    // A slow answer for an item you have moved past must not replace the one you are looking at.
    let stale = false;
    api.candidate(current.id).then((d) => { if (!stale) setDetail(d); }, (e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [current?.id]);
  // You decide on what you have read: only once the pane shows this very item.
  const ready = !!current && detail?.candidate.id === current.id;

  const decide = useCallback(
    async (decision: 'confirmed' | 'rejected') => {
      if (!current || !ready || deciding.current) return;
      deciding.current = true;
      setBusy(true);
      setError(null);
      try {
        await api.decide(current.id, decision, note.trim() || undefined);
        setItems((xs) => xs.filter((x) => x.id !== current.id));
        setSelected((i) => Math.min(i, items.length - 2));
      } catch (e) {
        setError(String(e));
      } finally {
        deciding.current = false;
        setBusy(false);
      }
    },
    [current, ready, note, items.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return; // Cmd+C copies, Ctrl+R reloads: never a decision
      if (deciding.current) return; // the list moves on once the decision is saved; until then keys would hit the wrong item
      if (e.key === 'j') setSelected((i) => Math.min(i + 1, items.length - 1));
      else if (e.key === 'k') setSelected((i) => Math.max(i - 1, 0));
      else if (e.key === 'c' && status === 'pending') void decide('confirmed');
      else if (e.key === 'r' && status === 'pending') void decide('rejected');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, items.length, status]);

  // The project list's own order (pinned first), then any other project an item names.
  const projects = [...new Set([...allProjects, ...[...items.map((i) => i.projectKey), ...(project ? [project] : [])].sort()])];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Inbox"
        description="Possible pushback from your sessions and from comments on your pull requests and Linear issues. Confirm the real misses; only those are learned from."
        actions={
          <>
            <Select aria-label="source" value={source} onChange={(e) => setSource(e.target.value as FeedbackSource | '')} className="w-36">
              <option value="">all sources</option>
              {(Object.keys(SOURCE_LABEL) as FeedbackSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
            </Select>
            <Select aria-label="project" value={project} onChange={(e) => setProject(e.target.value)} className="w-44">
              <option value="">all projects</option>
              {projects.map((p) => <option key={p}>{p}</option>)}
            </Select>
          </>
        }
      />
      <SplitPane
        listLabel="feedback"
        listHeader={
          <>
            <Tabs label="status" value={status} options={TABS} onChange={setStatus} />
            {loaded && <span className="ml-auto text-xs text-muted tabular-nums">{plural(items.length, 'item')}</span>}
          </>
        }
        detailOpen={open && items.length > 0}
        onBack={() => setOpen(false)}
        notice={error && <Alert>{error}</Alert>}
        list={
          !loaded ? <SkeletonList /> : items.length === 0 ? (
            status === 'pending' ? <PendingEmpty /> : (
              <EmptyState compact icon={<InboxIcon />} {...EMPTY[status]} action={status === 'confirmed' ? <Button size="sm" onClick={() => setStatus('pending')}>Show pending</Button> : undefined} />
            )
          ) : (
            <ul>
              {items.map((c, i) => (
                <li key={c.id}>
                  <ListRow selected={i === selected} onClick={() => { setSelected(i); setOpen(true); }}>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="flex min-w-0 items-center gap-1.5"><SourceBadge source={c.source} />{c.external && isSelfReview(c.external) && <SelfReviewBadge />}<span className="truncate">{c.projectKey}</span></span>
                      <span className="tabular-nums" title="how sure the classifier is that this is pushback">{Math.round(c.classification.confidence * 100)}% sure</span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug">{c.classification.summary || '(no summary)'}</div>
                  </ListRow>
                </li>
              ))}
            </ul>
          )
        }
        listFooter={
          status === 'pending' && items.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
              <span className="flex items-center gap-1"><Kbd>j</Kbd><Kbd>k</Kbd> move</span>
              <span className="flex items-center gap-1"><Kbd>c</Kbd> confirm</span>
              <span className="flex items-center gap-1"><Kbd>r</Kbd> reject</span>
            </div>
          )
        }
      >
        <div className="flex min-h-full flex-col">
          <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-5 md:px-6">
            {error && <Alert className="mb-4">{error}</Alert>}
            {detail ? (
              <>
                <AgentReportNote candidate={detail.candidate} />
                <CandidateDetail detail={detail} />
                {status === 'confirmed' && <PostmortemState detail={detail} onError={setError} />}
              </>
            ) : current ? (
              <SkeletonDetail />
            ) : loaded && status === 'pending' && (project || source) ? (
              // Filtered to nothing: where the pipeline stands for this project (or, filtered by source, overall).
              <div className="-mx-4 -mt-5 md:-mx-6"><FirstRun view="inbox" project={project || undefined} force /></div>
            ) : null}
          </div>
          {detail && status === 'pending' && (
            <div className="sticky bottom-0 border-t border-line bg-surface/95 backdrop-blur">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center md:px-6">
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note (optional): what was actually missed?"
                  className="w-full sm:flex-1"
                />
                <div className="flex shrink-0 gap-2">
                  <Button variant="primary" disabled={busy} onClick={() => decide('confirmed')} className="flex-1 sm:flex-none">
                    Confirm <Kbd>c</Kbd>
                  </Button>
                  <Button disabled={busy} onClick={() => decide('rejected')} className="flex-1 sm:flex-none">
                    Reject <Kbd>r</Kbd>
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </SplitPane>
    </div>
  );
}

const EMPTY: Record<CandidateStatus, { title: string; children: string }> = {
  pending: { title: 'No feedback waiting', children: 'When you push back on an agent in a session, it lands here within a minute. If it stays empty, check the worker badge in the sidebar.' },
  confirmed: { title: 'Nothing confirmed yet', children: 'Confirm pending items to send them for a post-mortem.' },
  rejected: { title: 'Nothing rejected', children: 'Items you reject stay here, so you can change your mind later.' },
};

/**
 * Nothing pending. Says why when it can: no project selected (go to Settings), or turns the classifier gave up on
 * (say, while its model was missing), which can be re-queued.
 */
function PendingEmpty() {
  const [st, setSt] = useState<{ tracked: number | null; roots: number | null; givenUp: number } | null>(null);
  const [requeued, setRequeued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.status().then((s) => setSt({ tracked: s.selection?.tracked ?? null, roots: s.selection?.roots ?? null, givenUp: s.givenUpTurns ?? 0 }), () => setSt(null));
  }, []);
  async function requeue() {
    try {
      setRequeued((await api.requeueTurns()).requeued);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  if (st?.roots === 0) {
    return (
      <EmptyState compact icon={<InboxIcon />} title="No project folders yet" action={<a href="#settings" className={buttonClass('secondary', 'sm')}>Open Settings</a>}>
        Nothing can be read until a folder holding your projects is mounted. Add a project folder in Settings first.
      </EmptyState>
    );
  }
  if (st?.tracked === 0) {
    return (
      <EmptyState compact icon={<InboxIcon />} title="Nothing is being read" action={<a href="#settings" className={buttonClass('secondary', 'sm')}>Open Settings</a>}>
        No projects are selected yet, so no sessions are being read. Choose the project folders to read in Settings.
      </EmptyState>
    );
  }
  const given = !!st?.givenUp && requeued === null;
  return (
    <EmptyState
      compact
      icon={<InboxIcon />}
      {...EMPTY.pending}
      action={
        error ? <Alert>{error}</Alert>
          : requeued !== null ? <p className="text-muted">{plural(requeued, 'turn')} re-queued; the classifier tries them again on its next cycle.</p>
          : given ? <Button size="sm" onClick={requeue}>Re-queue {plural(st!.givenUp, 'turn')} that {st!.givenUp === 1 ? 'was' : 'were'} given up</Button>
          : undefined
      }
    />
  );
}

/**
 * An agent reported this miss with report_feedback (from /postmortem, or one the developer did not put in words). When
 * the detector flagged the same miss, the two are one item (core dedupe.ts) and both sources are named.
 */
function AgentReportNote({ candidate }: { candidate: Candidate }) {
  const r = candidate.agentReport;
  if (!candidate.origins?.includes('agent') || !r) return null;
  const both = candidate.origins.includes('detector');
  return (
    <Card title={both ? 'Reported by the agent and found by the detector' : 'Reported by the agent'} className="mb-4" bodyClass="grid gap-1.5 px-3 py-2.5">
      <p className="[overflow-wrap:anywhere]">{r.text}</p>
      {r.whatWasDone && <p className="text-xs text-muted [overflow-wrap:anywhere]">What it had done: {r.whatWasDone}</p>}
      <p className="text-xs text-muted tabular-nums">{new Date(r.reportedAt).toLocaleString()}</p>
    </Card>
  );
}

/** Where the learning from a confirmed item stands, with a retry when the post-mortem gave up. */
function PostmortemState({ detail, onError }: { detail: Detail; onError: (e: string) => void }) {
  const pm = detail.postmortem;
  const [retried, setRetried] = useState(false);
  if (!pm) return null;
  async function retry() {
    try {
      await api.retryPostmortem(detail.candidate.id);
      setRetried(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }
  const text = pm.done
    ? 'Post-mortem done: its lesson is waiting on the Lessons page.'
    : retried
      ? 'Queued: the worker will run the post-mortem again shortly.'
      : pm.gaveUp
        ? `The post-mortem failed ${pm.attempts} times and stopped trying.`
        : pm.attempts
          ? `The post-mortem failed ${pm.attempts} time${pm.attempts === 1 ? '' : 's'}; next try ${pm.retryAt ? new Date(pm.retryAt).toLocaleTimeString() : 'soon'}.`
          : 'Waiting for the worker to run the post-mortem.';
  const tone = pm.done ? 'ok' : retried ? 'info' : pm.gaveUp ? 'bad' : pm.attempts ? 'bad' : 'info';
  const label = pm.done ? 'done' : retried ? 'queued' : pm.gaveUp ? 'gave up' : pm.attempts ? 'retrying' : 'waiting';
  return (
    <Card title="Post-mortem" actions={<Badge tone={tone} dot>{label}</Badge>} className={`mt-6 ${pm.gaveUp && !retried ? 'border-bad/50' : ''}`} bodyClass="grid gap-2 px-3 py-2.5">
      <div>{text}</div>
      {pm.lastError && !pm.done && !retried && <div className="rounded-sm bg-sunken px-2 py-1.5 font-mono text-xs [overflow-wrap:anywhere] text-muted">last error: {pm.lastError}</div>}
      {!pm.done && !retried && pm.attempts > 0 && (
        <div><Button size="sm" onClick={retry}>Retry post-mortem now</Button></div>
      )}
    </Card>
  );
}
