#!/usr/bin/env node
/**
 * Captures the screenshots for the page-by-page guide into packages/ui/public/guide/.
 *
 *   node scripts/capture-guide.mjs [base-url] [only,these,shots]
 *
 * Drives a headless Chrome through the `chrome-devtools-axi` CLI (on PATH), at 1440x900, dark theme, against a running
 * app (default http://localhost:8787). It only reads: it changes hashes, picks a project in a filter, switches a view
 * tab, types into a search box and scrolls. It never presses Save, Confirm, Scan or any other write button.
 *
 * The images go into a public repo, so before each one the page's visible text is checked for the owner's home path,
 * email addresses, names, account names and every folder that is not a demo project. Matches are masked (rows of other
 * projects hidden, other matches covered by a redaction bar) and the check runs again; a shot that still matches is
 * not saved and the script exits non-zero.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const ONLY = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'ui', 'public', 'guide');
const DEMO = ['feedback-graph-demo-shop', 'demo-shop'];
const MAIN = DEMO[0];
/**
 * Matched anywhere (substring, any case); the whole text holding one is covered. Beyond home paths and email-like text,
 * the owner's own names and accounts come from outside the repo, so they are never published: one per line in
 * .git/info/private-names (the same file scripts/check-public-history.sh reads) and comma-separated in
 * CAPTURE_PRIVATE_TERMS.
 */
const PERSONAL = ['/Users/', '/home/', '@', ...privateTerms()];

