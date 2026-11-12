import { describe, expect, test } from 'vitest';
import { candidateProvenance, embeddingCosine, matchReport, REPORT_MERGE_MINUTES, similarReports } from './dedupe.ts';

const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 10, 0) + min * 60_000).toISOString();

test('reports are similar when one mostly repeats the other, whatever the case and punctuation', () => {
  expect(similarReports('This is still broken: the login page 500s', 'still broken, the login page 500s!')).toBe(true);
  expect(similarReports('you missed the auth checks on /api/orders', 'You missed the auth checks')).toBe(true);
  expect(similarReports('you missed the auth checks', 'the dark mode colours are wrong')).toBe(false);
  // Too little text to judge: never similar.
  expect(similarReports('no', 'no')).toBe(false);
  expect(similarReports('', 'still broken')).toBe(false);
});

test('matchReport picks a flagged turn of the same project within the window with similar text, closest first', () => {
  const report = { ts: at(20), text: 'still broken, the login page 500s' };
  const items = [
    { id: 'far', ts: at(20 - REPORT_MERGE_MINUTES - 1), text: 'still broken, the login page 500s' },
    { id: 'other', ts: at(19), text: 'please also add dark mode' },
    { id: 'early', ts: at(0), text: 'the login page still 500s, broken' },
    { id: 'near', ts: at(15), text: 'This is still broken: the login page 500s' },
  ];
  expect(matchReport(report, items)?.id).toBe('near');
  expect(matchReport(report, items.filter((i) => i.id !== 'near'))?.id).toBe('early');
  expect(matchReport(report, [items[0], items[1]])).toBeNull();
});

test('the same session counts as the same report even when the words differ, within the window', () => {
  const report = { ts: at(10), text: 'agent did not run the migration', sessionId: 's1' };
  expect(matchReport(report, [{ id: 'a', ts: at(2), text: 'why is the table missing?', sessionId: 's1' }])?.id).toBe('a');
  expect(matchReport(report, [{ id: 'a', ts: at(2), text: 'why is the table missing?', sessionId: 's2' }])).toBeNull();
  expect(matchReport(report, [{ id: 'a', ts: at(-REPORT_MERGE_MINUTES - 5), text: 'why is the table missing?', sessionId: 's1' }])).toBeNull();
});

test('a time that cannot be read never matches', () => {
  expect(matchReport({ ts: 'soon', text: 'still broken, the login page 500s' }, [{ id: 'a', ts: at(0), text: 'still broken, the login page 500s' }])).toBeNull();
});

describe('candidateProvenance', () => {
  const base = { manual: false, detected: false, agentReport: null, turnText: 'the login 500s', turnWhatWasDone: 'edited login.ts', createdAt: '2026-10-01T00:00:00Z' };
  const report = { text: 'missed auth', whatWasDone: 'added auth', reportedAt: '2026-10-01T00:01:00Z', sessionId: 's1' };
  test('a detected item is the detector\'s; with a stored report it is the agent\'s too', () => {
    expect(candidateProvenance(base)).toEqual({ origins: ['detector'], agentReport: null });
    expect(candidateProvenance({ ...base, agentReport: report })).toEqual({ origins: ['detector', 'agent'], agentReport: report });
  });
  test('a report_feedback item is the agent\'s alone, until the detector also found it', () => {
    expect(candidateProvenance({ ...base, manual: true, agentReport: report })).toEqual({ origins: ['agent'], agentReport: report });
    expect(candidateProvenance({ ...base, manual: true, detected: true, agentReport: report }).origins).toEqual(['detector', 'agent']);
  });
  test('a report_feedback item from before reports were stored takes its words from its own turn', () => {
    expect(candidateProvenance({ ...base, manual: true })).toEqual({
      origins: ['agent'],
      agentReport: { text: 'the login 500s', whatWasDone: 'edited login.ts', reportedAt: '2026-10-01T00:00:00Z', sessionId: null },
    });
    expect(candidateProvenance({ ...base, manual: true, turnText: null, turnWhatWasDone: undefined }).agentReport).toMatchObject({ text: '', whatWasDone: '' });
  });
});

test('by meaning (0.9.1): a reworded or next-day report close in meaning matches within days; far, too late, or not comparable does not', () => {
  const at = (h: number) => new Date(Date.parse('2026-11-10T09:00:00Z') + h * 3_600_000).toISOString();
  const unit = (x: number) => [x, Math.sqrt(1 - x * x), 0];
  const item = { id: 'k1', ts: at(0), text: 'you broke the CSV export', sessionId: 's1', embedding: unit(1) };
  expect(matchReport({ ts: at(26), text: 'exporting to csv fails since yesterday', embedding: unit(0.9) }, [item])).toBe(item);
  expect(matchReport({ ts: at(26), text: 'exporting to csv fails', embedding: unit(0.7) }, [item])).toBeNull();
  expect(matchReport({ ts: at(80), text: 'exporting to csv fails', embedding: unit(0.95) }, [item])).toBeNull();
  expect(matchReport({ ts: at(26), text: 'exporting to csv fails', embedding: [1, 0] }, [item])).toBeNull();
  expect(matchReport({ ts: at(26), text: 'exporting to csv fails' }, [item])).toBeNull();
  expect(embeddingCosine([1, 0], [0, 1])).toBe(0);
  expect(embeddingCosine(null, [1])).toBeNull();
});
