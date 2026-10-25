import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CopyButton } from './controls.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const clipboard = (writeText: (t: string) => Promise<void>) => vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

test('copies its text, says Copied, then goes back to its label', async () => {
  const writeText = vi.fn(async () => {});
  clipboard(writeText);
  render(<CopyButton text="pnpm test" label="Copy command" />);
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy command' })); });
  expect(writeText).toHaveBeenCalledWith('pnpm test');
  expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  act(() => { vi.advanceTimersByTime(2500); });
  expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
});

test('a clipboard that refuses calls onError and never says Copied', async () => {
  clipboard(async () => { throw new Error('denied'); });
  const onError = vi.fn();
  render(<CopyButton text="x" onError={onError} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
});
