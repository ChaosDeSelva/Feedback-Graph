import { useEffect, useState } from 'react';
import { api, type CloudInfo, type SyncCounts } from './api.ts';
import { Button } from './ui/controls.tsx';
import { ago, Alert, Badge, Card, plural, StatGrid, StatTile, type Tone } from './ui/display.tsx';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function state(i: CloudInfo): { label: string; tone: Tone } {
  if (!i.enabled) return { label: 'off', tone: 'neutral' };
  if (!i.last) return { label: 'not synced yet', tone: 'info' };
  return i.last.ok ? { label: 'connected', tone: 'ok' } : { label: 'error', tone: 'bad' };
}

const sentence = (host: string, s: SyncCounts) =>
  `Sent ${plural(s.projects, 'project')} to ${host}: ${plural(s.lessons, 'lesson')}, ${plural(s.misses, 'miss', 'misses')}, ${plural(s.facts, 'fact')}, ${plural(s.docs, 'doc')}.`;

const Mono = ({ children }: { children: string }) => <code className="font-mono text-[12px]">{children}</code>;

/** Settings: Feedback Graph Cloud sync. Off unless CLOUD_URL and CLOUD_TOKEN are set; Sync now is yours only. */
export function CloudSync() {
  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = () =>
    api.cloud().then(
      // An API from before cloud sync answers with something else: show nothing rather than a broken card.
      (d) => setInfo(d && typeof d === 'object' && typeof (d as CloudInfo).enabled === 'boolean' ? d : null),
      () => setInfo(null),
    );
  useEffect(() => { load(); }, []);

  async function syncNow() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.syncCloud();
      // Nothing stored for any selected project: no request reached the cloud, so it records no sync either.
      const nothing = r.ok && !r.sent.projects && !r.projects?.some((p) => p.status === 'withdrawn');
      // Unchanged: the same bundle as the last send, so nothing went (a forced sync resends it).
      const unchanged = r.projects?.filter((p) => p.status === 'unchanged').length ?? 0;
      const same = unchanged ? `${plural(unchanged, 'project')} unchanged` : '';
      if (nothing && unchanged) setResult(`Nothing changed since the last sync (${same}).`);
      else if (nothing) setResult('Nothing to send yet: the selected projects have no lessons, misses, facts or docs stored. The cloud records a sync once something is sent.');
      else if (r.ok) setResult(unchanged ? `${sentence(r.host, r.sent).replace(/\.$/, '')}; ${same} since the last sync.` : sentence(r.host, r.sent));
      else setError(r.error ?? 'The sync failed.');
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (!info) return null;
  const s = state(info);
  const total = info.preview?.total;
  const lastError = error ?? (info.last && !info.last.ok ? info.last.error : null);

  return (
    <Card
      title="Cloud sync"
      actions={
        <>
          <Badge tone={s.tone} dot>{s.label}</Badge>
          {info.enabled && <Button variant="primary" size="sm" onClick={syncNow} disabled={busy}>{busy ? 'Syncing' : 'Sync now'}</Button>}
        </>
      }
      bodyClass="grid gap-3 p-4"
    >
      {!info.enabled ? (
        <p className="text-muted">
          Off. Nothing is sent anywhere. To share your lessons with a team on Feedback Graph Cloud, create a token with the sync scope there, set{' '}
          <Mono>CLOUD_URL</Mono> and <Mono>CLOUD_TOKEN</Mono> in <Mono>.env</Mono> and restart.
        </p>
      ) : (
        <>
          <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">Cloud</dt>
            <dd className="font-mono text-[12px] [overflow-wrap:anywhere]">{info.host}</dd>
            <dt className="text-muted">Schedule</dt>
            <dd>
              {info.intervalMinutes ? `Automatically, every ${info.intervalMinutes} minutes` : 'Only when you press Sync now (set SYNC_INTERVAL_MINUTES to sync automatically)'}
              {info.nextAt && <span className="text-muted"> · next {new Date(info.nextAt).toLocaleString()}</span>}
            </dd>
            <dt className="text-muted">Last sync</dt>
            <dd>
              {info.last ? (
                <span title={new Date(info.last.at).toLocaleString()}>
                  {ago(info.last.at)} ({info.last.trigger === 'manual' ? 'Sync now' : 'scheduled'}){info.last.ok ? '' : ', failed'}
                </span>
              ) : (
                <span className="text-muted">never</span>
              )}
            </dd>
            <dt className="text-muted">Lessons</dt>
            <dd>
              {info.suggestions ? (
                <>Approved ones, and also the ones you have not approved: proposed lessons reach an admin as suggestions (<Mono>SYNC_SUGGESTIONS=true</Mono>)</>
              ) : (
                <>
                  Approved ones only, plus the new status of any the cloud already has; proposed lessons stay here until you approve them
                  (set <Mono>SYNC_SUGGESTIONS=true</Mono> to send them as suggestions)
                </>
              )}
            </dd>
            <dt className="text-muted">Projects</dt>
            <dd className="[overflow-wrap:anywhere]">
              {info.projects.length ? info.projects.join(', ') : <span className="text-muted">none: select projects above (SYNC_PROJECTS narrows them)</span>}
            </dd>
          </dl>
          {result && <p role="status" className="text-ok-text">{result}</p>}
          {lastError && <Alert>{lastError}</Alert>}
          <div className="grid gap-1.5">
            <div className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">What a sync sends</div>
            {total ? (
              <StatGrid className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
                <StatTile label="projects" value={total.projects} hint="key and git remote" />
                <StatTile label="lessons" value={total.lessons} />
                <StatTile label="misses" value={total.misses} hint="what was missed and why" />
                <StatTile label="facts" value={total.facts} />
                <StatTile label="docs" value={total.docs} hint="titles and links" />
                <StatTile label="code files" value={total.codeFiles} hint="paths and hotspot numbers" />
              </StatGrid>
            ) : (
              <p className="text-xs text-muted">{info.previewError ? `Could not count: ${info.previewError}` : 'Nothing to count yet.'}</p>
            )}
          </div>
        </>
      )}
      <p className="text-xs text-muted">{info.neverSent}</p>
    </Card>
  );
}
