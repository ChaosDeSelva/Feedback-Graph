import { expect, test } from 'vitest';
import { matchReport, REPORT_MERGE_MINUTES, similarReports } from './dedupe.ts';

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
