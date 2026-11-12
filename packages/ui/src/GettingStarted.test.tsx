import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PipelineStatus, SystemStatus } from './api.ts';
import { Dashboard } from './Dashboard.tsx';
import { Docs } from './Docs.tsx';
import { GettingStarted, INSTALL_AGENT } from './GettingStarted.tsx';

const AGENT = { client: 'claude-code 2.1.3 (MCP)', at: '2026-11-01T10:00:00.000Z' };
const status = (tracked: number, agent: typeof AGENT | null = null) => ({ selection: { initialized: true, tracked, note: null }, agent }) as unknown as SystemStatus;
const pipeline = (o: { confirmed?: number; proposed?: number; approved?: number; demo?: { proposed: number; approved: number }; lessons?: null; inbox?: null } = {}) => ({
  inbox: o.inbox === null ? null : { pending: 0, confirmed: o.confirmed ?? 0 },
  lessons: o.lessons === null ? null : { proposed: o.proposed ?? 0, approved: o.approved ?? 0, ...(o.demo && { demo: o.demo }) },
}) as unknown as PipelineStatus;

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => Response.json([]))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); location.hash = ''; });

const card = () => screen.findByRole('region', { name: 'Getting started' });
const step = (c: HTMLElement) => c.querySelector('[aria-current="step"]') as HTMLElement;

test('a fresh install starts at choosing projects, with nothing done and only the next step spelled out', async () => {
  render(<GettingStarted status={status(0)} pipeline={pipeline({ inbox: null, lessons: null })} />);
  const c = await card();
  expect(c.textContent).toMatch(/0 of 4 done/);
  expect(step(c).textContent).toMatch(/Choose the projects to learn from \(next\)/);
  expect(within(step(c)).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('#settings');
  expect(c.textContent).not.toContain(INSTALL_AGENT);
  expect(within(c).getAllByRole('listitem').map((li) => li.textContent?.replace(/\s+/g, ' ').slice(0, 30))).toHaveLength(4);
});

test('with projects chosen, connecting the agent is next: the exact install-agent command, a copy button and the Docs section', async () => {
  render(<GettingStarted status={status(2)} pipeline={pipeline()} />);
  const s = step(await card());
  expect(s.textContent).toMatch(/Connect your agent \(next\)/);
  expect(within(s).getByText(INSTALL_AGENT).tagName).toBe('CODE');
  expect(INSTALL_AGENT).toBe('./scripts/install-agent.sh');
  expect(within(s).getByRole('button', { name: 'Copy command' })).toBeTruthy();
  expect(within(s).getByRole('link', { name: 'What it sets up' }).getAttribute('href')).toBe('#docs/connect-your-agents');
});

test('the list follows progress: the agent\'s first MCP call, a confirmed miss, then the first approved lesson, after which it goes', async () => {
  const { rerender } = render(<GettingStarted status={status(2)} pipeline={pipeline()} />);
  expect(step(await card()).textContent).toMatch(/Connect your agent/);
  rerender(<GettingStarted status={status(2, AGENT)} pipeline={pipeline()} />);
  const c = screen.getByRole('region', { name: 'Getting started' });
  expect(step(c).textContent).toMatch(/Confirm a miss \(next\)/);
  expect(c.textContent).toMatch(/2 of 4 done/);
  expect(within(step(c)).getByRole('link', { name: 'Inbox' })).toBeTruthy();
  rerender(<GettingStarted status={status(2, AGENT)} pipeline={pipeline({ proposed: 1 })} />);
  expect(step(c).textContent).toMatch(/Approve your first lesson \(next\)/);
  expect(within(step(c)).getByRole('link', { name: 'Lessons' })).toBeTruthy();
  rerender(<GettingStarted status={status(2, AGENT)} pipeline={pipeline({ confirmed: 1, approved: 1 })} />);
  expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
});

test('the README --demo path (fg demo seed, fg demo context) is not progress: demo lessons tick nothing, so the list stays at the agent step', async () => {
  // Five approved demo lessons, and no agent's MCP client yet (fg demo context is the CLI, which never names itself).
  render(<GettingStarted status={status(1)} pipeline={pipeline({ approved: 5, demo: { proposed: 0, approved: 5 } })} />);
  const c = await card();
  expect(c.textContent).toMatch(/1 of 4 done/);
  expect(step(c).textContent).toMatch(/Connect your agent \(next\)/);
  cleanup();
  // With the agent connected and one lesson of your own proposed beside the demo's, approving it is what is left.
  render(<GettingStarted status={status(1, AGENT)} pipeline={pipeline({ proposed: 1, approved: 5, demo: { proposed: 0, approved: 5 } })} />);
  expect(step(await card()).textContent).toMatch(/Approve your first lesson \(next\)/);
});

test('nothing shows until the status and the pipeline are known', async () => {
  const { rerender } = render(<GettingStarted status={null} pipeline={pipeline()} />);
  expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  rerender(<GettingStarted status={status(1)} pipeline={null} />);
  expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  rerender(<GettingStarted status={status(1)} pipeline={pipeline()} />);
  expect(step(await card()).textContent).toMatch(/Connect your agent/);
});

test('it asks the API for nothing itself: the Dashboard\'s status poll carries the agent', async () => {
  render(<GettingStarted status={status(2)} pipeline={pipeline()} />);
  await card();
  expect(fetch).not.toHaveBeenCalled();
});

test('the Dashboard leads with Getting started until it is done', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/status') return Response.json({ version: '0.7.6', graph: true, workerHealthy: true, selection: { initialized: true, tracked: 0, roots: 1, note: null } });
    if (url === '/api/pipeline') return Response.json({ stage: null, progress: null, sessions: 0, classify: null, inbox: { pending: 0, confirmed: 0 }, postmortems: null, lessons: { proposed: 0, approved: 0 }, scans: null });
    return Response.json([]);
  }));
  render(<Dashboard />);
  const c = await card();
  expect(c.compareDocumentPosition(screen.getByRole('region', { name: 'Ask' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(c).getByRole('heading', { level: 2, name: 'Getting started' })).toBeTruthy();
});

test('a Docs link to a section (#docs/connect-your-agents) opens the page at that section', () => {
  const scrolled: string[] = [];
  const real = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
  try {
    location.hash = '#docs/connect-your-agents';
    render(<Docs />);
    expect(scrolled).toEqual(['doc-connect-your-agents']);
    cleanup();
    scrolled.length = 0;
    location.hash = '#docs';
    render(<Docs />);
    expect(scrolled).toEqual([]);
  } finally {
    Element.prototype.scrollIntoView = real;
  }
});
