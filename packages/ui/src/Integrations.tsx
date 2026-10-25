import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, integrationsApi, type Connection, type ConnectionName, type IntegrationKind, type IntegrationsView, type LinearTeam, type ProjectIntegrations, type ServiceView } from './api.ts';
import { hashFocus } from './links.ts';
import { Button, Input, Select } from './ui/controls.tsx';
import { ago, Alert, Badge, Card, EmptyState, plural, Skeleton, tdClass, thClass, type Tone } from './ui/display.tsx';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { FolderIcon } from './ui/icons.tsx';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const NAME: Record<IntegrationKind, string> = { github: 'GitHub', linear: 'Linear' };
export const CONNECTION_LABEL: Record<ConnectionName, string> = { github: 'GitHub', linear: 'Linear', claude: 'Claude', codex: 'Codex', ollama: 'Ollama', cloud: 'Cloud sync' };
const STATE_LABEL: Record<Connection['state'], string> = { connected: 'connected', not_connected: 'not connected', error: 'error' };
export const stateTone = (s: Connection['state']): Tone => (s === 'connected' ? 'ok' : s === 'error' ? 'bad' : 'neutral');

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-accent-text underline underline-offset-2">{children}</a>
);
const Mono = ({ children }: { children: ReactNode }) => <code className="font-mono text-[12px]">{children}</code>;

/** How to make a token, with the narrowest access that works. */
const HELP: Record<IntegrationKind, ReactNode> = {
  github: (
    <>
      Create a <Ext href="https://github.com/settings/personal-access-tokens/new">fine-grained personal access token</Ext>: under
      Repository access pick only the repositories of the projects you read, and under Permissions set <b>Pull requests</b> and{' '}
      <b>Issues</b> to <b>Read-only</b> (Metadata read-only is added for you). Nothing is ever written to GitHub.
    </>
  ),
  linear: (
    <>
      Create a personal API key in Linear under <Ext href="https://linear.app/settings/account/security">Settings, Security and access</Ext>.
      If Linear offers a choice, read access is enough. Then pick a team for each project below.
    </>
  ),
};

/**
 * Settings > Integrations: connect GitHub and Linear so review comments and issue comments arrive in the Inbox, see
 * each selected project's repository and team, and the sync state. A token goes in once and never comes back out.
 */
export function Integrations() {
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const scrolled = useRef(false);

  const load = () =>
    integrationsApi.get().then(
      // An API from before integrations answers with something else: show nothing rather than a broken section.
      (v) => { setView(v && typeof v === 'object' && 'github' in v && 'projects' in v ? v : null); setLoaded(true); },
      (e) => { setError(message(e)); setLoaded(true); },
    );
  useEffect(() => { load(); }, []);

  // A link from the connections list (#settings/integrations-github) lands on its card.
  useEffect(() => {
    if (!view || scrolled.current) return;
    const focus = hashFocus('settings');
    if (focus && ['integrations-github', 'integrations-linear', 'integrations', 'connections'].includes(focus)) {
      document.getElementById(`settings-${focus}`)?.scrollIntoView?.({ block: 'start' });
      scrolled.current = true;
    }
  }, [view]);

  if (loaded && !view && !error) return null;
  return (
    <section aria-labelledby="settings-integrations" id="settings-integrations-section" className="grid gap-2.5">
      <div>
        <h2 id="settings-integrations" className="text-[15px] font-semibold tracking-[-0.01em] [font-stretch:92%]">Integrations</h2>
        <p className="text-xs text-muted">
          Read review comments on your pull requests and comments on Linear issues, and put the pushback in the Inbox for you to confirm, like
          pushback in a session. Only selected projects are read. Tokens stay on this machine and are sent only to GitHub or Linear.
        </p>
      </div>
      {error && <Alert>{error}{!view && <Button size="sm" className="ml-3" onClick={() => { setError(null); load(); }}>Try again</Button>}</Alert>}
      {!view && !error && <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-48" /><Skeleton className="h-48" /></div>}
      {view && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <ServiceCard kind="github" view={view} onChange={setView} />
            <ServiceCard kind="linear" view={view} onChange={setView} />
          </div>
          <ProjectLinks view={view} onChange={setView} />
          <AllConnections />
        </>
      )}
    </section>
  );
}

