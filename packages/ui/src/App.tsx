import { asIs, labelOf } from './labels.ts';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity } from './Activity.tsx';
import { Chat } from './Chat.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Decisions } from './Decisions.tsx';
import { Docs } from './Docs.tsx';
import { api, errorMessage, LOOP_CHANGED_EVENT, loopApi, NETWORK_EVENT, SIGN_IN_EVENT, type NetworkState, type SystemStatus } from './api.ts';
import type { ModelHealth, ModelJob } from '@fb/core';
import { RUNNER_OFF_FIX, runnerOffLine } from '@fb/core/types';
import { FirstRun, stageLine } from './FirstRun.tsx';
import { Graph } from './Graph.tsx';
import { hashView } from './links.ts';
import { Inbox } from './Inbox.tsx';
import { Intake } from './Intake.tsx';
import { LearningLoop } from './LearningLoop.tsx';
import { Lessons } from './Lessons.tsx';
import { Patterns } from './Patterns.tsx';
import { Projects } from './Projects.tsx';
import { Sessions } from './Sessions.tsx';
import { Settings } from './Settings.tsx';
import { afterDiscard } from './unsaved.ts';
import { OwnerWrites } from './ownerAccess.tsx';
import { ConnectionsBadge } from './Connections.tsx';
import { AppShell, type Health, type NavGroup } from './ui/AppShell.tsx';
import { Button, Input } from './ui/controls.tsx';
import { Alert } from './ui/display.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { ActivityIcon, AskIcon, DashboardIcon, DecisionIcon, DocIcon, FolderIcon, GearIcon, GraphIcon, InboxIcon, IntakeIcon, LessonIcon, LoopIcon, Mark, PatternIcon, SessionIcon } from './ui/icons.tsx';

const VIEWS = {
  dashboard: { label: 'Dashboard', el: <Dashboard />, icon: <DashboardIcon /> },
  inbox: { label: 'Inbox', el: <Inbox />, icon: <InboxIcon /> },
  intake: { label: 'Intake', el: <Intake />, icon: <IntakeIcon /> },
  ask: { label: 'Ask', el: <Chat />, icon: <AskIcon /> },
  lessons: { label: 'Lessons', el: <Lessons />, icon: <LessonIcon /> },
  decisions: { label: 'Decisions', el: <Decisions />, icon: <DecisionIcon /> },
  loop: { label: 'Learning loop', el: <LearningLoop />, icon: <LoopIcon /> },
  graph: { label: 'Graph', el: <Graph />, icon: <GraphIcon /> },
  patterns: { label: 'Patterns', el: <Patterns />, icon: <PatternIcon /> },
  sessions: { label: 'Sessions', el: <Sessions />, icon: <SessionIcon /> },
  projects: { label: 'Projects', el: <Projects />, icon: <FolderIcon /> },
  activity: { label: 'Activity', el: <Activity />, icon: <ActivityIcon /> },
  docs: { label: 'Docs', el: <Docs />, icon: <DocIcon /> },
  settings: { label: 'Settings', el: <Settings />, icon: <GearIcon /> },
} as const;
type View = keyof typeof VIEWS;

const item = (key: View, badge?: number) => ({ key, label: VIEWS[key].label, icon: VIEWS[key].icon, badge });
/** The sidebar; `proposals`: the learning loop's decisions waiting for you, a badge on Decisions. `intake`: INTAKE_ENABLED. */
const groups = (proposals?: number, intake = false): NavGroup<View>[] => [
  { label: 'Overview', items: [item('dashboard')] },
  { label: 'Review', items: [item('inbox'), ...(intake ? [item('intake')] : []), item('ask'), item('lessons'), item('decisions', proposals)] },
  { label: 'Insights', items: [item('loop'), item('graph'), item('patterns'), item('sessions')] },
  { label: 'Data', items: [item('projects'), item('activity')] },
  { label: 'Help', items: [item('docs')] },
  { label: 'Setup', items: [item('settings')] },
];

