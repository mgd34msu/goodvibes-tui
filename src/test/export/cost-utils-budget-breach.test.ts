/**
 * Tests for computeBudgetBreach / readBudgetAlertUsd (src/export/cost-utils.ts).
 *
 * These are the pure predicate and config-reader CostTrackerPanel's render-time
 * "OVER BUDGET" flag and the background budget-breach notifier both share, so
 * they agree on exactly one definition of "over budget" and one source of
 * truth for the configured threshold.
 */
import { describe, test, expect } from 'bun:test';
import { computeBudgetBreach, readBudgetAlertUsd, BUDGET_ALERT_USD_DEFAULT } from '../../export/cost-utils.ts';

describe('computeBudgetBreach', () => {
  test('false when no budget is configured (threshold <= 0)', () => {
    expect(computeBudgetBreach(1000, 0)).toBe(false);
    expect(computeBudgetBreach(1000, -5)).toBe(false);
  });

  test('false when cost is under the threshold', () => {
    expect(computeBudgetBreach(5, 10)).toBe(false);
  });

  test('false when cost exactly equals the threshold (breach is strictly over)', () => {
    expect(computeBudgetBreach(10, 10)).toBe(false);
  });

  test('true when cost exceeds the threshold', () => {
    expect(computeBudgetBreach(10.01, 10)).toBe(true);
  });
});

describe('readBudgetAlertUsd', () => {
  function makeConfigGet(overrides: Record<string, unknown> = {}) {
    return (key: string): unknown => overrides[key];
  }

  test('returns BUDGET_ALERT_USD_DEFAULT (0) when the key is absent', () => {
    expect(readBudgetAlertUsd(makeConfigGet({}))).toBe(BUDGET_ALERT_USD_DEFAULT);
  });

  test('returns the configured value when valid', () => {
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': 25 }))).toBe(25);
  });

  test('returns the default when the value is negative', () => {
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': -5 }))).toBe(BUDGET_ALERT_USD_DEFAULT);
  });

  test('returns the default when the value is NaN or non-numeric', () => {
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': NaN }))).toBe(BUDGET_ALERT_USD_DEFAULT);
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': 'lots' }))).toBe(BUDGET_ALERT_USD_DEFAULT);
  });

  test('coerces a numeric string', () => {
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': '15' }))).toBe(15);
  });
});
