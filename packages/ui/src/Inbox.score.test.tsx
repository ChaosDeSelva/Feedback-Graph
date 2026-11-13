import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Inbox } from './Inbox.tsx';

const cand = (id: string, summary: string, score: number | null) => ({
  id, turnUuid: id, sessionId: 's', projectKey: 'demo', classification: { label: 'pushback', confidence: 0.9, summary, signals: [] },
  status: 'pending', createdAt: `2026-10-0${id.slice(1)}T10:00:00Z`, decidedAt: null, note: null,
  score, scoreWhy: score === null ? null : `${score.toFixed(1)} · classifier 90% sure it is pushback`,
});
const rows = [cand('c1', 'first miss', 4.2), cand('c2', 'second miss', 8.6)];
let urls: string[];

beforeEach(() => {
  location.hash = '';
  urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url.startsWith('/api/candidates?')) return Response.json(new URLSearchParams(url.split('?')[1]).get('sort') === 'score' ? [rows[1], rows[0]] : rows);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json({ candidate: rows.find((r) => r.id === m[1]), turn: { uuid: m[1], sessionId: 's', ts: '2026-10-01T10:00:00Z', index: 1, text: `turn ${m[1]}`, precedingAssistantText: '', precedingToolCalls: [] }, before: [], after: [], commits: [] });
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('each row and the open item show the approve score, with its why', async () => {
  render(<Inbox />);
  await screen.findByText('turn c1');
  const list = screen.getByRole('region', { name: 'feedback list' });
  expect(within(list).getByRole('img', { name: /^Approve score 4\.2 of 10: classifier/ })).toBeTruthy();
  expect(within(list).getByRole('img', { name: /^Approve score 8\.6 of 10/ })).toBeTruthy();
  expect(screen.getAllByRole('img', { name: /^Approve score 4\.2/ })).toHaveLength(2);
});

test('ordering by approve score asks the API for sort=score, lists the highest first and keeps it in the address', async () => {
  location.hash = '#inbox';
  render(<Inbox />);
  await screen.findByText('turn c1');
  fireEvent.change(screen.getByRole('combobox', { name: 'order' }), { target: { value: 'score' } });
  await waitFor(() => expect(urls.some((u) => u.startsWith('/api/candidates?') && u.includes('sort=score'))).toBe(true));
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'feedback list' })).getAllByText(/miss$/).map((e) => e.textContent)).toEqual(['second miss', 'first miss']));
  expect(location.hash).toContain('sort=score');
});