export function App() {
  // Own keys only: a hash such as #constructor names no page (it is on Object.prototype).
  const fromHash = (): View => (Object.hasOwn(VIEWS, hashView()) ? (hashView() as View) : 'dashboard');
  const [view, setView] = useState<View>(fromHash);
  // A link to one item (#lessons/<id>) keeps its id: only a different page rewrites the hash.
  useEffect(() => { if (hashView() !== view) location.hash = view; }, [view]);
  // Leaving a page with unsaved edits (Settings selection, a lesson being edited) asks first.
  const [hashRevision, setHashRevision] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const lastHash = useRef(location.hash);
  const navigate = (next: View) => { if (next !== view) afterDiscard(() => setView(next)); };
  useEffect(() => {
    const onHash = () => {
      const next = fromHash();
      const target = location.hash;
      if (next === viewRef.current) {
        if (target !== lastHash.current && ['inbox', 'intake', 'lessons', 'decisions', 'sessions', 'ask'].includes(next)) setHashRevision(n => n + 1);
        lastHash.current = target;
        return setView(next);
      }
      // Stay put until the answer: put the address back without adding a history entry or firing another hashchange.
      history.replaceState(history.state, '', lastHash.current || `#${viewRef.current}`);
      afterDiscard(() => {
        history.replaceState(history.state, '', target);
        lastHash.current = target;
        setView(next);
      });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [ownerSetupRequired, setOwnerSetupRequired] = useState(false);
  const [canSignOut, setCanSignOut] = useState(false);
  const [ownerWrites, setOwnerWrites] = useState(true);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [proposals, setProposals] = useState<number | undefined>(undefined);
  // Read at start, after signing in or out, with each status poll and when the tab is shown again: an install can gain or
  // lose its tokens while this tab is open, and another tab can sign this browser in, so the read-only state it started
  // with may no longer hold.
  const loadSession = () => api.session().then((s) => {
    setOwnerSetupRequired(!!s.ownerSetupRequired);
    setNeedsSignIn(!!s.authRequired && !s.authenticated);
    setCanSignOut(!!s.authRequired && !!s.ownerSession);
    setOwnerWrites(!!s.authRequired || s.ownerWrites !== false);
  }, () => {});
  useEffect(() => {
    void loadSession();
    const onSignIn = () => setNeedsSignIn(true);
    const onShow = () => { if (document.visibilityState === 'visible') void loadSession(); };
    window.addEventListener(SIGN_IN_EVENT, onSignIn);
    document.addEventListener('visibilitychange', onShow);
    return () => {
      window.removeEventListener(SIGN_IN_EVENT, onSignIn);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, []);
  useEffect(() => {
    if (needsSignIn) return;
    // An API without the learning loop (or one that cannot answer) shows no badge.
    const load = () => Promise.all([
      api.status().then(setStatus, () => setStatus(null)),
      loopApi.state().then((s) => s.counts.proposed).then(setProposals, () => setProposals(undefined)),
    ]);
    void load();
    const t = setInterval(() => { void load(); void loadSession(); }, 30_000);
    const onLoop = () => { void loopApi.state().then((s) => s.counts.proposed).then(setProposals, () => {}); };
    window.addEventListener(LOOP_CHANGED_EVENT, onLoop);
    return () => { clearInterval(t); window.removeEventListener(LOOP_CHANGED_EVENT, onLoop); };
  }, [needsSignIn]);

  if (needsSignIn) return <SignIn ownerSetupRequired={ownerSetupRequired} onDone={() => { setCanSignOut(true); setOwnerWrites(true); setNeedsSignIn(false); void loadSession(); }} />;
  const nothingSelected = !!status?.selection && (!status.selection.initialized || status.selection.tracked === 0);
  return (
    <AppShell
      groups={groups(proposals, !!status?.intake?.enabled)}
      current={view}
      onNavigate={navigate}
      health={health(status)}
      connections={status?.connections ? (collapsed) => <ConnectionsBadge connections={status.connections!} collapsed={collapsed} /> : undefined}
      onSignOut={canSignOut ? () => { void api.signOut().then(() => {
        setSignOutError(null); setCanSignOut(false); setStatus(null); setNeedsSignIn(true); void loadSession();
      }, (error) => setSignOutError(errorMessage(error))); } : undefined}
    >
      {signOutError && <div className="shrink-0 px-4 pt-3 md:px-6"><Alert>Sign out failed: {signOutError}. This browser is still signed in; try again.</Alert></div>}
      {!ownerWrites && <ReadOnlyBanner />}
      <NetworkBanner />
      {nothingSelected && view !== 'settings' && view !== 'docs' && <NothingSelected />}
      {!nothingSelected && (view === 'inbox' || view === 'lessons' || view === 'graph') && <FirstRun key={view} view={view} />}
      <OwnerWrites.Provider value={ownerWrites}>
        <div key={`${view}:${hashRevision}`} className="flex min-h-0 flex-1 flex-col">
          <ViewBoundary label={VIEWS[view].label} onReset={() => {
            // The address may be what broke it (a filter it could not read): back to the page as it opens bare.
            history.replaceState(history.state, '', `#${view}`);
            lastHash.current = `#${view}`;
            setHashRevision((n) => n + 1);
          }}>
            {VIEWS[view].el}
          </ViewBoundary>
        </div>
      </OwnerWrites.Provider>
    </AppShell>
  );
}

/** One page that throws while rendering shows why and a way back, instead of blanking the app with its sidebar. */
class ViewBoundary extends Component<{ label: string; onReset: () => void; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: errorMessage(e) }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <>
        <PageHeader title={this.props.label} />
        <div className="mx-auto grid w-full max-w-xl gap-3 p-4 md:p-6">
          <Alert>{this.props.label} could not be shown: {this.state.error}</Alert>
          <p className="text-[13px] text-muted">Reset this page to open it again without the filters or selection in its address. The other pages still work.</p>
          <Button className="justify-self-start" variant="primary" onClick={this.props.onReset}>Reset this page</Button>
        </div>
      </>
    );
  }
}

// Every job named (satisfies): a job missing here would show its raw key, e.g. "intake unavailable".
const MODEL_NAME = { classify: 'classifier', postmortem: 'post-mortem model', scan: 'scan model', summary: 'summary model', docs: 'docs reader', chat: 'Ask model', intake: 'intake reader' } as const satisfies Record<ModelJob, string>;

function health(status: SystemStatus | null): Health | null {
  if (!status || !('workerHealthy' in status)) return null;
  const idle = status.selection?.note ?? null;
  const w = status.worker;
  // A model that cannot be asked (not running, missing, signed out) is named in the label, not only the tooltip.
  const models = Object.entries(status.models ?? {}) as [keyof typeof MODEL_NAME, ModelHealth][];
  const down = models.find(([, m]) => !m.ok && !m.disabled);
  // Jobs whose Codex runner is turned off on purpose (its safety flag): one neutral line with the fix, not an alarm.
  const off = models.filter(([, m]) => m.disabled);
  const offLine = off.length ? runnerOffLine(off.map(([j]) => j)) : null;
  const offDetail = off.length ? `${offLine} (${off[0][1].reason ?? 'no reason recorded'}). ${RUNNER_OFF_FIX}` : null;
  // Summaries wait for their model rather than fail, so the label says they are paused.
  const modelDown = down && (down[0] === 'summary' ? 'summaries paused' : `${labelOf(MODEL_NAME, down[0], asIs)} unavailable`);
  const since = down?.[1].since ? ` (since ${new Date(down[1].since).toLocaleTimeString()}${down[1].checkedAt ? `, last tried ${new Date(down[1].checkedAt).toLocaleTimeString()}` : ''})` : '';
  const detail = down && `${modelDown}: ${down[1].provider ? `${down[1].provider}: ` : ''}${down[1].reason ?? 'unknown reason'}${since}`;
  const doing = status.workerHealthy && status.stage ? `now: ${stageLine({ stage: status.stage, progress: status.progress ?? null })}` : null;
  // Every embedding comes from Ollama, whatever models the jobs use: without it agents get no context.
  const ollama = status.ollama && !status.ollama.ok ? status.ollama : null;
  const ollamaLabel = ollama && (/not pulled/.test(ollama.reason ?? '') ? 'Ollama model missing' : 'Ollama unreachable');
  const ollamaDetail = ollama && `${ollama.reason ?? `Ollama at ${ollama.url} is not answering`}; search, get_task_context and check_before_done need it`;
  return {
    ok: !!status.graph && status.workerHealthy && !idle && !down && !ollama,
    label: !status.graph ? 'graph unreachable' : !status.workerHealthy ? 'worker offline' : idle ? (status.selection?.roots === 0 ? 'no project folders' : 'no projects selected') : ollamaLabel || modelDown || offLine || 'worker running',
    ...(offLine && !ollama && !down && status.graph && status.workerHealthy && !idle && { off: true, href: '#settings/connections' }),
    version: status.version,
    title: idle ?? [ollamaDetail, detail, offDetail, doing, w
      ? `worker ${w.version}, last heartbeat ${new Date(w.lastBeat).toLocaleTimeString()}${w.lastError ? `, last error: ${w.lastError}` : ''}`
      : 'the worker has not reported yet'].filter(Boolean).join('; '),
  };
}

/**
 * A write the API could not take (it is restarting, or the network dropped): a banner while api.ts retries it, then an
 * alert if it gave up, so a lost decision is never silent.
 */
function NetworkBanner() {
  const [net, setNet] = useState<NetworkState | null>(null);
  useEffect(() => {
    const on = (e: Event) => setNet((e as CustomEvent<NetworkState>).detail);
    window.addEventListener(NETWORK_EVENT, on);
    return () => window.removeEventListener(NETWORK_EVENT, on);
  }, []);
  if (!net || net.state === 'ok') return null;
  if (net.state === 'retrying') {
    return (
      <div role="status" aria-label="connection" className="shrink-0 border-b border-line bg-info-soft px-4 py-2 text-[13px] text-info-text md:px-6">
        Reconnecting to the API: retrying your last change ({net.attempt} of {net.of})…
      </div>
    );
  }
  return (
    <div role="alert" aria-label="connection" className="flex shrink-0 items-center justify-between gap-3 border-b border-bad/40 bg-bad-soft px-4 py-2 text-[13px] text-bad-text md:px-6">
      <span>The API did not answer (it may be restarting), so your last change was not saved. Check the page and try it again.</span>
      <Button size="sm" variant="ghost" onClick={() => setNet(null)}>Dismiss</Button>
    </div>
  );
}

/** A tokenless install reached through Docker: everything can be read, but no owner decision can be made from here. */
function ReadOnlyBanner() {
  return (
    <div role="status" aria-label="read-only" className="shrink-0 border-b border-line bg-accent-soft px-4 py-2 text-[13px] text-accent-text md:px-6">
      Read-only: this install has no owner token, so Inbox decisions, lesson edits, scans, Ask and settings are turned off
      <span className="hidden md:inline"> (the API cannot tell this browser from another program on the machine)</span>. To make them, run{' '}
      <code className="font-mono text-xs [overflow-wrap:anywhere]">./scripts/setup.sh --yes --enable-auth</code> in the install folder, then sign in with{' '}
      <code className="font-mono text-xs">FG_OWNER_TOKEN</code>.
    </div>
  );
}

/** Opt-in: before any project is selected every list is empty, so say why and where to choose. */
function NothingSelected() {
  return (
    <div role="status" aria-label="no projects selected" className="shrink-0 border-b border-line bg-info-soft px-4 py-2 text-[13px] text-info-text md:px-6">
      No projects are selected. Only the projects you select in Settings are shown here (and read).{' '}
      <a href="#settings" className="font-semibold underline underline-offset-2">Settings</a>
    </div>
  );
}

/** Prints a one-time, 60-second localhost link that signs the browser in, so nobody copies the owner token out of .env. */
export const SIGNIN_COMMAND = './scripts/fg signin';

function SignIn({ onDone, ownerSetupRequired = false }: { onDone: () => void; ownerSetupRequired?: boolean }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.signIn(token.trim());
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <main className="grid min-h-full place-items-center px-4 py-12">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-2">
          <Mark size={24} />
          <h1 className="text-lg font-semibold tracking-[-0.01em] [font-stretch:90%]">Feedback Graph</h1>
        </div>
        <div className="grid gap-3 rounded-md border border-line bg-surface p-5 shadow-card">
          <div>
            <p className="font-semibold">{ownerSetupRequired ? 'Owner sign-in needs setup' : 'Sign in'}</p>
            <p className="mt-0.5 text-muted">
              {ownerSetupRequired
                ? <>This upgraded install has an agent token but no owner token. Run <code className="font-mono text-xs">./scripts/setup.sh --yes</code> in the install folder to create <code className="font-mono text-xs">FG_OWNER_TOKEN</code>, restart the API, then reload this page. The agent <code className="font-mono text-xs">API_TOKEN</code> cannot approve owner actions.</>
                : <>This server is protected. In the install folder, run <code className="font-mono text-xs">{SIGNIN_COMMAND}</code> and open the link it prints: it signs this browser in once, within 60 seconds.</>}
            </p>
          </div>
          {!ownerSetupRequired && <>
            <p className="text-xs text-muted">
              Or paste the owner sign-in token (<code className="font-mono">FG_OWNER_TOKEN</code> in its <code className="font-mono">.env</code>). Do not use the agent <code className="font-mono">API_TOKEN</code> here.
            </p>
            <Input aria-label="owner token" type="password" autoComplete="current-password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder="owner token" />
            {error && <Alert>{error}</Alert>}
            <Button type="submit" variant="primary" disabled={!token.trim()}>Sign in</Button>
          </>}
        </div>
      </form>
    </main>
  );
}
