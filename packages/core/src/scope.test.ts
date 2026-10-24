import { describe, expect, test } from 'vitest';
import { initialSelection, projectScope, selectionNote, shownProjects } from './scope.ts';

const sel = (tracked: string[], initialized = true) => ({ tracked, initialized, updatedAt: null });

describe('projectScope', () => {
  test('only selected projects are in scope', () => {
    const s = projectScope(sel(['demo-shop']), { excludeProjects: [] });
    expect(s.project('demo-shop')).toBe(true);
    expect(s.project('other')).toBe(false);
    expect(s.folder('demo-shop')).toBe(true);
    expect(s.folder('other')).toBe(false);
    expect(s.projects).toEqual(['demo-shop']);
  });

  test('nothing selected means nothing is in scope', () => {
    const s = projectScope(sel([], false), { excludeProjects: [] });
    expect(s.project('demo-shop')).toBe(false);
    expect(s.projects).toEqual([]);
  });

  test('EXCLUDE_PROJECTS wins over the selection', () => {
    const s = projectScope(sel(['a', 'secret']), { excludeProjects: ['secret'] });
    expect(s.project('secret')).toBe(false);
    expect(s.folder('secret')).toBe(false);
    expect(s.projects).toEqual(['a']);
  });

  test('INGEST_PROJECTS is not an allowlist on top of the selection', () => {
    const s = projectScope(sel(['a', 'b']), { excludeProjects: [], ingestProjects: ['a'] } as never);
    expect(s.project('b')).toBe(true);
  });

  test('an alias folder is in scope exactly when its project is selected and neither is excluded', () => {
    const aliases = new Map([['demo-2', 'demo']]);
    expect(projectScope(sel(['demo']), { excludeProjects: [] }, aliases).folder('demo-2')).toBe(true);
    expect(projectScope(sel(['demo-2']), { excludeProjects: [] }, aliases).folder('demo-2')).toBe(false);
    expect(projectScope(sel(['demo']), { excludeProjects: ['demo-2'] }, aliases).folder('demo-2')).toBe(false);
    expect(projectScope(sel(['demo']), { excludeProjects: ['demo'] }, aliases).folder('demo-2')).toBe(false);
  });
});

describe('initialSelection (first start, no selection stored yet)', () => {
  test('seeds from INGEST_PROJECTS, minus excluded projects', () => {
    expect(initialSelection({ ingestProjects: ['demo-shop', 'x'], excludeProjects: ['x'] })).toEqual({ tracked: ['demo-shop'], initialized: true });
  });

  test('without INGEST_PROJECTS nothing is tracked until you choose', () => {
    expect(initialSelection({ ingestProjects: [], excludeProjects: [] })).toEqual({ tracked: [], initialized: false });
  });

  test('on an upgrade without INGEST_PROJECTS, the projects you invested in are selected (never an excluded one); INGEST_PROJECTS wins', () => {
    expect(initialSelection({ ingestProjects: [], excludeProjects: ['x'] }, ['b', 'a', 'x'])).toEqual({ tracked: ['a', 'b'], initialized: true });
    expect(initialSelection({ ingestProjects: [], excludeProjects: ['x'] }, ['x'])).toEqual({ tracked: [], initialized: false });
    expect(initialSelection({ ingestProjects: ['demo'], excludeProjects: [] }, ['a'])).toEqual({ tracked: ['demo'], initialized: true });
  });
});

test('selectionNote says plainly when nothing is being read', () => {
  expect(selectionNote(sel([], false))).toMatch(/no projects are selected/i);
  expect(selectionNote(sel([], true))).toMatch(/no projects are selected/i);
  expect(selectionNote(sel(['a']))).toBeNull();
});

test('with no project folder mounted, the note points to Settings to add one, whatever is selected', () => {
  expect(selectionNote(sel(['a']), 0)).toBe('No project folders yet: add a project folder in Settings first.');
  expect(selectionNote(sel([], true), 0)).toMatch(/add a project folder in Settings first/);
  expect(selectionNote(sel(['a']), 2)).toBeNull();
});

describe('shownProjects', () => {
  const aliases = new Map([['shop-2', 'shop'], ['old-2', 'old'], ['shop', 'shop']]);

  test('the selected projects and the clone folders that follow them; nothing else', () => {
    const s = shownProjects(sel(['shop']), { excludeProjects: [] }, aliases);
    expect(s.initialized).toBe(true);
    expect(s.keys).toEqual(['shop', 'shop-2']);
    expect(s.has('shop')).toBe(true);
    expect(s.has('shop-2')).toBe(true);
    expect(s.has('old')).toBe(false);
    expect(s.has('old-2')).toBe(false);
  });

  test('an excluded project, or an excluded clone of a selected one, is not shown', () => {
    const s = shownProjects(sel(['shop', 'secret']), { excludeProjects: ['secret', 'shop-2'] }, aliases);
    expect(s.keys).toEqual(['shop']);
  });

  test('before a selection is saved nothing is shown, whatever is in the list', () => {
    const s = shownProjects(sel(['shop'], false), { excludeProjects: [] }, aliases);
    expect(s.initialized).toBe(false);
    expect(s.keys).toEqual([]);
    expect(s.has('shop')).toBe(false);
  });
});
