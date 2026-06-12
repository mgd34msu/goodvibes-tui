import { describe, expect, test } from 'bun:test';
import { formatElapsed } from '../../utils/format-elapsed.ts';

describe('formatElapsed', () => {
  // Sub-second: show tenths
  test('zero ms renders as 0.0s', () => {
    expect(formatElapsed(0)).toBe('0.0s');
  });

  test('negative ms is clamped to 0.0s', () => {
    expect(formatElapsed(-100)).toBe('0.0s');
  });

  test('400ms renders as 0.4s', () => {
    expect(formatElapsed(400)).toBe('0.4s');
  });

  test('999ms renders with one decimal (sub-second)', () => {
    const result = formatElapsed(999);
    expect(result).toMatch(/^0\.\ds$/);
  });

  // Whole seconds
  test('exactly 1000ms renders as 1s', () => {
    expect(formatElapsed(1000)).toBe('1s');
  });

  test('3200ms renders as 3s', () => {
    expect(formatElapsed(3200)).toBe('3s');
  });

  test('exactly 59s renders as 59s', () => {
    expect(formatElapsed(59_000)).toBe('59s');
  });

  // 59-60s boundary
  test('59999ms renders as 59s (just below 1 minute)', () => {
    expect(formatElapsed(59_999)).toBe('59s');
  });

  test('exactly 60000ms renders as 1m00s', () => {
    expect(formatElapsed(60_000)).toBe('1m00s');
  });

  // Minutes
  test('64200ms renders as 1m04s', () => {
    expect(formatElapsed(64_200)).toBe('1m04s');
  });

  test('3599000ms renders as 59m59s', () => {
    expect(formatElapsed(3_599_000)).toBe('59m59s');
  });

  test('3600000ms (exactly 1 hour) renders as 1h00m', () => {
    expect(formatElapsed(3_600_000)).toBe('1h00m');
  });

  // Over 1 hour
  test('3720000ms renders as 1h02m', () => {
    expect(formatElapsed(3_720_000)).toBe('1h02m');
  });

  test('7260000ms renders as 2h01m', () => {
    expect(formatElapsed(7_260_000)).toBe('2h01m');
  });
});
