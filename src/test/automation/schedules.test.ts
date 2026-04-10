import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  formatEveryInterval,
  getNextAutomationOccurrence,
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
  parseEveryInterval,
  resolveStableAutomationCronOffsetMs,
} from '../../automation/index.ts';

describe('automation schedules', () => {
  test('parses and formats every intervals', () => {
    expect(parseEveryInterval('30s')).toBe(30_000);
    expect(parseEveryInterval('5m')).toBe(300_000);
    expect(formatEveryInterval(3_600_000)).toBe('1h');
    expect(formatEveryInterval(1_500)).toBe('1500ms');
  });

  test('computes next occurrence for at schedules', () => {
    const schedule = normalizeAtSchedule(1_700_000_000_000);
    expect(getNextAutomationOccurrence(schedule, 1_699_999_999_000)).toBe(1_700_000_000_000);
    expect(getNextAutomationOccurrence(schedule, 1_700_000_000_000)).toBeUndefined();
  });

  test('computes next occurrence for every schedules', () => {
    const schedule = normalizeEverySchedule('5m', 1_700_000_000_000);
    expect(getNextAutomationOccurrence(schedule, 1_700_000_000_000)).toBe(1_700_000_300_000);
    expect(getNextAutomationOccurrence(schedule, 1_700_000_301_000)).toBe(1_700_000_600_000);
  });

  test('computes next occurrence for cron schedules', () => {
    const schedule = normalizeCronSchedule('0 2 * * *', 'America/Chicago');
    const next = getNextAutomationOccurrence(schedule, new Date('2024-01-15T07:30:00Z').getTime());
    expect(next).toBeGreaterThan(new Date('2024-01-15T07:30:00Z').getTime());
  });

  test('defaults and applies deterministic top-of-hour cron staggering when a stable id is provided', () => {
    const schedule = normalizeCronSchedule('0 * * * *', 'UTC');
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);

    const from = new Date('2024-01-15T09:59:30Z').getTime();
    const baseHour = new Date('2024-01-15T10:00:00Z').getTime();
    const offset = resolveStableAutomationCronOffsetMs('job-a', DEFAULT_TOP_OF_HOUR_STAGGER_MS);

    expect(getNextAutomationOccurrence(schedule, from)).toBe(baseHour);
    expect(getNextAutomationOccurrence(schedule, from, 'job-a')).toBe(baseHour + offset);
    expect(normalizeCronSchedule('0 * * * *', 'UTC', 0).staggerMs).toBe(0);
  });
});
