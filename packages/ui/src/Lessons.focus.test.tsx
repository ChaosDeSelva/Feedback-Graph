import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Lessons } from './Lessons.tsx';

const lesson = (id: string, title: string) => ({
  id, projectKey: 'demo', title, rule: `${title} rule`, appliesWhen: 'search work', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: 'context_available_ignored', missId: 'm', createdAt: '2026-10-01T10:00:00Z', decidedAt: null,
});
const detail = (id: string, title: string) => ({
  lesson: lesson(id, title),
  miss: { id: 'm', missed: 'filtered on the client', cause: 'context_available_ignored', causeExplanation: 'CLAUDE.md said server' },
  feedback: { id: 'f', text: "this isn't good enough", status: 'approved', sessionId: 's1', ts: '2026-10-01T10:00:00Z' },
  contextItems: [], fixCommits: [], supersedes: [],
});

let list: ReturnType<typeof lesson>[];
beforeEach(() => {
  location.hash = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { const id = url.split('/').pop(); list = list.filter((l) => l.id !== id); return new Response(null, { status: 204 }); }
    if (url.startsWith('/api/lessons?')) return Response.json(url.includes('status=proposed') ? list : []);
    const m = url.match(/^\/api\/lessons\/(\w+)$/);
    if (m) return Response.json(detail(m[1], m[1]));
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const approveByKeyboard = async () => {
  const approve = await screen.findByRole('button', { name: 'Approve' }, { timeout: 10000 });
  approve.focus();
  // A button's Enter is its click.
  fireEvent.click(approve);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Approving…' })).toBeNull());
  await act(async () => {});
};

test('approving the last proposed lesson by keyboard leaves focus on the list that says none are left, not on the page', async () => {
  list = [lesson('l1', 'Lesson 1')];
  render(<Lessons />);
  await approveByKeyboard();
  const region = screen.getByRole('region', { name: 'lessons list' });
  expect(document.activeElement).toBe(region);
  expect(region.textContent).toMatch(/No lessons to review/);
});

test('approving one of several by keyboard moves focus to the next lesson\'s row', async () => {
  list = [lesson('l1', 'Lesson 1'), lesson('l2', 'Lesson 2')];
  render(<Lessons />);
  await approveByKeyboard();
  const row = document.activeElement as HTMLElement;
  expect(row.getAttribute('aria-current')).toBe('true');
  expect(row.textContent).toContain('Lesson 2');
});

test('a decision made by mouse leaves focus where the pointer put it', async () => {
  list = [lesson('l1', 'Lesson 1'), lesson('l2', 'Lesson 2')];
  render(<Lessons />);
  const approve = await screen.findByRole('button', { name: 'Approve' }, { timeout: 10000 });
  fireEvent.click(approve);
  await waitFor(() => expect(list).toHaveLength(1));
  await act(async () => {});
  expect(document.activeElement?.getAttribute('aria-current')).not.toBe('true');
});

test('with selection checkboxes, the selected mark is the row\'s left edge, apart from the checkbox, not a bar between checkbox and text', async () => {
  list = [lesson('l1', 'Lesson 1'), lesson('l2', 'Lesson 2')];
  render(<Lessons />);
  const box = await screen.findByRole('checkbox', { name: 'select Lesson 1' }, { timeout: 10000 });
  const row = screen.getByRole('button', { name: /Lesson 1/ });
  // The mark is drawn by the row holding both the checkbox and the row's button, never by the button after the box.
  const holder = row.parentElement!;
  expect(holder.contains(box)).toBe(true);
  expect(holder.className).toMatch(/before:left-0/);
  expect(row.className).not.toMatch(/before:/);
  // The checkbox is inset from the mark like any row's content (pl-4), and the text keeps a gap after it (pl-2).
  expect(box.parentElement!.className).toMatch(/\bpl-4\b/);
  expect(row.className).toMatch(/\bpl-2\b/);
  expect(screen.getByRole('button', { name: /Lesson 2/ }).parentElement!.className).not.toMatch(/before:/);
});
