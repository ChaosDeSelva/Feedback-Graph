import { useEffect, useRef, useState } from 'react';
import type { Connection, ConnectionName } from './api.ts';
import { CONNECTION_LABEL } from './Integrations.tsx';

const DOT: Record<Connection['state'], string> = { connected: 'bg-ok', error: 'bg-bad', not_connected: 'bg-faint' };
const STATE: Record<Connection['state'], string> = { connected: 'connected', error: 'error', not_connected: 'not connected' };

/**
 * The sidebar's connections indicator: one dot per connection (GitHub, Linear, Claude, Codex, Ollama, cloud sync).
 * Click it for the list: each one's state, the reason, and the Settings section that manages it.
 */
export function ConnectionsBadge({ connections, collapsed = false }: { connections: Record<ConnectionName, Connection>; collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const names = (Object.keys(CONNECTION_LABEL) as ConnectionName[]).filter((n) => connections[n]);
  const errors = names.filter((n) => connections[n].state === 'error');
  const connected = names.filter((n) => connections[n].state === 'connected');
  const label = errors.length ? `${errors.map((n) => CONNECTION_LABEL[n]).join(', ')} ${errors.length === 1 ? 'has' : 'have'} a problem` : `${connected.length} of ${names.length} connected`;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Connections: ${label}`}
        title={label}
        onClick={() => setOpen(!open)}
        className={`flex h-8 w-full items-center gap-2 rounded-sm border px-2 text-xs ${errors.length ? 'border-bad/40 bg-bad-soft text-bad-text' : 'border-line bg-surface text-muted'} hover:bg-hover ${collapsed ? 'md:justify-center md:px-0' : ''}`}
      >
        <span aria-hidden="true" className={`flex shrink-0 gap-0.5 ${collapsed ? 'md:flex-col' : ''}`}>
          {names.map((n) => <span key={n} className={`size-1.5 rounded-full ${DOT[connections[n].state]}`} />)}
        </span>
        <span className={`min-w-0 flex-1 truncate text-left font-medium ${collapsed ? 'md:sr-only' : ''}`}>{label}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Connections" className="absolute bottom-full left-0 z-40 mb-1 w-72 max-w-[calc(100vw-1.5rem)] rounded-md border border-line bg-surface p-1 shadow-pop">
          <ul className="grid">
            {names.map((n) => {
              const c = connections[n];
              return (
                <li key={n}>
                  <a href={c.href} onClick={() => setOpen(false)} className="grid gap-0.5 rounded-sm px-2 py-1.5 hover:bg-hover">
                    <span className="flex items-center gap-2 text-[13px]">
                      <span aria-hidden="true" className={`size-2 rounded-full ${DOT[c.state]}`} />
                      <span className="font-medium">{CONNECTION_LABEL[n]}</span>
                      <span className={`ml-auto text-[11px] ${c.state === 'error' ? 'text-bad-text' : 'text-muted'}`}>
                        {STATE[c.state]}{c.source === 'env' ? ' · .env' : c.source === 'app' ? ' · app' : ''}
                      </span>
                    </span>
                    <span className="text-[11.5px] leading-snug text-muted [overflow-wrap:anywhere]">{c.detail}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
