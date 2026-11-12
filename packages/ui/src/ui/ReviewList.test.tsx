import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { OwnerWrites } from '../ownerAccess.tsx';
import { ReviewList, type ReviewKey } from './ReviewList.tsx';

afterEach(cleanup);

function List({ keys = [], busy = false }: { keys?: ReviewKey[]; busy?: boolean }) {
  const [selected, setSelected] = useState(0);
  const items = ['one', 'two', 'three'];
  return (
    <ReviewList label="things" items={items} idOf={(x) => x} row={(x) => x} selected={selected} onSelect={setSelected} loaded empty="none" keys={keys} busy={busy}>
      <p>open: {items[selected]}</p>
    </ReviewList>
  );
}

test('j and k move, a key runs its action, and keys stay out of fields, modifiers and a saving decision', () => {
  const run = vi.fn();
  render(<><List keys={[{ key: 'a', label: 'accept', run }]} /><input aria-label="field" /></>);
  fireEvent.keyDown(window, { key: 'j' });
  fireEvent.keyDown(window, { key: 'j' });
  fireEvent.keyDown(window, { key: 'j' });
  expect(screen.getByText('open: three')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'k' });
  expect(screen.getByText('open: two')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'a', metaKey: true });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'field' }), { key: 'a' });
  expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'a' });
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('complementary', { name: 'things' }).textContent).toMatch(/accept/);
});

test('owner keys do nothing on a read-only install, nor while busy', () => {
  const run = vi.fn();
  const { unmount } = render(<OwnerWrites.Provider value={false}><List keys={[{ key: 'a', label: 'accept', owner: true, run }]} /></OwnerWrites.Provider>);
  fireEvent.keyDown(window, { key: 'a' });
  unmount();
  render(<List busy keys={[{ key: 'a', label: 'accept', run }]} />);
  fireEvent.keyDown(window, { key: 'a' });
  fireEvent.keyDown(window, { key: 'j' });
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByText('open: one')).toBeTruthy();
});
