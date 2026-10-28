/**
 * Pages are addressed by the URL hash (`#lessons`). A link to one item adds its id (`#lessons/<id>`): the page opens
 * on that item, in the tab of its status.
 */
export const lessonHref = (id: string) => `#lessons/${encodeURIComponent(id)}`;
export const inboxHref = (feedbackId: string) => `#inbox/${encodeURIComponent(feedbackId)}`;
/** The Inbox open on one tab (`#inbox/confirmed`): the confirmed tab shows each item's post-mortem state. */
export const inboxTabHref = (status: 'pending' | 'confirmed' | 'rejected') => `#inbox/${status}`;
/** The Activity page filtered to one kind (`#activity/candidate_flagged`). */
export const activityKindHref = (kind: string) => `#activity/${encodeURIComponent(kind)}`;
export const sessionHref = (sessionId: string) => `#sessions/${encodeURIComponent(sessionId)}`;

/** The page part of the hash: `lessons` for `#lessons/l1`. */
export const hashView = () => location.hash.slice(1).split('/')[0];

/** The item a link opened this page on, or null. */
export function hashFocus(view: string): string | null {
  const [v, ...rest] = location.hash.slice(1).split('/');
  if (v !== view || !rest.length) return null;
  try {
    return decodeURIComponent(rest.join('/')) || null;
  } catch {
    return null;
  }
}

/** One Ask conversation (`#ask/<id>`). */
export const chatHref = (conversationId: string) => `#ask/${encodeURIComponent(conversationId)}`;
/**
 * A new Ask conversation on `project` that asks `q` straight away (`#ask/new?project=<key>&q=<text>`), answered by
 * `provider` (claude, codex, local) when given, else the default model.
 */
export const newChatHref = (project: string, q?: string, provider?: string) =>
  `#ask/new?${new URLSearchParams({ project, ...(q && { q }), ...(provider && { provider }) })}`;

/** What `#ask/new?project=…&q=…&provider=…` asks for, or null for any other hash. provider: as written, unchecked. */
export function hashNewChat(): { project: string; q: string; provider: string | null } | null {
  const m = location.hash.match(/^#ask\/new(?:\?(.*))?$/);
  if (!m) return null;
  const p = new URLSearchParams(m[1] ?? '');
  return { project: p.get('project') ?? '', q: (p.get('q') ?? '').trim(), provider: p.get('provider') || null };
}

/** One project on the Projects page (`#projects/<key>`). */
export const projectHref = (project: string) => `#projects/${encodeURIComponent(project)}`;
/** A file's module panel on the Projects page (`#projects/<key>/<path>`, the path encoded as one segment). */
export const moduleHref = (project: string, path: string) => `#projects/${encodeURIComponent(project)}/${encodeURIComponent(path)}`;

/** The project, and the file whose module panel to open, that a Projects link names. */
export function hashModule(): { project: string; path: string | null } | null {
  const [v, key, path] = location.hash.slice(1).split('/');
  if (v !== 'projects' || !key) return null;
  try {
    return { project: decodeURIComponent(key), path: path ? decodeURIComponent(path) : null };
  } catch {
    return null;
  }
}

/**
 * Where an Ask source opens: code and facts on their file's module panel, a lesson on the Lessons page, a session on
 * Sessions, a linked project or a document on its project's page (where its documents are listed); a web link as itself.
 * A miss cited by the file it happened in opens that file's module panel (its past misses are listed there); one cited
 * by its id (a pack from before 0.6.3, or a session with no edited file known) has no page of its own: null.
 */
export function sourceHref(project: string, s: { kind: string; ref: string }): string | null {
  const file = s.ref.replace(/:\d+(-\d+)?$/, '');
  switch (s.kind) {
    case 'code':
    case 'fact': return moduleHref(project, file);
    case 'lesson': return lessonHref(s.ref);
    case 'session': return sessionHref(s.ref);
    case 'miss': return s.ref.startsWith('miss:') ? inboxHref(s.ref.slice(5)) : moduleHref(project, file);
    case 'linked': return projectHref(s.ref);
    case 'doc': return /^https?:\/\//.test(s.ref) ? s.ref : projectHref(project);
    default: return null;
  }
}
