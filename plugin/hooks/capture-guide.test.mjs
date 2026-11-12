// @vitest-environment jsdom
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { capture, evalResult, forbiddenTerms, pageHelpers, personalTerms, privateTerms } from '../../scripts/capture-guide.mjs';

// jsdom lays nothing out: stand-ins for the two browser APIs the page helpers read, following computed styles.
beforeAll(() => {
  window.Element.prototype.checkVisibility = function () {
    for (let el = this; el; el = el.parentElement) {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    }
    return true;
  };
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
  // Node's own localStorage shadows jsdom's (and is undefined without --localstorage-file).
  const items = new Map();
  vi.stubGlobal('localStorage', { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) });
});

const temps = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'fg-capture-')); temps.push(d); return d; };
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); document.body.innerHTML = ''; });

const PERSONAL = personalTerms(['Jordan Owner']);
const TERMS = [...PERSONAL, 'client-portal', 'acme'];
/** Runs the page helpers in this document, as each eval in the browser does. */
const inPage = (body) => (0, eval)(`(async () => { ${pageHelpers(PERSONAL)}\n${body} })()`);
/** The text a screenshot would show: unmasked, visible text outside scripts (a select shows only its chosen option). */
const visible = () => {
  const out = [];
  const w = document.createTreeWalker(document.body, window.NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const el = n.parentElement;
    if (n.textContent.trim() && !el.closest('[data-guide-mask], script') && el.checkVisibility() && (!el.closest('select') || el.closest('option').selected)) out.push(n.textContent);
  }
  return out.join(' | ');
};

test('the owner\'s names come from the private-names file and CAPTURE_PRIVATE_TERMS', () => {
  const file = join(temp(), 'private-names');
  writeFileSync(file, '# who never appears\n  Jordan Owner  \n\njordan-o\n');
  expect(privateTerms(file, { CAPTURE_PRIVATE_TERMS: 'Acme Corp, ,acme-internal' })).toEqual(['Jordan Owner', 'jordan-o', 'Acme Corp', 'acme-internal']);
  expect(privateTerms(join(temp(), 'missing'), {})).toEqual([]);
  expect(personalTerms(['Jordan Owner'])).toEqual(['/Users/', '/home/', '@', 'Jordan Owner']);
});

test('every folder but the demo ones is forbidden, except names too short or too generic to mean anything', () => {
  const settings = {
    candidates: [
      { key: 'client-portal', path: '/Users/j/Code/client-portal', remote: 'github.com/acme/billing-api' },
      { key: 'demo-shop', path: '/Users/j/Code/demo-shop', remote: null },
      { key: 'feedback-graph-demo-shop', path: '/Users/j/Code/feedback-graph-demo-shop' },
      { key: 'src', path: '/Users/j/Code/Tools/src' },
      { key: 'abc' },
    ],
    outsideRoots: { folders: [{ path: '/Users/j/Desktop' }, { path: '/Users/j/old-taxes' }] },
  };
  expect(forbiddenTerms(settings, PERSONAL).sort()).toEqual([...PERSONAL, 'client-portal', 'billing-api', 'old-taxes'].sort());
  expect(forbiddenTerms({}, PERSONAL)).toEqual(PERSONAL);
});

test('an eval\'s result is read from its result line, however many times it was JSON-encoded', () => {
  expect(evalResult('navigated\nresult: "{\\"saved\\":[1,2]}"\n')).toEqual({ saved: [1, 2] });
  expect(evalResult('result: "\\"plain text\\""')).toBe('plain text');
  expect(evalResult('result: true')).toBe(true);
  expect(() => evalResult('Error: page crashed')).toThrow('eval gave no result:\nError: page crashed');
});

test('a folder name matches as a whole word only; personal text matches anywhere', async () => {
  document.body.innerHTML = '<p>acmecorp builds</p><p>re-acme-d</p><p>see acme.</p><p>mail ops@example.com</p><p>ACME rules</p>';
  expect(await inPage(`return findLeaks(${JSON.stringify(TERMS)}).map(({ n, t }) => t + ':' + n.textContent);`)).toEqual(['acme:see acme.', '@:mail ops@example.com', 'acme:ACME rules']);
});

