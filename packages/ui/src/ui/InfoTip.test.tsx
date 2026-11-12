import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { InfoTip } from './InfoTip.tsx';

afterEach(cleanup);
/** A touch tap's click, which (unlike a MouseEvent) says it came from touch. */
const tap = (el: HTMLElement) => fireEvent(el, Object.defineProperty(new MouseEvent('click', { bubbles: true, cancelable: true }), 'pointerType', { value: 'touch' }));
const TEXT = 'Ask about a project. The answer cites what Feedback Graph knows and ends with a prompt to paste into your agent.';

test('the text is the button\'s description, and the tip shows on hover and on keyboard focus, and goes on Escape', () => {
  render(<InfoTip label="About Ask" text={TEXT} />);
  const button = screen.getByRole('button', { name: 'About Ask' });
  const tip = document.getElementById(button.getAttribute('aria-describedby')!)!;
  expect(tip.getAttribute('role')).toBe('tooltip');
  expect(tip.textContent).toBe(TEXT);
  expect(tip.hidden).toBe(true);
  fireEvent.mouseEnter(button);
  expect(tip.hidden).toBe(false);
  fireEvent.mouseLeave(button);
  expect(tip.hidden).toBe(true);
  act(() => button.focus());
  expect(tip.hidden).toBe(false);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(tip.hidden).toBe(true);
  expect(document.activeElement).toBe(button);
});

test('a tap toggles it, and a tap elsewhere hides it', () => {
  render(<><InfoTip label="About Ask" text={TEXT} /><p>elsewhere</p></>);
  const button = screen.getByRole('button', { name: 'About Ask' });
  const tip = screen.getByRole('tooltip', { hidden: true });
  // A tap focuses the button as it presses it: still one tap to open, one to close.
  fireEvent.pointerDown(button);
  act(() => button.focus());
  tap(button);
  expect(tip.hidden).toBe(false);
  fireEvent.pointerDown(button);
  tap(button);
  expect(tip.hidden).toBe(true);
  fireEvent.pointerDown(button);
  tap(button);
  expect(tip.hidden).toBe(false);
  fireEvent.pointerDown(screen.getByText('elsewhere'));
  expect(tip.hidden).toBe(true);
});

test('near the right edge of a phone the tip is moved left to stay inside the viewport', () => {
  const width = innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  try {
    render(<InfoTip label="About Ask" text={TEXT} />);
    const button = screen.getByRole('button', { name: 'About Ask' });
    button.getBoundingClientRect = () => ({ left: 330, right: 358, top: 100, bottom: 128, width: 28, height: 28, x: 330, y: 100, toJSON: () => ({}) });
    const tip = screen.getByRole('tooltip', { hidden: true });
    Object.defineProperty(tip, 'offsetWidth', { configurable: true, value: 340 });
    fireEvent.mouseEnter(button);
    expect(tip.style.left).toBe('27px');
    expect(tip.style.top).toBe('134px');
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }
});
