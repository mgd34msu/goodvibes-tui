import { describe, test, expect } from 'bun:test';
import {
  formatTurnBudgetOutcome,
  describeTurnBudgetSource,
  describeFailureReason,
  isTurnBudgetReason,
  TURN_BUDGET_FAILURE_REASON,
} from '../../core/turn-budget-outcome.ts';

describe('describeTurnBudgetSource', () => {
  test.each([
    ['default', 'the default limit (agents.maxTurns)'],
    ['spawn-override', 'a per-spawn override'],
    ['policy-bound', 'the policy cap (agents.maxTurnsCap)'],
  ] as const)('%s -> %s', (source, expected) => {
    expect(describeTurnBudgetSource(source)).toBe(expected);
  });
  test('undefined source is a safe generic phrase', () => {
    expect(describeTurnBudgetSource(undefined)).toBe('the configured turn limit');
  });
});

describe('formatTurnBudgetOutcome', () => {
  test('renders the limit and its source from the event, as a budget line (not a crash)', () => {
    expect(formatTurnBudgetOutcome({ limit: 50, source: 'default' })).toBe(
      'reached its turn budget — 50 turns (the default limit (agents.maxTurns))',
    );
  });
  test('singular turn', () => {
    expect(formatTurnBudgetOutcome({ limit: 1, source: 'spawn-override' })).toBe(
      'reached its turn budget — 1 turn (a per-spawn override)',
    );
  });
  test('policy-bound source names the cap', () => {
    expect(formatTurnBudgetOutcome({ limit: 200, source: 'policy-bound' })).toContain('the policy cap (agents.maxTurnsCap)');
  });
  test('degrades honestly when the event carried no limit', () => {
    expect(formatTurnBudgetOutcome({ source: 'default' })).toBe('reached its turn budget (the default limit (agents.maxTurns))');
  });
});

describe('failure-reason mapping', () => {
  test('the machine-readable reason constant is max_turns', () => {
    expect(TURN_BUDGET_FAILURE_REASON).toBe('max_turns');
  });
  test('isTurnBudgetReason recognizes the typed reason only', () => {
    expect(isTurnBudgetReason('max_turns')).toBe(true);
    expect(isTurnBudgetReason('review rejected')).toBe(false);
    expect(isTurnBudgetReason(null)).toBe(false);
  });
  test('describeFailureReason maps max_turns to a budget phrase, distinct from infra failure', () => {
    expect(describeFailureReason('max_turns')).toBe('reached its turn budget');
  });
  test('describeFailureReason passes other reasons through unchanged', () => {
    expect(describeFailureReason('review rejected')).toBe('review rejected');
    expect(describeFailureReason(null)).toBe('');
  });
});
