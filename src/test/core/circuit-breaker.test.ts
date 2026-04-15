import { describe, test, expect, beforeEach } from 'bun:test';
import { ConsecutiveErrorBreaker, CONSECUTIVE_ERROR_WARN, CONSECUTIVE_ERROR_BREAK } from '@pellux/goodvibes-sdk/platform/core/circuit-breaker';

describe('ConsecutiveErrorBreaker', () => {
  let breaker: ConsecutiveErrorBreaker;

  beforeEach(() => {
    breaker = new ConsecutiveErrorBreaker();
  });

  test('starts at zero', () => {
    expect(breaker.consecutiveErrors).toBe(0);
  });

  test('counter increments on recordAllFailed', () => {
    breaker.recordAllFailed();
    expect(breaker.consecutiveErrors).toBe(1);
    breaker.recordAllFailed();
    expect(breaker.consecutiveErrors).toBe(2);
  });

  test('returns ok for counts 1 through 4', () => {
    for (let i = 1; i < CONSECUTIVE_ERROR_WARN; i++) {
      expect(breaker.recordAllFailed()).toBe('ok');
    }
  });

  test('returns warn for counts 5 through 9', () => {
    // Advance to just before warn threshold
    for (let i = 0; i < CONSECUTIVE_ERROR_WARN - 1; i++) breaker.recordAllFailed();
    // Next calls (5 through 9) should return 'warn'
    for (let i = CONSECUTIVE_ERROR_WARN; i < CONSECUTIVE_ERROR_BREAK; i++) {
      expect(breaker.recordAllFailed()).toBe('warn');
    }
  });

  test('returns break at count 10 and beyond', () => {
    // Advance to just before break threshold
    for (let i = 0; i < CONSECUTIVE_ERROR_BREAK - 1; i++) breaker.recordAllFailed();
    expect(breaker.recordAllFailed()).toBe('break');
    // Stays 'break' after that
    expect(breaker.recordAllFailed()).toBe('break');
  });

  test('recordSuccess resets counter to 0', () => {
    breaker.recordAllFailed();
    breaker.recordAllFailed();
    breaker.recordSuccess();
    expect(breaker.consecutiveErrors).toBe(0);
  });

  test('consecutiveErrors getter returns current count', () => {
    expect(breaker.consecutiveErrors).toBe(0);
    breaker.recordAllFailed();
    expect(breaker.consecutiveErrors).toBe(1);
    breaker.recordAllFailed();
    expect(breaker.consecutiveErrors).toBe(2);
    breaker.recordSuccess();
    expect(breaker.consecutiveErrors).toBe(0);
  });

  test('constants have expected values', () => {
    expect(CONSECUTIVE_ERROR_WARN).toBe(5);
    expect(CONSECUTIVE_ERROR_BREAK).toBe(10);
  });
});