test('masking hides other projects\' rows, keeps demo rows, and covers personal text, long text by token, and inputs', async () => {
  const log = `building ${'x'.repeat(170)} from /Users/you/Code/thing done`;
  document.body.innerHTML = `
    <table><tr><td>client-portal</td><td>3 lessons</td></tr><tr><td>demo-shop</td><td>uses client-portal fixtures</td></tr></table>
    <p id="who">Signed in as Jordan Owner</p>
    <pre id="log">${log}</pre>
    <input id="q" value="acme">
    <select aria-label="project"><option value="demo-shop" selected>demo-shop</option><option value="client-portal">client-portal</option></select>
    <script>window.secret = "acme"</script>`;
  const masked = await inPage(`return mask(${JSON.stringify(TERMS)}, ['demo-shop']);`);
  expect(masked.sort()).toEqual(['input:acme', 'row:client-portal', 'text:/Users/', 'text:Jordan Owner', 'text:client-portal'].sort());
  expect(await inPage(`return findLeaks(${JSON.stringify(TERMS)}).length;`)).toBe(0);
  const shown = visible();
  expect(shown).toContain('demo-shop');
  expect(shown).not.toMatch(/3 lessons|Jordan|\/Users\/|client-portal/);
  // A long text keeps everything but the token that holds the match.
  expect(document.getElementById('log').textContent).toBe(log);
  expect(document.querySelector('#log [data-guide-mask]').textContent).toBe('/Users/you/Code/thing');
  expect(document.getElementById('q').hasAttribute('data-guide-mask')).toBe(true);
});

/** The Feedback Graph's settings route, and chrome-devtools-axi with this document as its page. */
async function harness(pages) {
  const server = createServer((req, res) => res.end(JSON.stringify({ candidates: [{ key: 'client-portal', path: '/x/client-portal' }] })));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const calls = [];
  const axi = async (cmd, ...args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'open') document.body.innerHTML = pages[args[0].split('#')[1]] ?? '';
    if (cmd === 'screenshot') writeFileSync(args[0], 'png');
    if (cmd === 'eval') return `result: ${JSON.stringify(await (0, eval)(args[0]))}\n`;
    return '';
  };
  return { base: `http://127.0.0.1:${server.address().port}`, axi, calls, close: () => new Promise((ok) => server.close(ok)) };
}

test('a shot is saved once its matches are masked, and one that still shows a match is refused and its old image removed', async () => {
  const out = temp();
  writeFileSync(join(out, 'settings.png'), 'stale image');
  const emails = Array.from({ length: 5 }, (_, i) => `user${i}@example.com ${'z'.repeat(170)}`).join(' ');
  const h = await harness({
    dashboard: '<h2>PIPELINE</h2><ul><li>client-portal: 2 sessions</li><li>demo-shop: 4 sessions</li></ul>',
    // Five addresses in one long text: masking covers one per pass and gives up after four.
    settings: `<input aria-label="search folders"><p>${emails}</p>`,
  });
  const logs = [], errors = [];
  try {
    const failed = await capture({ base: h.base, only: new Set(['dashboard', 'settings']), out, personal: PERSONAL, axi: h.axi, log: (m) => logs.push(m), error: (m) => errors.push(m) });
    expect(failed).toEqual(['settings']);
  } finally { await h.close(); }
  expect(readFileSync(join(out, 'dashboard.png'), 'utf8')).toBe('png');
  expect(existsSync(join(out, 'settings.png'))).toBe(false);
  expect(logs).toEqual([`checking ${PERSONAL.length + 1} terms`, 'saved dashboard.png  masked: row:client-portal x1']);
  expect(errors[0]).toMatch(/^REFUSED settings: 1 visible matches\n {2}@ in "/);
  expect(errors[1]).toBe('not saved: settings');
  expect(h.calls.filter(([c]) => c === 'open').map(([, url]) => url)).toEqual([`${h.base}/#dashboard`, 'about:blank', `${h.base}/#dashboard`, 'about:blank', `${h.base}/#settings`]);
  expect(h.calls).toContainEqual(['resize', '1440', '900']);
  expect(window.localStorage.getItem('fg:theme')).toBe('dark');
});
