import { describe, expect, test } from 'bun:test';
import { parseNaturalLanguageSchedule } from '@/input/commands/schedule-nl.ts';

// Fixed clock for deterministic relative/at parsing: 2026-07-10T12:00:00 local.
const NOW = new Date(2026, 6, 10, 12, 0, 0, 0).getTime();

describe('parseNaturalLanguageSchedule', () => {
  test('every weekday at 9am → cron Mon-Fri', () => {
    const r = parseNaturalLanguageSchedule('every weekday at 9am', NOW);
    expect(r).toMatchObject({ kind: 'cron', expression: '0 9 * * 1-5' });
    if (r.kind === 'cron') expect(r.description).toContain('weekday');
  });

  test('daily at 6pm → cron', () => {
    const r = parseNaturalLanguageSchedule('daily at 6pm', NOW);
    expect(r).toMatchObject({ kind: 'cron', expression: '0 18 * * *' });
  });

  test('every day at 08:30 → cron', () => {
    expect(parseNaturalLanguageSchedule('every day at 08:30', NOW)).toMatchObject({ kind: 'cron', expression: '30 8 * * *' });
  });

  test('every monday at 9am → cron dow=1', () => {
    expect(parseNaturalLanguageSchedule('every monday at 9am', NOW)).toMatchObject({ kind: 'cron', expression: '0 9 * * 1' });
  });

  test('every weekend → cron Sat/Sun', () => {
    expect(parseNaturalLanguageSchedule('every weekend at 10am', NOW)).toMatchObject({ kind: 'cron', expression: '0 10 * * 0,6' });
  });

  test('every 30 minutes → interval', () => {
    expect(parseNaturalLanguageSchedule('every 30 minutes', NOW)).toMatchObject({ kind: 'every', interval: '30m' });
  });

  test('every hour → interval 1h', () => {
    expect(parseNaturalLanguageSchedule('every hour', NOW)).toMatchObject({ kind: 'every', interval: '1h' });
  });

  test('hourly/daily/weekly shorthands', () => {
    expect(parseNaturalLanguageSchedule('hourly', NOW)).toMatchObject({ kind: 'cron', expression: '0 * * * *' });
    expect(parseNaturalLanguageSchedule('daily', NOW)).toMatchObject({ kind: 'cron', expression: '0 0 * * *' });
    expect(parseNaturalLanguageSchedule('weekly', NOW)).toMatchObject({ kind: 'cron', expression: '0 0 * * 0' });
  });

  test('in 2 hours → one-shot at now+2h', () => {
    const r = parseNaturalLanguageSchedule('in 2 hours', NOW);
    expect(r.kind).toBe('at');
    if (r.kind === 'at') expect(r.at).toBe(NOW + 2 * 3_600_000);
  });

  test('bare "at 9am" rolls to tomorrow when already past', () => {
    const r = parseNaturalLanguageSchedule('at 9am', NOW); // 9am < noon → tomorrow
    expect(r.kind).toBe('at');
    if (r.kind === 'at') {
      const d = new Date(r.at);
      expect(d.getHours()).toBe(9);
      expect(d.getDate()).toBe(11);
    }
  });

  test('bare "at 3pm" stays today when still upcoming', () => {
    const r = parseNaturalLanguageSchedule('at 3pm', NOW);
    expect(r.kind).toBe('at');
    if (r.kind === 'at') {
      const d = new Date(r.at);
      expect(d.getHours()).toBe(15);
      expect(d.getDate()).toBe(10);
    }
  });

  test('unparseable phrase returns an honest error', () => {
    const r = parseNaturalLanguageSchedule('sometime soon-ish maybe', NOW);
    expect(r.kind).toBe('error');
  });

  test('invalid time returns error', () => {
    expect(parseNaturalLanguageSchedule('every day at 25:99', NOW).kind).toBe('error');
  });

  test('empty phrase returns error', () => {
    expect(parseNaturalLanguageSchedule('   ', NOW).kind).toBe('error');
  });
});
