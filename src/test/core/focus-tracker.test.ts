/**
 * Tests for src/core/focus-tracker.ts
 *
 * Covers:
 * - isFocused() starts null (unknown)
 * - flips true/false on setFocused()
 * - no-signal degradation: never observing a focus token leaves it null forever
 * - shouldAlertWhenUnfocused(): true for null and false, false only for true
 */
import { describe, test, expect } from 'bun:test';
import { FocusTracker } from '../../core/focus-tracker.ts';

describe('FocusTracker', () => {
  test('isFocused() starts null (unknown)', () => {
    const tracker = new FocusTracker();
    expect(tracker.isFocused()).toBeNull();
  });

  test('setFocused(true) flips isFocused() to true', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    expect(tracker.isFocused()).toBe(true);
  });

  test('setFocused(false) flips isFocused() to false', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    expect(tracker.isFocused()).toBe(false);
  });

  test('flips back and forth across multiple calls', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    expect(tracker.isFocused()).toBe(true);
    tracker.setFocused(false);
    expect(tracker.isFocused()).toBe(false);
    tracker.setFocused(true);
    expect(tracker.isFocused()).toBe(true);
  });

  test('degrades gracefully with zero signals ever received: stays null, never throws', () => {
    const tracker = new FocusTracker();
    expect(() => tracker.isFocused()).not.toThrow();
    expect(() => tracker.shouldAlertWhenUnfocused()).not.toThrow();
    expect(tracker.isFocused()).toBeNull();
  });

  describe('shouldAlertWhenUnfocused — the honest fallback rule', () => {
    test('true when focus was never observed (unknown terminal)', () => {
      const tracker = new FocusTracker();
      expect(tracker.shouldAlertWhenUnfocused()).toBe(true);
    });

    test('true when the terminal is known to be unfocused', () => {
      const tracker = new FocusTracker();
      tracker.setFocused(false);
      expect(tracker.shouldAlertWhenUnfocused()).toBe(true);
    });

    test('false only when the terminal is known to be focused', () => {
      const tracker = new FocusTracker();
      tracker.setFocused(true);
      expect(tracker.shouldAlertWhenUnfocused()).toBe(false);
    });
  });
});
