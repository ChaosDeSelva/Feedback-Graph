const HOST = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;
const SEGMENT = /^[.~+%-]*\w[\w.~+%-]*$/;

/** Lowercased path segments with no `.git`, or null when any part is empty, relative or odd. */
function segments(path: string): string[] | null {
  const parts = path.toLowerCase().split('/').filter(Boolean);
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/, '');
  if (!parts.length || parts.some((s) => !s || s === '.' || s === '..' || !SEGMENT.test(s))) return null;
  return parts;
}

function hosted(authority: string, path: string): string | null {
  // userinfo ends at the LAST @, so a password with an @ in it is dropped whole
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '').toLowerCase();
  const parts = segments(path);
  return HOST.test(host) && parts ? `${host}/${parts.join('/')}` : null;
}

/** Only the name counts: the same bare repo is reached by different absolute and relative paths. */
function local(path: string): string | null {
  const parts = segments(path.split('/').filter(Boolean).pop() ?? '');
  return parts ? `local/${parts[0]}` : null;
}

/**
 * A canonical id for a git remote URL, the same for every clone of one repo: "github.com/org/repo" for hosted
 * repos (any of https, ssh or scp form), "local/<name>" for a bare repo on disk. Credentials, scheme, port, query
 * and `.git` never survive. Null for anything unrecognisable.
 */
export function normalizeRemote(url: string): string | null {
  const raw = url.trim().replace(/[?#].*$/, '');
  if (!raw || /\s/.test(raw)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  if (scheme) {
    const rest = scheme[2];
    if (scheme[1].toLowerCase() === 'file') return local(rest.slice(rest.indexOf('/') + 1));
    const slash = rest.indexOf('/');
    return slash < 0 ? null : hosted(rest.slice(0, slash), rest.slice(slash));
  }
  if (/^(\/|\.\.?\/|~)/.test(raw)) return local(raw);
  const scp = /^(?:[^@/:]+@)?([^@/:]+):(.*)$/.exec(raw);
  return scp ? hosted(scp[1], scp[2]) : null;
}