function SourceBadge({ s }: { s: ServiceView }) {
  if (s.savedInApp) return <Badge title={s.envSet ? `wins over ${s.envVar} in .env` : undefined}>saved here</Badge>;
  if (s.envSet) return <Badge title={`${s.envVar} in .env; a token saved here wins over it`}>set in .env</Badge>;
  return null;
}

function ServiceCard({ kind, view, onChange }: { kind: IntegrationKind; view: IntegrationsView; onChange: (v: IntegrationsView) => void }) {
  const s = view[kind];
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'connect' | 'test' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const c = s.connection;
  const connected = c.state !== 'not_connected';
  const rejected = s.errorKind === 'auth' && c.state === 'error';
  const showForm = view.canSave && (!connected || replacing || rejected);
  // The token in use: one saved here wins over .env.
  const fromEnv = s.envSet && !s.savedInApp;

  async function run(what: 'connect' | 'test' | 'disconnect', f: () => Promise<void>) {
    setBusy(what);
    setError(null);
    setResult(null);
    try {
      await f();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }
  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    void run('connect', async () => {
      const v = await integrationsApi.connect(kind, token.trim());
      setToken('');
      setReplacing(false);
      onChange(v);
      setResult(`Connected as ${v[kind].account ?? 'your account'}.`);
    });
  };
  const test = () => run('test', async () => {
    const r = await integrationsApi.test(kind);
    onChange(r.view);
    if (r.ok) setResult(`Works: ${NAME[kind]} answered as ${r.account}.`);
    else setError(`${NAME[kind]} refused the token: ${r.error}`);
  });
  const disconnect = () => run('disconnect', async () => {
    onChange(await integrationsApi.disconnect(kind));
    setConfirming(false);
    setResult(s.envSet ? `Removed the token saved here; ${s.envVar} in .env is used again.` : `Disconnected. Comments already in the Inbox stay; nothing new is read from ${NAME[kind]}.`);
  });

  return (
    <Card
      id={`settings-integrations-${kind}`}
      title={NAME[kind]}
      actions={
        <>
          <SourceBadge s={s} />
          <Badge tone={stateTone(c.state)} dot>{STATE_LABEL[c.state]}</Badge>
        </>
      }
      bodyClass="grid gap-3 p-4"
    >
      <p className={c.state === 'error' ? 'text-bad-text' : 'text-muted'}>{c.detail}</p>

      {connected && (
        <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Account</dt>
          <dd>
            {s.account ? (
              <>{s.account}{s.checkedAt && <span className="text-muted" title={s.checkedAt}> (checked {ago(s.checkedAt)})</span>}</>
            ) : (
              <span className="text-muted">being checked: it is checked on first use and after a sync (or press Test connection)</span>
            )}
          </dd>
          <dt className="text-muted">Token</dt>
          <dd>{fromEnv ? <>from <Mono>{s.envVar}</Mono> in <Mono>.env</Mono></> : 'saved in this app (never shown again)'}</dd>
          <dt className="text-muted">Last sync</dt>
          <dd title={s.lastSyncAt ?? undefined}>{s.lastSyncAt ? ago(s.lastSyncAt) : 'not yet: the worker syncs within a few minutes'}</dd>
          {s.rateLimitedUntil && Date.parse(s.rateLimitedUntil) > Date.now() && (
            <>
              <dt className="text-muted">Rate limit</dt>
              <dd>paused until {new Date(s.rateLimitedUntil).toLocaleTimeString()}, then it carries on by itself</dd>
            </>
          )}
        </dl>
      )}

      {fromEnv && !showForm && (
        <p className="text-xs text-muted">
          The token comes from <Mono>{s.envVar}</Mono> in <Mono>.env</Mono>. Replace it here and the saved token is used instead; to remove the one in{' '}
          <Mono>.env</Mono>, delete the line there and restart (<Mono>docker compose up -d</Mono>).
        </p>
      )}

      {s.envSet && s.savedInApp && (
        <p className="text-xs text-muted">
          The token saved here is used. <Mono>{s.envVar}</Mono> is also set in <Mono>.env</Mono>: Disconnecting goes back to {s.envVar} in .env.
        </p>
      )}

      {!s.envSet && !view.canSave && !connected && (
        <p className="text-xs text-muted">
          Tokens cannot be saved from here in this setup. Set <Mono>{s.envVar}</Mono> in <Mono>.env</Mono> and restart.
        </p>
      )}

      {showForm && (
        <form onSubmit={connect} className="grid gap-2">
          <p className="text-xs text-muted">{HELP[kind]}</p>
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${NAME[kind]} token`}
              placeholder={kind === 'github' ? 'github_pat_…' : 'lin_api_…'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="min-w-0 flex-1 font-mono"
            />
            <Button type="submit" variant="primary" disabled={!token.trim() || busy !== null}>{busy === 'connect' ? 'Checking' : rejected || replacing ? 'Replace token' : 'Connect'}</Button>
            {replacing && <Button onClick={() => { setReplacing(false); setToken(''); }}>Cancel</Button>}
          </div>
          <p className="text-[11px] text-muted">
            Checked with one read-only call before it is saved. A token that does not work is not kept.
            {s.envSet && ` A token saved here wins over ${s.envVar} in .env.`}
          </p>
        </form>
      )}

      {connected && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={test} disabled={busy !== null}>{busy === 'test' ? 'Testing' : 'Test connection'}</Button>
          {view.canSave && !replacing && !rejected && <Button size="sm" onClick={() => setReplacing(true)} disabled={busy !== null}>Replace token</Button>}
          {s.savedInApp && <Button size="sm" variant="danger-outline" onClick={() => setConfirming(true)} disabled={busy !== null}>Disconnect</Button>}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Disconnect ${NAME[kind]}?`}
        message={s.envSet
          ? `The token saved here is deleted from this machine and ${s.envVar} in .env is used again.`
          : `The token saved here is deleted from this machine and nothing new is read from ${NAME[kind]}. Comments already in the Inbox, and what was learned from them, stay.`}
        confirmLabel={`Disconnect ${NAME[kind]}`}
        busyLabel="Disconnecting"
        busy={busy === 'disconnect'}
        error={confirming ? error : null}
        onConfirm={disconnect}
        onCancel={() => { setConfirming(false); setError(null); }}
      />

      {result && <div role="status" className="rounded-md border border-ok/40 bg-ok-soft px-3 py-2 text-ok-text">{result}</div>}
      {error && !confirming && <Alert>{error}</Alert>}
    </Card>
  );
}

function syncCell(x: { lastSyncAt: string | null; items: number; error: string | null }, on: boolean): ReactNode {
  if (!on) return <span className="text-muted">off</span>;
  if (x.error) return <span className="text-bad-text [overflow-wrap:anywhere]" title={x.error}>error: {x.error.slice(0, 120)}</span>;
  if (!x.lastSyncAt) return <span className="text-muted">waiting for the first sync</span>;
  return <span title={x.lastSyncAt}>{ago(x.lastSyncAt)} · {plural(x.items, 'comment')}</span>;
}

/** Each selected project: the repository its remote names (or GITHUB_REPOS), on or off, and its Linear team. */
function ProjectLinks({ view, onChange }: { view: IntegrationsView; onChange: (v: IntegrationsView) => void }) {
  const [teams, setTeams] = useState<LinearTeam[] | null>(null);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const linearOn = view.linear.connection.state !== 'not_connected';
  const githubOn = view.github.connection.state !== 'not_connected';

  useEffect(() => {
    if (!linearOn) { setTeams(null); return; }
    integrationsApi.linearTeams().then((t) => { setTeams(t); setTeamsError(null); }, (e) => setTeamsError(message(e)));
  }, [linearOn, view.linear.account]);

  async function save(p: ProjectIntegrations, patch: Parameters<typeof integrationsApi.setProject>[1]) {
    setSaving(p.key);
    setError(null);
    try {
      onChange(await integrationsApi.setProject(p.key, patch));
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card title="Projects" actions={<span className="text-xs text-muted">synced every {view.syncMinutes} min · the first sync reads the last 14 days</span>} bodyClass="">
      {error && <Alert className="m-3">{error}</Alert>}
      {teamsError && <Alert className="m-3">{teamsError}</Alert>}
      {view.projects.length === 0 ? (
        <EmptyState compact icon={<FolderIcon />} title="No projects selected">
          Select project folders above; each one with a GitHub remote is linked to its repository automatically.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th className={thClass}>Project</th>
                <th className={thClass}>GitHub repository</th>
                <th className={thClass}>GitHub sync</th>
                <th className={thClass}>Linear team</th>
                <th className={thClass}>Linear sync</th>
              </tr>
            </thead>
            <tbody>
              {view.projects.map((p) => (
                <tr key={p.key} className="last:[&>td]:border-b-0">
                  <td className={`${tdClass} font-medium`}>{p.key}</td>
                  <td className={tdClass}>
                    {p.github.repo ? (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`read pull request comments of ${p.key}`}
                          checked={p.github.enabled}
                          disabled={saving === p.key}
                          onChange={(e) => save(p, { github: e.target.checked })}
                        />
                        <span className="font-mono text-[12px]">{p.github.repo}</span>
                        {p.github.from === 'GITHUB_REPOS' && <Badge title="set by GITHUB_REPOS in .env">GITHUB_REPOS</Badge>}
                      </label>
                    ) : (
                      <span className="text-muted">no github.com remote</span>
                    )}
                  </td>
                  <td className={`${tdClass} text-xs`}>{p.github.repo && githubOn ? syncCell(p.github, p.github.enabled) : <span className="text-muted">-</span>}</td>
                  <td className={tdClass}>
                    {linearOn ? (
                      <Select
                        size="sm"
                        aria-label={`Linear team of ${p.key}`}
                        value={p.linear.teamId ?? ''}
                        disabled={saving === p.key || !teams}
                        onChange={(e) => {
                          const t = teams?.find((x) => x.id === e.target.value);
                          void save(p, { linearTeamId: t?.id ?? null, linearTeamName: t?.name ?? null });
                        }}
                        className="w-44"
                      >
                        <option value="">None</option>
                        {p.linear.teamId && !teams?.some((t) => t.id === p.linear.teamId) && <option value={p.linear.teamId}>{p.linear.teamName ?? p.linear.teamId}</option>}
                        {(teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.key})</option>)}
                      </Select>
                    ) : (
                      <span className="text-muted">connect Linear to choose</span>
                    )}
                  </td>
                  <td className={`${tdClass} text-xs`}>{linearOn && p.linear.teamId ? syncCell(p.linear, true) : <span className="text-muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const HOW: Partial<Record<ConnectionName, ReactNode>> = {
  claude: <>Set with <Mono>./scripts/setup.sh</Mono> (a Claude token) or <Mono>POSTMORTEM_LLM</Mono> in <Mono>.env</Mono>.</>,
  codex: <>Set <Mono>POSTMORTEM_LLM</Mono> or <Mono>SCAN_LLM</Mono> to <Mono>codex-cli</Mono> in <Mono>.env</Mono>.</>,
  ollama: <>Runs on your machine; <Mono>OLLAMA_URL</Mono> in <Mono>.env</Mono>.</>,
  cloud: <><Mono>CLOUD_URL</Mono> and <Mono>CLOUD_TOKEN</Mono> in <Mono>.env</Mono>; see the Cloud sync tab.</>,
};

/** Every connection in one list, as the sidebar shows it, with where each one is set. */
function AllConnections() {
  const [conns, setConns] = useState<Record<ConnectionName, Connection> | null>(null);
  useEffect(() => { api.status().then((s) => setConns(s.connections ?? null), () => setConns(null)); }, []);
  if (!conns) return null;
  return (
    <Card id="settings-connections" title="All connections" bodyClass="divide-y divide-line">
      {(Object.keys(CONNECTION_LABEL) as ConnectionName[]).filter((n) => conns[n]).map((n) => (
        <div key={n} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
          <span className="w-24 shrink-0 font-medium">{CONNECTION_LABEL[n]}</span>
          <Badge tone={stateTone(conns[n].state)} dot>{STATE_LABEL[conns[n].state]}</Badge>
          <span className="min-w-0 flex-1 text-xs text-muted [overflow-wrap:anywhere]">
            {conns[n].detail} {HOW[n]}
          </span>
        </div>
      ))}
    </Card>
  );
}
