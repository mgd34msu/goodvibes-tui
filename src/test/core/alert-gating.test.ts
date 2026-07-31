/**
 * Tests for src/core/alert-gating.ts
 *
 * Covers:
 * - readBooleanConfig: default/absent/invalid handling
 * - readNotifyOnlyWhenUnfocused: default true
 * - shouldFireAlert: per-class on/off, master gate on/off, focus state interactions
 */
import { describe, test, expect } from 'bun:test';
import { readBooleanConfig, readNotifyOnlyWhenUnfocused, shouldFireAlert } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';

function makeConfigGet(overrides: Record<string, unknown> = {}) {
  return (key: string): unknown => overrides[key];
}

describe('readBooleanConfig', () => {
  test('returns default when key is absent', () => {
    expect(readBooleanConfig(makeConfigGet({}), 'behavior.x', true)).toBe(true);
    expect(readBooleanConfig(makeConfigGet({}), 'behavior.x', false)).toBe(false);
  });

  test('returns the real boolean when set', () => {
    expect(readBooleanConfig(makeConfigGet({ 'behavior.x': false }), 'behavior.x', true)).toBe(false);
    expect(readBooleanConfig(makeConfigGet({ 'behavior.x': true }), 'behavior.x', false)).toBe(true);
  });

  test('returns default for a non-boolean, non-recognized value', () => {
    expect(readBooleanConfig(makeConfigGet({ 'behavior.x': 'nonsense' }), 'behavior.x', true)).toBe(true);
  });
});

describe('readNotifyOnlyWhenUnfocused', () => {
  test('defaults to true when absent', () => {
    expect(readNotifyOnlyWhenUnfocused(makeConfigGet({}))).toBe(true);
  });

  test('respects an explicit false', () => {
    expect(readNotifyOnlyWhenUnfocused(makeConfigGet({ 'behavior.notifyOnlyWhenUnfocused': false }))).toBe(false);
  });
});

describe('shouldFireAlert', () => {
  test('fires when unfocused and the class + master gate are both on (defaults)', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    expect(shouldFireAlert(tracker, makeConfigGet({}), 'behavior.notifyOnBudgetBreach')).toBe(true);
  });

  test('fires when focus was never observed (unknown)', () => {
    const tracker = new FocusTracker();
    expect(shouldFireAlert(tracker, makeConfigGet({}), 'behavior.notifyOnBudgetBreach')).toBe(true);
  });

  test('suppressed when focused and master gate is on (default)', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    expect(shouldFireAlert(tracker, makeConfigGet({}), 'behavior.notifyOnBudgetBreach')).toBe(false);
  });

  test('fires even when focused, if the master gate is off', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    const configGet = makeConfigGet({ 'behavior.notifyOnlyWhenUnfocused': false });
    expect(shouldFireAlert(tracker, configGet, 'behavior.notifyOnBudgetBreach')).toBe(true);
  });

  test('never fires when the per-class key is off, regardless of focus', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const configGet = makeConfigGet({ 'behavior.notifyOnBudgetBreach': false });
    expect(shouldFireAlert(tracker, configGet, 'behavior.notifyOnBudgetBreach')).toBe(false);
  });

  test('never fires when the per-class key is off even with the master gate also off', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    const configGet = makeConfigGet({ 'behavior.notifyOnBudgetBreach': false, 'behavior.notifyOnlyWhenUnfocused': false });
    expect(shouldFireAlert(tracker, configGet, 'behavior.notifyOnBudgetBreach')).toBe(false);
  });
});
