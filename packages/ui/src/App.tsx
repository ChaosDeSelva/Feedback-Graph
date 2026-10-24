import { useEffect, useRef, useState } from 'react';
import { Activity } from './Activity.tsx';
import { Docs } from './Docs.tsx';
import { api, SIGN_IN_EVENT, type SystemStatus } from './api.ts';
import { Graph } from './Graph.tsx';
import { hashView } from './links.ts';
import { Inbox } from './Inbox.tsx';
import { Lessons } from './Lessons.tsx';
import { Patterns } from './Patterns.tsx';
import { Projects } from './Projects.tsx';
import { Sessions } from './Sessions.tsx';
import { Settings } from './Settings.tsx';
import { afterDiscard } from './unsaved.ts';
import { ConnectionsBadge } from './Connections.tsx';
import { AppShell, type Health, type NavGroup } from './ui/AppShell.tsx';
import { Button, Input } from './ui/controls.tsx';
import { Alert } from './ui/display.tsx';
import { ActivityIcon, DocIcon, FolderIcon, GearIcon, GraphIcon, InboxIcon, LessonIcon, Mark, PatternIcon, SessionIcon } from './ui/icons.tsx';

const VIEWS = {
  inbox: { label: 'Inbox', el: <Inbox />, icon: <InboxIcon /> },
  lessons: { label: 'Lessons', el: <Lessons />, icon: <LessonIcon /> },
  graph: { label: 'Graph', el: <Graph />, icon: <GraphIcon /> },
  patterns: { label: 'Patterns', el: <Patterns />, icon: <PatternIcon /> },
  sessions: { label: 'Sessions', el: <Sessions />, icon: <SessionIcon /> },
  projects: { label: 'Projects', el: <Projects />, icon: <FolderIcon /> },
  activity: { label: 'Activity', el: <Activity />, icon: <ActivityIcon /> },
  docs: { label: 'Docs', el: <Docs />, icon: <DocIcon /> },
  settings: { label: 'Settings', el: <Settings />, icon: <GearIcon /> },
} as const;
type View = keyof typeof VIEWS;

const item = (key: View) => ({ key, label: VIEWS[key].label, icon: VIEWS[key].icon });
const GROUPS: NavGroup<View>[] = [
  { label: 'Review', items: [item('inbox'), item('lessons')] },
  { label: 'Insights', items: [item('graph'), item('patterns'), item('sessions')] },
  { label: 'Data', items: [item('projects'), item('activity')] },
  { label: 'Help', items: [item('docs')] },
  { label: 'Setup', items: [item('settings')] },
];

export function App() {
  const fromHash = (): View => ((hashView() as View) in VIEWS ? (hashView() as View) : 'inbox');
  const [view, setView] = useState<View>(fromHash);
  // A link to one item (#lessons/<id>) keeps its id: only a different page rewrites the hash.
  useEffect(() => { if (hashView() !== view) location.hash = view; }, [view]);
  // Leaving a page with unsaved edits (Settings selection, a lesson being edited) asks first.
  const viewRef = useRef(view);
  viewRef.current = view;
  const lastHash = useRef(location.hash);
  const navigate = (next: View) => { if (next !== view) afterDiscard(() => setView(next)); };
  useEffect(() => {
    const onHash = () => {
      const next = fromHash();
      const target = location.hash;
      if (next === viewRef.current) {
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
  const [status, setStatus] = useState<SystemStatus | null>(null);
  useEffect(() => {
    api.session().then((s) => setNeedsSignIn(!!s.authRequired && !s.authenticated), () => {});
    const onSignIn = () => setNeedsSignIn(true);
    window.addEventListener(SIGN_IN_EVENT, onSignIn);
    return () => window.removeEventListener(SIGN_IN_EVENT, onSignIn);
  }, []);
  useEffect(() => {
    if (needsSignIn) return;
    const load = () => api.status().then(setStatus, () => setStatus(null));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [needsSignIn]);

  if (needsSignIn) return <SignIn onDone={() => setNeedsSignIn(false)} />;
  return (
    <AppShell
      groups={GROUPS}
      current={view}
      onNavigate={navigate}
      health={health(status)}
      connections={status?.connections ? (collapsed) => <ConnectionsBadge connections={status.connections!} collapsed={collapsed} /> : undefined}
    >
      {view !== 'settings' && view !== 'docs' && status?.selection && (!status.selection.initialized || status.selection.tracked === 0) && <NothingSelected />}
      <div className="flex min-h-0 flex-1 flex-col">{VIEWS[view].el}</div>
    </AppShell>
  );
}

const MODEL_NAME = { classify: 'classifier', postmortem: 'post-mortem model', scan: 'scan model', summary: 'summary model' } as const;

function health(status: SystemStatus | null): Health | null {
  if (!status || !('workerHealthy' in status)) return null;
  const idle = status.selection?.note ?? null;
  const w = status.worker;
  // A model that cannot be asked (not running, missing, signed out) is named in the label, not only the tooltip.
  const down = (Object.entries(status.models ?? {}) as [keyof typeof MODEL_NAME, { provider: string | null; ok: boolean; reason: string | null }][]).find(([, m]) => !m.ok);
  // Summaries wait for their model rather than fail, so the label says they are paused.
  const modelDown = down && (down[0] === 'summary' ? 'summaries paused' : `${MODEL_NAME[down[0]] ?? down[0]} unavailable`);
  const detail = down && `${modelDown}: ${down[1].provider ? `${down[1].provider}: ` : ''}${down[1].reason ?? 'unknown reason'}`;
  // Every embedding comes from Ollama, whatever models the jobs use: without it agents get no context.
  const ollama = status.ollama && !status.ollama.ok ? status.ollama : null;
  const ollamaLabel = ollama && (/not pulled/.test(ollama.reason ?? '') ? 'Ollama model missing' : 'Ollama unreachable');
  const ollamaDetail = ollama && `${ollama.reason ?? `Ollama at ${ollama.url} is not answering`}; search, get_task_context and check_before_done need it`;
  return {
    ok: !!status.graph && status.workerHealthy && !idle && !down && !ollama,
    label: !status.graph ? 'graph unreachable' : !status.workerHealthy ? 'worker offline' : idle ? (status.selection?.roots === 0 ? 'no project folders' : 'no projects selected') : ollamaLabel || modelDown || 'worker running',
    version: status.version,
    title: idle ?? [ollamaDetail, detail, w
      ? `worker ${w.version}, last heartbeat ${new Date(w.lastBeat).toLocaleTimeString()}${w.lastError ? `, last error: ${w.lastError}` : ''}`
      : 'the worker has not reported yet'].filter(Boolean).join('; '),
  };
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

function SignIn({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.signIn(token.trim());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
            <p className="font-semibold">Sign in</p>
            <p className="mt-0.5 text-muted">
              This server is protected. Enter the access token (<code className="font-mono text-xs">API_TOKEN</code> in its <code className="font-mono text-xs">.env</code>).
            </p>
          </div>
          <Input aria-label="access token" type="password" autoComplete="current-password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder="access token" />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="primary" disabled={!token.trim()}>Sign in</Button>
        </div>
      </form>
    </main>
  );
}
