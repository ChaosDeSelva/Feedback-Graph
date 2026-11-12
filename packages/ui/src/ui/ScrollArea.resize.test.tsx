import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { ScrollArea } from './ScrollArea.tsx';
import { overflowAll } from './scrollReach.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a box whose content grows past its height becomes a tab stop when the browser reports the resize', () => {
  const observers: { callback: () => void; watched: Element[] }[] = [];
  vi.stubGlobal('ResizeObserver', class {
    watched: Element[] = [];
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observers.push(this); }
    observe(el: Element) { this.watched.push(el); }
    disconnect() { this.watched = []; }
  });
  render(<ScrollArea aria-label="notes" className="overflow-auto"><p>first note</p></ScrollArea>);
  const box = screen.getByLabelText('notes');
  // The box and each of its children are watched, so content that grows inside it is seen too.
  expect(observers[0].watched).toEqual([box, screen.getByText('first note')]);
  expect(box.hasAttribute('tabindex')).toBe(false);
  onTestFinished(overflowAll());
  act(() => observers[0].callback());
  expect(box.tabIndex).toBe(0);
});
