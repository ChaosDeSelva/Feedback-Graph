import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CloseIcon, CollapseIcon, ExpandIcon, Mark, MenuIcon, MoonIcon, SunIcon } from './icons.tsx';
import { loadPref, savePref, setTheme, useTheme } from './theme.ts';
import { ScrollArea } from './ScrollArea.tsx';

/** `badge`: a count waiting on this page (proposals to review), shown beside its label; absent or 0 shows none. */
export type NavItem<K extends string> = { key: K; label: string; icon: ReactNode; badge?: number };
export type NavGroup<K extends string> = { label: string; items: NavItem<K>[] };

/** off: something is turned off on purpose (neutral, not an alarm), and href says where to change it. */
export type Health = { ok: boolean; label: string; version: string; title: string; off?: boolean; href?: string };

const COLLAPSED = 'fg:sidebar-collapsed';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** What Tab can reach inside `root`, leaving out anything a breakpoint hides (checkVisibility where the browser has it). */
const focusables = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true));

/**
 * The frame around every page: a sidebar with the product, grouped pages and the worker's health,
 * collapsible to icons on wide screens and folded into a top bar with a menu on phones.
 */
export function AppShell<K extends string>({ groups, current, onNavigate, health, connections, onSignOut, children }: {
  groups: NavGroup<K>[];
  current: K;
  onNavigate: (k: K) => void;
  health: Health | null;
  /** The connections indicator, shown above the health badge; given whether the sidebar is collapsed. */
  connections?: (collapsed: boolean) => ReactNode;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => loadPref(COLLAPSED) === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const theme = useTheme();
  useEffect(() => { savePref(COLLAPSED, collapsed ? '1' : '0'); }, [collapsed]);
  // The phone menu is a drawer over the page: while open it holds focus (Tab cycles inside the sidebar),
  // and when it closes focus goes back to the menu button instead of dropping to the page body.
  const aside = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (menuOpen) aside.current?.querySelector<HTMLElement>('nav button')?.focus();
    else if (wasOpen.current) {
      const at = document.activeElement;
      if (!at || at === document.body || aside.current?.contains(at)) menuButton.current?.focus();
    }
    wasOpen.current = menuOpen;
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
      if (e.key !== 'Tab') return;
      // The open drawer always holds its page buttons.
      const els = focusables(aside.current!);
      const first = els[0], last = els[els.length - 1], at = document.activeElement;
      const wrapTo = !aside.current?.contains(at) ? first : e.shiftKey && at === first ? last : !e.shiftKey && at === last ? first : null;
      if (wrapTo) { e.preventDefault(); wrapTo.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const hide = collapsed ? 'md:sr-only' : '';

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <a href="#main-content" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); }} className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded focus:bg-surface focus:p-3 focus:text-text">Skip to main content</a>
      <aside ref={aside} className={`relative z-30 flex shrink-0 flex-col border-b border-line bg-canvas md:h-full md:border-r md:border-b-0 ${collapsed ? 'md:w-[52px]' : 'md:w-[212px]'}`}>
        <div className={`flex h-12 shrink-0 items-center gap-2 px-3 ${collapsed ? 'md:justify-center md:px-0' : ''}`}>
          <Mark />
          <span className={`text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap [font-stretch:90%] ${hide}`}>Feedback Graph</span>
          <span className="ml-auto flex items-center gap-1 md:hidden">
            {health && <span title={`${health.label}: ${health.title}`} aria-hidden="true" className={`size-2 rounded-full ${health.ok ? 'bg-ok' : 'bg-bad'}`} />}
            <button
              ref={menuButton}
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
              className="grid size-8 place-items-center rounded-sm text-muted hover:bg-hover hover:text-text"
            >
              {menuOpen ? <CloseIcon /> : <MenuIcon />}
            </button>
          </span>
        </div>

        <div
          className={`${menuOpen ? 'flex' : 'hidden'} absolute inset-x-0 top-12 max-h-[calc(100dvh-3rem)] flex-col border-b border-line bg-canvas shadow-pop md:static md:flex md:max-h-none md:min-h-0 md:flex-1 md:border-b-0 md:shadow-none`}
        >
          <ScrollArea as="nav" aria-label="pages" className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
            {groups.map((g) => (
              <div key={g.label} className="mt-3 first:mt-1">
                <div className={`mb-1 px-2 text-[10.5px] font-semibold tracking-[0.07em] text-muted uppercase ${collapsed ? 'md:hidden' : ''}`}>{g.label}</div>
                {collapsed && <div aria-hidden="true" className="mx-2 mb-1 hidden border-t border-line md:block" />}
                <ul className="grid gap-px">
                  {g.items.map((it) => {
                    const active = it.key === current;
                    return (
                      <li key={it.key}>
                        <button
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          title={collapsed ? `${it.label}${it.badge ? ` (${it.badge} waiting)` : ''}` : undefined}
                          onClick={() => { onNavigate(it.key); setMenuOpen(false); }}
                          className={`group flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13px] transition-colors ${collapsed ? 'md:justify-center md:px-0' : ''} ${
                            active
                              ? 'bg-surface font-semibold text-text shadow-[0_0_0_1px_var(--color-line),var(--shadow-card)]'
                              : 'text-muted hover:bg-hover hover:text-text'
                          }`}
                        >
                          <span className={`shrink-0 ${active ? 'text-accent-text' : 'text-faint group-hover:text-muted'}`}>{it.icon}</span>
                          <span className={`truncate ${hide}`}>{it.label}</span>
                          {!!it.badge && (
                            <span className={`ml-auto rounded-sm bg-info-soft px-1.5 text-[11px] leading-[18px] font-semibold text-info-text tabular-nums ${hide}`}>
                              {it.badge}<span className="sr-only"> waiting</span>
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </ScrollArea>

          {/* One column no wider than the sidebar: a long status truncates or wraps inside it instead of widening it. */}
          <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-1 border-t border-line p-2">
            {connections?.(collapsed)}
            {health && <HealthBadge health={health} collapsed={collapsed} />}
            {onSignOut && <button type="button" onClick={onSignOut} title="Sign out" className={`flex h-8 items-center rounded-sm px-2 text-xs text-muted hover:bg-hover hover:text-text ${collapsed ? 'md:justify-center md:px-0' : ''}`}><span className={hide}>Sign out</span><span className={collapsed ? 'hidden md:inline' : 'hidden'} aria-hidden="true">↪</span></button>}
            <div className={`flex gap-1 ${collapsed ? 'md:flex-col' : ''}`}>
              <button
                type="button"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
                className={`flex h-8 flex-1 items-center gap-2 rounded-sm px-2 text-xs text-muted hover:bg-hover hover:text-text ${collapsed ? 'md:justify-center md:px-0' : ''}`}
              >
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
                <span className={hide}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
              </button>
              {health && <span title={`Feedback Graph ${health.version}`} className={`shrink-0 self-center px-1 font-mono text-[10.5px] text-muted tabular-nums ${hide}`}>v{health.version}</span>}
              <button
                type="button"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className="hidden size-8 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover hover:text-text md:grid"
              >
                {collapsed ? <ExpandIcon /> : <CollapseIcon />}
              </button>
            </div>
          </div>
        </div>
      </aside>
      {menuOpen && <div aria-hidden="true" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-20 bg-text/20 md:hidden" />}
      <main id="main-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

/**
 * Worker and graph health at a glance; the details are in the tooltip and at /api/status. Red only for a failure; a
 * job turned off on purpose is a neutral line linking to where to change it. The version sits beside the theme toggle,
 * so a long label truncates instead of crowding it.
 */
function HealthBadge({ health, collapsed }: { health: Health; collapsed: boolean }) {
  // The whole status on hover, the label too: the badge shows at most two lines of it, and none when collapsed.
  const title = health.title.startsWith(health.label) ? health.title : `${health.label}: ${health.title}`;
  const cls = `flex min-h-8 w-full min-w-0 items-center overflow-hidden gap-2 rounded-sm border px-2 py-1 text-xs ${health.ok ? 'border-line bg-surface text-muted' : 'border-bad/40 bg-bad-soft text-bad-text'} ${health.href ? 'hover:bg-hover' : ''} ${collapsed ? 'md:justify-center md:px-0' : ''}`;
  const body = (
    <>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${!health.ok ? 'bg-bad' : health.off ? 'bg-faint' : 'bg-ok shadow-[0_0_0_3px_var(--color-ok-soft)]'}`} />
      {/* Up to two lines, so "Codex runner off: scans paused" is read whole in a narrow sidebar. */}
      <span className={`line-clamp-2 min-w-0 flex-1 font-medium leading-snug [overflow-wrap:anywhere] ${collapsed ? 'md:sr-only' : ''}`}>{health.label}</span>
    </>
  );
  return health.href ? <a href={health.href} title={title} className={cls}>{body}</a> : <div title={title} className={cls}>{body}</div>;
}
