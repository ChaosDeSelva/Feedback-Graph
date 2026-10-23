/**
 * Pages are addressed by the URL hash (`#lessons`). A link to one item adds its id (`#lessons/<id>`): the page opens
 * on that item, in the tab of its status.
 */
export const lessonHref = (id: string) => `#lessons/${encodeURIComponent(id)}`;
export const inboxHref = (feedbackId: string) => `#inbox/${encodeURIComponent(feedbackId)}`;

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
