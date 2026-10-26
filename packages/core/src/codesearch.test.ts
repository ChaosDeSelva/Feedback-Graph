import { expect, test } from 'vitest';
import { codeTerms, findInCodeMap, foldTerm, type MapFile, type MapImport, type MapSymbol } from './codegraph.ts';

const file = (path: string, o: Partial<MapFile> = {}): MapFile => ({ path, lang: 'tsx', hash: 'h', loc: 10, isTest: /\.test\./.test(path), ...o });
const sym = (path: string, name: string, o: Partial<MapSymbol> = {}): MapSymbol => ({ id: `${path}#${name}`, path, name, kind: 'function', exported: true, lines: '1-10', ...o });
const imp = (from: string, to: string, names: string[] = []): MapImport => ({ from, to, names, spec: to });

const map = {
  files: [
    file('src/ui/Modal.tsx'),
    file('src/ui/ConfirmModal.tsx'),
    file('src/ui/modals/ShareModal.tsx'),
    file('src/ui/Button.tsx'),
    file('src/App.tsx'),
    file('src/Settings.tsx'),
    file('src/ui/Modal.test.tsx'),
    file('src/Settings.test.tsx'),
    file('docs/modals.md', { lang: 'md' }),
  ],
  symbols: [
    sym('src/ui/Modal.tsx', 'Modal', { kind: 'function', lines: '10-42' }),
    sym('src/ui/Modal.tsx', 'modalStyles', { kind: 'const', exported: false, lines: '1-8' }),
    sym('src/ui/ConfirmModal.tsx', 'ConfirmModal', { lines: '5-30' }),
    sym('src/ui/modals/ShareModal.tsx', 'ShareModal', { lines: '3-20' }),
    sym('src/ui/Button.tsx', 'Button'),
    sym('src/App.tsx', 'App'),
    sym('src/ui/Modal.test.tsx', 'renderModal', { exported: false }),
  ],
  imports: [
    imp('src/ui/ConfirmModal.tsx', 'src/ui/Modal.tsx', ['Modal']),
    imp('src/ui/modals/ShareModal.tsx', 'src/ui/Modal.tsx', ['Modal']),
    imp('src/Settings.tsx', 'src/ui/Modal.tsx', ['modalStyles']),
    imp('src/App.tsx', 'src/ui/ConfirmModal.tsx', ['ConfirmModal']),
    imp('src/Settings.tsx', 'src/ui/ConfirmModal.tsx', ['ConfirmModal']),
    imp('src/ui/Modal.test.tsx', 'src/ui/Modal.tsx', ['Modal']),
    imp('src/Settings.test.tsx', 'src/Settings.tsx', ['Settings']),
    imp('src/App.tsx', 'pkg:react', ['useState']),
  ],
};

test('foldTerm folds singular and plural, so "modals" finds Modal', () => {
  expect(foldTerm('modals')).toBe('modal');
  expect(foldTerm('Modal')).toBe('modal');
  expect(foldTerm('entries')).toBe('entry');
  expect(foldTerm('classes')).toBe('class');
  expect(foldTerm('boxes')).toBe('box');
  expect(foldTerm('class')).toBe('class');
  expect(foldTerm('status')).toBe('status');
});

test('codeTerms keeps the words of a question that can name code: stopwords and short words dropped, folded, unique', () => {
  expect(codeTerms('How do I add a new modal? We have modals everywhere!')).toEqual(['modal']);
  expect(codeTerms('where should the foobar endpoint go, in the ApiServer or a new service?')).toEqual(['foobar', 'endpoint', 'apiserver', 'api', 'server', 'service']);
  // Identifiers are split too, so a camelCase name in the question finds its parts as well as itself.
  expect(codeTerms('reuse ConfirmModal')).toEqual(['confirmmodal', 'confirm', 'modal']);
  expect(codeTerms('the and of')).toEqual([]);
});

test('symbols match by name and by the words in their names; exact names first, then exported, then dependents', () => {
  const hits = findInCodeMap(map, ['modal']);
  expect(hits.map((h) => `${h.path}#${h.name ?? ''}`)).toEqual([
    'src/ui/Modal.tsx#Modal',
    'src/ui/ConfirmModal.tsx#ConfirmModal',
    'src/ui/modals/ShareModal.tsx#ShareModal',
    'src/ui/Modal.tsx#modalStyles',
  ]);
  expect(hits[0]).toMatchObject({ kind: 'symbol', symbolKind: 'function', lines: '10-42', exported: true, dependents: 3 });
  // Test files are not hits of their own (they are each hit's tests), nor are docs.
  expect(hits.some((h) => h.path.includes('.test.') || h.path.endsWith('.md'))).toBe(false);
});

test('each hit lists its usages (files importing it by name, then other importers of its file) and its tests', () => {
  const [modal] = findInCodeMap(map, ['modal']);
  expect(modal.usages).toEqual(['src/ui/ConfirmModal.tsx', 'src/ui/modals/ShareModal.tsx', 'src/Settings.tsx']);
  // Its own test, and the test of a file that imports it.
  expect(modal.tests).toEqual(['src/Settings.test.tsx', 'src/ui/Modal.test.tsx']);
  const confirm = findInCodeMap(map, ['confirm'])[0];
  expect(confirm).toMatchObject({ name: 'ConfirmModal', usages: ['src/App.tsx', 'src/Settings.tsx'] });
  // A test reaching the file through one importer covers it too.
  expect(confirm.tests).toEqual(['src/Settings.test.tsx']);
  expect(findInCodeMap(map, ['modal'], { maxUsages: 1 })[0].usages).toEqual(['src/ui/ConfirmModal.tsx']);
});