function privateTerms() {
  let fromFile = [];
  try {
    const file = execFileSync('git', ['rev-parse', '--git-path', 'info/private-names'], { encoding: 'utf8' }).trim();
    fromFile = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {}
  const fromEnv = (process.env.CAPTURE_PRIVATE_TERMS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return [...fromFile, ...fromEnv];
}

const axi = (...args) => execFileSync('chrome-devtools-axi', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Runs `js` (an expression, may be a promise) in the page and returns its value. */
function evaluate(js) {
  const out = axi('eval', `(async () => JSON.stringify(await (${js})))()`);
  const line = out.split('\n').find((l) => l.startsWith('result: '));
  if (!line) throw new Error(`eval gave no result:\n${out}`);
  let v = JSON.parse(line.slice('result: '.length));
  while (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { break; }
  }
  return v;
}

// ---- what must never appear ------------------------------------------------------------------------------------

const GENERIC = new Set(['demo', 'assets', 'infra', 'linear', 'Code', 'Codex', 'Games', 'Tools', 'Stuff', 'Honor', 'microservices', 'Desktop', 'Documents', 'Downloads', 'Library', 'Public', 'Pictures', 'Music', 'Movies', 'Applications', 'Templates', 'Trash', 'Setup', 'whisper', 'local', 'packages', 'src', 'test', 'docs', 'source', 'godot', 'honor'].map((w) => w.toLowerCase()));

async function forbiddenTerms() {
  const terms = new Set(PERSONAL);
  const res = await fetch(`${BASE}/api/settings/projects`);
  const s = await res.json();
  const names = new Set();
  for (const c of s.candidates ?? []) {
    names.add(c.key);
    if (c.path) names.add(basename(c.path));
    if (c.remote) names.add(basename(c.remote));
  }
  for (const f of s.outsideRoots?.folders ?? []) names.add(basename(f.path));
  for (const n of names) {
    if (!n || n.length < 4 || GENERIC.has(n.toLowerCase()) || DEMO.includes(n)) continue;
    terms.add(n);
  }
  return [...terms];
}

// ---- page-side helpers (stringified into each eval) ------------------------------------------------------------

const PAGE_HELPERS = `const PERSONAL = ${JSON.stringify(PERSONAL)};` + String.raw`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = fn(); if (v) return v; } catch {} await sleep(150); } return null; };
const setValue = (el, value) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
const pickProject = async (value, label = 'project') => {
  const sel = await until(() => document.querySelector('select[aria-label="' + label + '"]'));
  if (!sel) return false;
  await until(() => [...sel.options].some((o) => o.value === value));
  if (sel.value !== value) setValue(sel, value);
  return sel.value === value;
};
const escapeRe = (s) => s.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
const termRe = (t) => !PERSONAL.includes(t) && /^[\w-]+$/.test(t) ? new RegExp('(^|[^\\w-])' + escapeRe(t) + '(?![\\w-])', 'i') : new RegExp(escapeRe(t), 'i');
const visibleTextNodes = () => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim()) continue;
    if (el.closest('[data-guide-mask], script, style, noscript')) continue;
    if (el.closest('select') && !el.closest('option')?.selected) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    out.push(n);
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.value && el.checkVisibility() && !el.closest('[data-guide-mask]')) out.push({ textContent: el.value, input: el });
  }
  return out;
};
const findLeaks = (terms) => {
  const hits = [];
  for (const n of visibleTextNodes()) for (const t of terms) if (termRe(t).test(n.textContent)) hits.push({ n, t });
  return hits;
};
const REDACT = 'color:transparent!important;background:rgba(140,140,150,.45)!important;border-radius:3px;user-select:none;text-shadow:none!important';
const mask = (terms, demo) => {
  let masked = [];
  for (const { n, t } of findLeaks(terms)) {
    if (n.input) { n.input.setAttribute('data-guide-mask', ''); n.input.style.cssText += ';' + REDACT; masked.push('input:' + t); continue; }
    if (!n.parentNode || n.parentElement.closest('[data-guide-mask]')) continue;
    const row = n.parentElement.closest('tr, li, option, [role="row"], [role="option"]');
    const isFolder = !PERSONAL.includes(t);
    if (isFolder && row && !demo.some((d) => termRe(d).test(row.textContent))) {
      row.setAttribute('data-guide-mask', ''); row.style.setProperty('display', 'none', 'important'); masked.push('row:' + t); continue;
    }
    // Personal text: cover the whole text node. A folder name: cover the whitespace-separated token holding it.
    const text = n.textContent;
    if (!isFolder && text.length < 160) { const span = document.createElement('span'); span.setAttribute('data-guide-mask', ''); span.style.cssText = REDACT; n.parentNode.replaceChild(span, n); span.appendChild(n); masked.push('text:' + t); continue; }
    const m = termRe(t).exec(text);
    if (!m) continue;
    let start = m.index + (m[1] ? m[1].length : 0), end = start + (m[0].length - (m[1] ? m[1].length : 0));
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    while (end < text.length && !/\s/.test(text[end])) end++;
    const span = document.createElement('span');
    span.setAttribute('data-guide-mask', '');
    span.style.cssText = REDACT;
    const mid = n.splitText(start);
    mid.splitText(end - start);
    mid.parentNode.replaceChild(span, mid);
    span.appendChild(mid);
    masked.push('text:' + t);
  }
  return masked;
};
`;

const inPage = (body) => `(async () => { ${PAGE_HELPERS}\n${body} })()`;

// ---- the shots ---------------------------------------------------------------------------------------------------

const SHOTS = [
  { name: 'dashboard', hash: 'dashboard', ready: `await until(() => document.body.innerText.includes('PIPELINE'));` },
  { name: 'ask', hash: 'ask', ready: `
      await until(() => document.querySelector('select[aria-label="project"]'));
      await pickProject('${MAIN}');
      await until(() => document.body.innerText.includes('PROMPT FOR YOUR AGENT'), 8000);
      if (!document.body.innerText.includes('PROMPT FOR YOUR AGENT')) {
        const conv = [...document.querySelectorAll('a[href^="#ask/"], button')].find((b) => /invoices|CSV/i.test(b.textContent));
        conv?.click();
        await until(() => document.body.innerText.includes('PROMPT FOR YOUR AGENT'));
      }` },
  { name: 'inbox', hash: 'inbox', ready: `await pickProject('${MAIN}'); await sleep(1200);` },
  { name: 'lessons', hash: 'lessons', ready: `
      const tab = await until(() => [...document.querySelectorAll('[role="group"][aria-label="status"] button')].find((b) => b.textContent.trim() === 'approved'));
      tab.click(); await sleep(1200);
      const item = await until(() => [...document.querySelectorAll('button, li, a')].find((b) => b.textContent.includes('${MAIN} ·')));
      item?.click(); await sleep(1200);` },
  { name: 'graph', hash: 'graph', ready: `await pickProject('${MAIN}'); await sleep(4000);` },
  { name: 'graph-code', hash: 'graph', ready: `
      await pickProject('${MAIN}');
      const code = await until(() => [...document.querySelectorAll('[role="group"][aria-label="view"] button')].find((b) => b.textContent.trim() === 'code'));
      code.click(); await sleep(1000); await pickProject('${MAIN}'); await sleep(4000);` },
  { name: 'patterns', hash: 'patterns', ready: `await pickProject('${MAIN}'); await sleep(1500);` },
  { name: 'sessions', hash: 'sessions', ready: `await pickProject('${MAIN}'); await sleep(1500);` },
  { name: 'projects', hash: `projects/${MAIN}`, ready: `await until(() => document.body.innerText.includes('${MAIN}')); await sleep(2500);` },
  { name: 'projects-facts', hash: `projects/${MAIN}`, ready: `
      const box = await until(() => document.querySelector('input[aria-label="search facts"]'));
      await sleep(2000);
      // Scroll only the panel that holds the facts (scrollIntoView would also shift the whole page).
      let scroller = box.parentElement;
      while (scroller && scroller !== document.body) { const o = getComputedStyle(scroller).overflowY; if ((o === 'auto' || o === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break; scroller = scroller.parentElement; }
      const header = box.closest('section') ?? box.parentElement;
      scroller.scrollTop += header.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
      await sleep(800);` },
  { name: 'activity', hash: 'activity', ready: `await pickProject('${MAIN}'); await sleep(1500);` },
  { name: 'settings', hash: 'settings', ready: `
      const box = await until(() => document.querySelector('input[aria-label="search folders"]'));
      setValue(box, 'demo'); await sleep(1200);` },
];

async function main() {
  const terms = await forbiddenTerms();
  console.log(`checking ${terms.length} terms`);
  mkdirSync(OUT, { recursive: true });
  axi('open', `${BASE}/#dashboard`);
  axi('resize', '1440', '900');
  evaluate(`(localStorage.setItem('fg:theme', 'dark'), true)`);
  const failed = [];
  for (const shot of SHOTS) {
    if (ONLY && !ONLY.has(shot.name)) continue;
    axi('open', 'about:blank');
    axi('open', `${BASE}/#${shot.hash}`);
    evaluate(inPage(`${shot.ready}\n return true;`));
    // Keep any popover (the connections list) closed.
    evaluate(inPage(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.activeElement?.blur?.(); await sleep(200); return true;`));
    const masked = evaluate(inPage(`const terms = ${JSON.stringify(terms)}; const demo = ${JSON.stringify(DEMO)};
      const all = []; for (let i = 0; i < 4; i++) { const m = mask(terms, demo); if (!m.length) break; all.push(...m); await sleep(100); }
      return all;`));
    const leaks = evaluate(inPage(`return findLeaks(${JSON.stringify(terms)}).map(({ n, t }) => t + ' in ' + JSON.stringify(n.textContent.slice(0, 80)));`));
    const file = join(OUT, `${shot.name}.png`);
    if (leaks.length) {
      failed.push(shot.name);
      if (existsSync(file)) rmSync(file);
      console.error(`REFUSED ${shot.name}: ${leaks.length} visible matches\n  ${leaks.slice(0, 10).join('\n  ')}`);
      continue;
    }
    axi('screenshot', file);
    const summary = [...new Set(masked)].map((m) => `${m} x${masked.filter((x) => x === m).length}`);
    console.log(`saved ${shot.name}.png${summary.length ? `  masked: ${summary.join(', ')}` : ''}`);
  }
  if (failed.length) {
    console.error(`not saved: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
