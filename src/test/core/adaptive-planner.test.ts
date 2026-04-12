/**
 * AdaptivePlanner unit tests — Section 5.5
 *
 * Covers:
 * - select() scoring: single vs cohort based on isMultiStep
 * - override() precedence and clearOverride() restore
 * - override('auto') clears override without double-clear
 * - getHistory() ordering and history cap
 * - explain() formatted output
 * - Input validation: NaN riskScore and negative latencyBudgetMs clamping
 * - Command handler: mode, explain, override, status, clear subcommands
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { AdaptivePlanner, VALID_STRATEGIES } from '../../core/adaptive-planner.ts';
import type { PlannerInputs } from '../../core/adaptive-planner.ts';
import { handlePlanCommand } from '../../core/plan-command-handler.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInputs(overrides: Partial<PlannerInputs> = {}): PlannerInputs {
  return {
    riskScore: 0.2,
    latencyBudgetMs: Infinity,
    isMultiStep: false,
    remoteAvailable: false,
    backgroundEligible: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AdaptivePlanner — select() scoring
// ---------------------------------------------------------------------------

describe('AdaptivePlanner.select() scoring', () => {
  test('returns single strategy for simple (non-multi-step) task', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ isMultiStep: false }));
    expect(decision.selected).toBe('single');
    expect(decision.overrideActive).toBe(false);
  });

  test('returns cohort strategy for multi-step task with low risk', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ isMultiStep: true, riskScore: 0.1 }));
    expect(decision.selected).toBe('cohort');
    expect(decision.reasonCode).toBe('COHORT_CAPABLE');
  });

  test('returns single for multi-step task when risk is high (>0.7)', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ isMultiStep: true, riskScore: 0.9 }));
    expect(decision.selected).toBe('single');
    expect(decision.reasonCode).toBe('HIGH_RISK_SINGLE_PREFERRED');
  });

  test('returns single for tight latency budget (<5000ms)', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ latencyBudgetMs: 3000 }));
    expect(decision.selected).toBe('single');
    expect(decision.reasonCode).toBe('LOW_LATENCY_SINGLE');
  });

  test('returns background when eligible and low risk', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ backgroundEligible: true, riskScore: 0.1 }));
    expect(decision.selected).toBe('background');
    expect(decision.reasonCode).toBe('BACKGROUND_DEFERRED');
  });

  test('returns remote when available and low risk', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ remoteAvailable: true, riskScore: 0.1 }));
    // remote score: 65 + (1-0.1)*15 = 78.5 vs single: 50+10=60; remote wins
    expect(decision.selected).toBe('remote');
    expect(decision.reasonCode).toBe('REMOTE_CAPABLE');
  });

  test('candidates list includes all concrete strategies', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs());
    const strategies = decision.candidates.map(c => c.strategy);
    expect(strategies).toContain('single');
    expect(strategies).toContain('cohort');
    expect(strategies).toContain('background');
    expect(strategies).toContain('remote');
  });

  test('candidates are sorted descending by score', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs());
    for (let i = 1; i < decision.candidates.length; i++) {
      expect(decision.candidates[i - 1].score).toBeGreaterThanOrEqual(decision.candidates[i].score);
    }
  });
});

// ---------------------------------------------------------------------------
// AdaptivePlanner — override() precedence
// ---------------------------------------------------------------------------

describe('AdaptivePlanner.override() precedence', () => {
  test('override takes priority over scoring', () => {
    const planner = new AdaptivePlanner();
    planner.override('cohort');
    // Even a non-multi-step task should return cohort
    const decision = planner.select(baseInputs({ isMultiStep: false }));
    expect(decision.selected).toBe('cohort');
    expect(decision.overrideActive).toBe(true);
    expect(decision.reasonCode).toBe('OVERRIDE_IN_EFFECT');
  });

  test('override() returns ok:true for valid strategy', () => {
    const planner = new AdaptivePlanner();
    const result = planner.override('single');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strategy).toBe('single');
  });

  test('override() returns ok:false and INVALID_STRATEGY for unknown strategy', () => {
    const planner = new AdaptivePlanner();
    const result = planner.override('unknown-strategy');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('INVALID_STRATEGY');
  });

  test('hasOverride() is true after override, false initially', () => {
    const planner = new AdaptivePlanner();
    expect(planner.hasOverride()).toBe(false);
    planner.override('background');
    expect(planner.hasOverride()).toBe(true);
  });

  test('getOverride() returns the active override strategy', () => {
    const planner = new AdaptivePlanner();
    planner.override('remote');
    expect(planner.getOverride()).toBe('remote');
  });
});

// ---------------------------------------------------------------------------
// AdaptivePlanner — clearOverride()
// ---------------------------------------------------------------------------

describe('AdaptivePlanner.clearOverride()', () => {
  test('clearOverride() restores scoring after override', () => {
    const planner = new AdaptivePlanner();
    planner.override('cohort');
    planner.clearOverride();
    expect(planner.hasOverride()).toBe(false);
    // Now scoring should pick single for non-multi-step
    const decision = planner.select(baseInputs({ isMultiStep: false }));
    expect(decision.selected).toBe('single');
    expect(decision.overrideActive).toBe(false);
  });

  test('clearOverride() sets getOverride() to null', () => {
    const planner = new AdaptivePlanner();
    planner.override('background');
    planner.clearOverride();
    expect(planner.getOverride()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AdaptivePlanner — override('auto') clears override
// ---------------------------------------------------------------------------

describe("AdaptivePlanner.override('auto')", () => {
  test("override('auto') clears the active override", () => {
    const planner = new AdaptivePlanner();
    planner.override('cohort');
    expect(planner.hasOverride()).toBe(true);
    const result = planner.override('auto');
    expect(result.ok).toBe(true);
    expect(planner.hasOverride()).toBe(false);
    expect(planner.getOverride()).toBeNull();
  });

  test("override('auto') makes scoring active again", () => {
    const planner = new AdaptivePlanner();
    planner.override('remote');
    planner.override('auto');
    const decision = planner.select(baseInputs({ isMultiStep: false }));
    expect(decision.overrideActive).toBe(false);
    expect(decision.selected).toBe('single');
  });
});

// ---------------------------------------------------------------------------
// AdaptivePlanner — getHistory()
// ---------------------------------------------------------------------------

describe('AdaptivePlanner.getHistory()', () => {
  test('returns decisions in chronological order (oldest first)', () => {
    const planner = new AdaptivePlanner();
    planner.select(baseInputs({ isMultiStep: false }));
    planner.select(baseInputs({ isMultiStep: true, riskScore: 0.1 }));
    const history = planner.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].selected).toBe('single');
    expect(history[1].selected).toBe('cohort');
  });

  test('getHistory(limit) returns only the N most recent decisions', () => {
    const planner = new AdaptivePlanner();
    for (let i = 0; i < 5; i++) {
      planner.select(baseInputs());
    }
    expect(planner.getHistory(3)).toHaveLength(3);
  });

  test('history is capped at MAX_HISTORY (100) entries', () => {
    const planner = new AdaptivePlanner();
    // Insert 110 decisions
    for (let i = 0; i < 110; i++) {
      planner.select(baseInputs());
    }
    // Default limit is 20; use a large limit to get all
    const all = planner.getHistory(200);
    expect(all.length).toBeLessThanOrEqual(100);
    expect(all.length).toBe(100);
  });

  test('getLatest() returns the most recent decision', () => {
    const planner = new AdaptivePlanner();
    planner.select(baseInputs({ isMultiStep: false }));
    const second = planner.select(baseInputs({ isMultiStep: true, riskScore: 0.1 }));
    expect(planner.getLatest()).toEqual(second);
  });

  test('getLatest() returns null when no decisions have been made', () => {
    const planner = new AdaptivePlanner();
    expect(planner.getLatest()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AdaptivePlanner — explain()
// ---------------------------------------------------------------------------

describe('AdaptivePlanner.explain()', () => {
  test('returns "No decisions" string when history is empty', () => {
    const planner = new AdaptivePlanner();
    expect(planner.explain()).toContain('No decisions');
  });

  test('returns a formatted string after a decision', () => {
    const planner = new AdaptivePlanner();
    planner.select(baseInputs({ isMultiStep: false }));
    const explanation = planner.explain();
    expect(typeof explanation).toBe('string');
    expect(explanation.length).toBeGreaterThan(0);
    expect(explanation).toContain('Strategy:');
    expect(explanation).toContain('Reason:');
    expect(explanation).toContain('Inputs:');
  });

  test('formatted output includes backgroundEligible with a space', () => {
    const planner = new AdaptivePlanner();
    planner.select(baseInputs({ backgroundEligible: true }));
    const explanation = planner.explain();
    // Must have "backgroundEligible: " (with space)
    expect(explanation).toContain('backgroundEligible: ');
    // Must NOT have the old broken form without space
    expect(explanation).not.toMatch(/backgroundEligible:[^ ]/);
  });

  test('explain(reasonCode) returns static explanation for a code', () => {
    const planner = new AdaptivePlanner();
    const text = planner.explain('COHORT_CAPABLE');
    expect(text).toContain('multi-step');
  });

  test('AdaptivePlanner.explainReasonCode() returns static explanation', () => {
    const text = AdaptivePlanner.explainReasonCode('HIGH_RISK_SINGLE_PREFERRED');
    expect(text).toContain('risk score');
  });
});

// ---------------------------------------------------------------------------
// AdaptivePlanner — input validation
// ---------------------------------------------------------------------------

describe('AdaptivePlanner input validation', () => {
  test('NaN riskScore is clamped to 0', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ riskScore: NaN }));
    // The decision should be made without throwing
    expect(decision.inputs.riskScore).toBe(0);
  });

  test('riskScore > 1 is clamped to 1', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ riskScore: 5 }));
    expect(decision.inputs.riskScore).toBe(1);
  });

  test('riskScore < 0 is clamped to 0', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ riskScore: -0.5 }));
    expect(decision.inputs.riskScore).toBe(0);
  });

  test('negative latencyBudgetMs is clamped to 0', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ latencyBudgetMs: -1000 }));
    expect(decision.inputs.latencyBudgetMs).toBe(0);
  });

  test('valid riskScore is not modified', () => {
    const planner = new AdaptivePlanner();
    const decision = planner.select(baseInputs({ riskScore: 0.5 }));
    expect(decision.inputs.riskScore).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// AdaptivePlanner — setMode() / getMode()
// ---------------------------------------------------------------------------

describe('AdaptivePlanner.setMode()', () => {
  test('setMode pins the strategy (not auto)', () => {
    const planner = new AdaptivePlanner();
    planner.setMode('single');
    const decision = planner.select(baseInputs({ isMultiStep: true, riskScore: 0.1 }));
    // Pinned to single even though cohort would score higher
    expect(decision.selected).toBe('single');
  });

  test('setMode(auto) restores auto scoring', () => {
    const planner = new AdaptivePlanner();
    planner.setMode('single');
    planner.setMode('auto');
    const decision = planner.select(baseInputs({ isMultiStep: true, riskScore: 0.1 }));
    expect(decision.selected).toBe('cohort');
  });

  test('getMode() returns the current mode', () => {
    const planner = new AdaptivePlanner();
    expect(planner.getMode()).toBe('auto');
    planner.setMode('background');
    expect(planner.getMode()).toBe('background');
  });
});

// ---------------------------------------------------------------------------
// VALID_STRATEGIES export
// ---------------------------------------------------------------------------

describe('VALID_STRATEGIES', () => {
  test('contains all five strategies', () => {
    expect(VALID_STRATEGIES).toContain('auto');
    expect(VALID_STRATEGIES).toContain('single');
    expect(VALID_STRATEGIES).toContain('cohort');
    expect(VALID_STRATEGIES).toContain('background');
    expect(VALID_STRATEGIES).toContain('remote');
    expect(VALID_STRATEGIES).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// handlePlanCommand — command handler subcommands
// ---------------------------------------------------------------------------

describe('handlePlanCommand', () => {
  let planner: AdaptivePlanner;

  beforeEach(() => {
    planner = new AdaptivePlanner();
  });

  function handle(subcommand: string, args: string[] = []) {
    return handlePlanCommand({ adaptivePlanner: planner }, subcommand, args);
  }

  test('mode subcommand with no args returns current mode', () => {
    const result = handle('mode', []);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('auto');
  });

  test('mode subcommand sets mode and returns ok', () => {
    const result = handle('mode', ['single']);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('single');
    // Verify mode is actually set
    const status = handle('mode', []);
    expect(status.output).toContain('single');
  });

  test('mode subcommand rejects unknown mode', () => {
    const result = handle('mode', ['turbo']);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('turbo');
  });

  test('explain subcommand returns output string', () => {
    const result = handle('explain', []);
    expect(result.ok).toBe(true);
    expect(typeof result.output).toBe('string');
  });

  test('override subcommand with no args returns usage error', () => {
    const result = handle('override', []);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Usage');
  });

  test('override subcommand with valid strategy returns ok', () => {
    const result = handle('override', ['cohort']);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('COHORT');
  });

  test('override subcommand with invalid strategy returns error', () => {
    const result = handle('override', ['warp-drive']);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('rejected');
  });

  test('override(auto) clears override and returns ok', () => {
    handle('override', ['cohort']);
    const result = handle('override', ['auto']);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('cleared');
  });

  test('status subcommand returns mode and override state', () => {
    const result = handle('status', []);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Mode:');
    expect(result.output).toContain('Override:');
  });

  test('status shows active override when one is set', () => {
    handle('override', ['remote']);
    const result = handle('status', []);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('REMOTE');
    expect(result.output).toContain('ACTIVE');
  });

  test('clear subcommand resets mode and override to auto', () => {
    handle('mode', ['single']);
    handle('override', ['background']);
    const result = handle('clear', []);
    expect(result.ok).toBe(true);
    const status = handle('status', []);
    expect(status.output).toContain('AUTO');
    expect(status.output).not.toContain('ACTIVE');
  });

  test('unknown subcommand returns error with help text', () => {
    const result = handle('bogus', []);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('bogus');
    expect(result.output).toContain('/plan');
  });
});