test('files match by path or basename when no symbol of theirs did; more matched terms rank higher; limit caps the hits', () => {
  const files = findInCodeMap(map, ['settings']);
  expect(files).toEqual([expect.objectContaining({ kind: 'file', path: 'src/Settings.tsx', name: null, lines: null, tests: ['src/Settings.test.tsx'] })]);
  const folder = findInCodeMap(map, ['share', 'modal']);
  expect(folder[0]).toMatchObject({ path: 'src/ui/modals/ShareModal.tsx', name: 'ShareModal' });
  expect(folder[0].matched.sort()).toEqual(['modal', 'share']);
  expect(findInCodeMap(map, ['modal'], { limit: 2 })).toHaveLength(2);
  expect(findInCodeMap(map, [])).toEqual([]);
  expect(findInCodeMap(map, ['nothinglikethis'])).toEqual([]);
});

test('the question\'s filler words name no code: "already", "existing", "yet" are dropped', () => {
  expect(codeTerms('do we have a modal component already?')).toEqual(['modal', 'component']);
  expect(codeTerms('is there an existing one yet?')).toEqual([]);
});

const big = {
  files: [
    file('apps/api/errors.go', { lang: 'go' }),
    file('apps/web/markdown/render.tsx'),
    file('apps/web/lists/useList.ts'),
    file('apps/web/ui/Button.tsx'),
  ],
  symbols: [
    sym('apps/api/errors.go', 'ErrAlreadyMerged', { kind: 'const' }),
    sym('apps/web/markdown/render.tsx', 'components', { kind: 'const' }),
    sym('apps/web/lists/useList.ts', 'getList'),
    sym('apps/web/ui/Button.tsx', 'Button'),
    sym('apps/web/ui/Button.tsx', 'modaldialogtrigger', { exported: false }),
  ],
  // past the cap: in the import index (paths and edges), no symbols
  outside: [
    file('apps/web/ui/ConfirmDialog.tsx'),
    file('apps/web/ui/SettingsDialog.tsx'),
    file('apps/web/session/session-expired-modal.tsx'),
    file('apps/web/tasks/task-form-modal.tsx'),
    file('apps/web/tasks/task-form-modal.test.tsx'),
  ],
  imports: [
    imp('apps/web/tasks/task-form-modal.tsx', 'apps/web/ui/ConfirmDialog.tsx', ['ConfirmDialog']),
    imp('apps/web/tasks/task-form-modal.test.tsx', 'apps/web/tasks/task-form-modal.tsx', ['TaskFormModal']),
  ],
};

test('files past the cap are found by name, "modal" also finds dialogs, and a symbol matching only a generic word is no hit', () => {
  const hits = findInCodeMap(big, codeTerms('do we have a modal component already?'));
  expect(hits.map((h) => h.path).sort()).toEqual([
    'apps/web/session/session-expired-modal.tsx', 'apps/web/tasks/task-form-modal.tsx', 'apps/web/ui/ConfirmDialog.tsx', 'apps/web/ui/SettingsDialog.tsx',
  ]);
  // Files named modal outrank the dialogs found through the synonym; usages and tests come from the index edges.
  expect(hits.slice(0, 2).every((h) => h.path.includes('modal'))).toBe(true);
  expect(hits.find((h) => h.path.endsWith('ConfirmDialog.tsx'))).toMatchObject({ kind: 'file', usages: ['apps/web/tasks/task-form-modal.tsx'], tests: ['apps/web/tasks/task-form-modal.test.tsx'] });
  expect(hits.find((h) => h.path.endsWith('task-form-modal.tsx'))?.tests).toEqual(['apps/web/tasks/task-form-modal.test.tsx']);
});

test('generic words match only beside a specific one; matching is by whole words of a name, never inside one', () => {
  // "list" alone may still find a list; next to a specific word a hit on "list" alone is dropped.
  expect(findInCodeMap(big, ['list']).map((h) => h.name)).toEqual(['getList']);
  expect(findInCodeMap(big, ['button', 'list']).map((h) => h.name)).toEqual(['Button']);
  // "modal" inside the single word "modaldialogtrigger" is not a match.
  expect(findInCodeMap(big, ['modal']).some((h) => h.name === 'modaldialogtrigger')).toBe(false);
});

// The synonym table must not answer for Object.prototype: "constructor" in a question crashed Ask with a 500.
test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'])('a question with the word %s finds code like any other word', (word) => {
  const withIt = { ...map, symbols: [...map.symbols, sym('src/ui/Modal.tsx', word, { kind: 'method', exported: false })] };
  const terms = codeTerms(`what does the ${word} of Modal do?`);
  expect(() => findInCodeMap(withIt, terms)).not.toThrow();
  expect(() => findInCodeMap(withIt, [word])).not.toThrow();
  // A name is matched by its letters and digits, so __proto__ is the word "proto".
  expect(findInCodeMap(withIt, [word === '__proto__' ? 'proto' : word]).some((h) => h.name === word)).toBe(true);
});
