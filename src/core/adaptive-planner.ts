/**
 * Adaptive Execution Planner — Section 5.5
 *
 * Scores and selects execution strategies based on risk, latency, and
 * capability inputs. Emits typed reason codes for every decision and
 * maintains an explicit override path that is logged in full.
 *
 * Commands: /plan mode auto|single|cohort|background|remote
 *           /plan explain
 *           /plan override <strategy>
 */

import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The five supported execution strategies.
 *
 * - `auto`       — planner selects the best strategy each turn
 * - `single`     — one LLM call, no parallelism or agents
 * - `cohort`     — fan-out to a coordinated agent cohort
 * - `background` — defer execution to a background task
 * - `remote`     — delegate to a remote provider/agent endpoint
 */
export type ExecutionStrategy = 'auto' | 'single' | 'cohort' | 'background' | 'remote';

/** All valid strategy names (including 'auto'). Exported for use in command handlers. */
export const VALID_STRATEGIES: ExecutionStrategy[] = ['auto', 'single', 'cohort', 'background', 'remote'];

/**
 * Typed reason codes emitted with every strategy decision.
 *
 * Each code maps to a human-readable explanation available via
 * `AdaptivePlanner.explainReasonCode()`.
 */
export type StrategyReasonCode =
  // Selection reasons
  | 'OVERRIDE_IN_EFFECT'           // user override is active
  | 'HIGH_RISK_SINGLE_PREFERRED'   // risk score too high for parallelism
  | 'LOW_LATENCY_SINGLE'           // latency budget favours minimal hops
  | 'COHORT_CAPABLE'               // task classified as multi-agent suitable
  | 'BACKGROUND_DEFERRED'          // task suitable for async execution
  | 'REMOTE_CAPABLE'               // remote provider available and suitable
  | 'AUTO_FALLBACK_SINGLE'         // auto mode fell back to single (default)
  // Override reasons
  | 'USER_OVERRIDE'                // explicit user /plan override command
  | 'FLAG_DISABLED'                // adaptive planner feature flag is off
  // Error reasons
  | 'INVALID_STRATEGY';            // unrecognised strategy name

/** Inputs used by the scorer to rank strategy candidates. */
export interface PlannerInputs {
  /** 0-1 risk score: 0 = safe, 1 = highly uncertain / destructive */
  riskScore: number;

  /**
   * Available wall-clock budget in milliseconds.
   * `Infinity` means no latency constraint.
   */
  latencyBudgetMs: number;

  /** Whether the task is classified as multi-step/project (cohort eligible). */
  isMultiStep: boolean;

  /** Whether a remote agent endpoint is currently available. */
  remoteAvailable: boolean;

  /** Whether the task can be safely deferred to a background queue. */
  backgroundEligible: boolean;

  /** Free-form task description (used for logging and explain output). */
  taskDescription?: string;
}

/** A ranked strategy candidate produced by the scorer. */
export interface StrategyCandidate {
  strategy: ExecutionStrategy;
  score: number;       // higher = preferred
  reasonCode: StrategyReasonCode;
}

/** The outcome of a planner selection pass. */
export interface PlannerDecision {
  /** The strategy that was ultimately selected. */
  selected: ExecutionStrategy;

  /** Primary reason code for the selection. */
  reasonCode: StrategyReasonCode;

  /** Full ranked list of all evaluated candidates. */
  candidates: StrategyCandidate[];

  /** Whether a user override was in effect when this decision was made. */
  overrideActive: boolean;

  /** Unix timestamp (ms) of this decision. */
  timestamp: number;

  /** Snapshot of inputs used for this decision. */
  inputs: PlannerInputs;
}

// ---------------------------------------------------------------------------
// Reason code explanations
// ---------------------------------------------------------------------------

const REASON_EXPLANATIONS: Record<StrategyReasonCode, string> = {
  OVERRIDE_IN_EFFECT:
    'A user-supplied /plan override is in effect. The planner\'s automatic '
    + 'selection is bypassed until the override is cleared.',
  HIGH_RISK_SINGLE_PREFERRED:
    'The task risk score exceeds the threshold for parallel execution (>0.7). '
    + 'Single-agent execution is preferred to limit blast radius.',
  LOW_LATENCY_SINGLE:
    'The latency budget is tight (<5 s). Single-call execution avoids '
    + 'coordination overhead.',
  COHORT_CAPABLE:
    'The task is classified as multi-step and the risk score is low enough '
    + 'for coordinated agent fan-out.',
  BACKGROUND_DEFERRED:
    'The task is eligible for background execution: no latency constraint '
    + 'and backgroundEligible is true.',
  REMOTE_CAPABLE:
    'A remote agent endpoint is available and the task is not high risk.',
  AUTO_FALLBACK_SINGLE:
    'Auto mode found no strong signal for parallelism; defaulting to single.',
  USER_OVERRIDE:
    'The strategy was set explicitly by the user via /plan override.',
  FLAG_DISABLED:
    'The adaptive-execution-planner feature flag is disabled; using single.',
  INVALID_STRATEGY:
    'The supplied strategy name is not recognised. No change was made.',
};

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Score a single strategy candidate given the current planner inputs.
 *
 * Returns a numeric score (0-100, higher = preferred) and the primary reason
 * code that drove the score.
 */
function scoreStrategy(
  strategy: ExecutionStrategy,
  inputs: PlannerInputs,
): { score: number; reasonCode: StrategyReasonCode } {
  const {
    riskScore,
    latencyBudgetMs,
    isMultiStep,
    remoteAvailable,
    backgroundEligible,
  } = inputs;

  switch (strategy) {
    case 'single': {
      // Preferred when risk is high or latency budget is tight
      let s = 50;
      if (riskScore > 0.7) s += 30;
      if (latencyBudgetMs < 5_000) s += 20;
      if (!isMultiStep) s += 10;
      const reasonCode: StrategyReasonCode =
        riskScore > 0.7
          ? 'HIGH_RISK_SINGLE_PREFERRED'
          : latencyBudgetMs < 5_000
          ? 'LOW_LATENCY_SINGLE'
          : 'AUTO_FALLBACK_SINGLE';
      return { score: Math.min(s, 100), reasonCode };
    }

    case 'cohort': {
      // Good when multi-step and low risk
      if (!isMultiStep) return { score: 0, reasonCode: 'AUTO_FALLBACK_SINGLE' };
      if (riskScore > 0.7) return { score: 5, reasonCode: 'HIGH_RISK_SINGLE_PREFERRED' };
      const s = 70 + (1 - riskScore) * 20;
      return { score: Math.min(s, 100), reasonCode: 'COHORT_CAPABLE' };
    }

    case 'background': {
      if (!backgroundEligible) return { score: 0, reasonCode: 'AUTO_FALLBACK_SINGLE' };
      if (riskScore > 0.6) return { score: 10, reasonCode: 'HIGH_RISK_SINGLE_PREFERRED' };
      const s = 60 + (latencyBudgetMs === Infinity ? 20 : 0);
      return { score: Math.min(s, 100), reasonCode: 'BACKGROUND_DEFERRED' };
    }

    case 'remote': {
      if (!remoteAvailable) return { score: 0, reasonCode: 'AUTO_FALLBACK_SINGLE' };
      if (riskScore > 0.7) return { score: 5, reasonCode: 'HIGH_RISK_SINGLE_PREFERRED' };
      const s = 65 + (1 - riskScore) * 15;
      return { score: Math.min(s, 100), reasonCode: 'REMOTE_CAPABLE' };
    }

    case 'auto':
      // 'auto' itself is not scored as a candidate — it triggers evaluation of others
      return { score: -1, reasonCode: 'AUTO_FALLBACK_SINGLE' };
  }
}

// ---------------------------------------------------------------------------
// AdaptivePlanner
// ---------------------------------------------------------------------------

export class AdaptivePlanner {
  /** Current user override, or null when the planner runs freely. */
  private overrideStrategy: ExecutionStrategy | null = null;

  /** Current operating mode (default: auto). */
  private mode: ExecutionStrategy = 'auto';

  /** Audit log of all decisions, capped at MAX_HISTORY entries. */
  private history: PlannerDecision[] = [];
  private static readonly MAX_HISTORY = 100;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Select the best execution strategy for the given inputs.
   *
   * - If a user override is active, it is returned immediately with reason
   *   `OVERRIDE_IN_EFFECT`.
   * - If mode is not `auto`, the mode itself is returned (as a pinned choice).
   * - Otherwise all concrete strategies are scored and the highest wins.
   *
   * The decision is appended to the history log.
   */
  select(inputs: PlannerInputs): PlannerDecision {
    const validated = this._validateInputs(inputs);
    const ts = Date.now();
    // Use validated inputs from here on
    // eslint-disable-next-line no-param-reassign
    inputs = validated;

    // User override takes absolute precedence
    if (this.overrideStrategy !== null) {
      const decision: PlannerDecision = {
        selected: this.overrideStrategy,
        reasonCode: 'OVERRIDE_IN_EFFECT',
        candidates: [{ strategy: this.overrideStrategy, score: 100, reasonCode: 'USER_OVERRIDE' }],
        overrideActive: true,
        timestamp: ts,
        inputs,
      };
      this._appendHistory(decision);
      logger.debug('[AdaptivePlanner] override in effect', { strategy: this.overrideStrategy });
      return decision;
    }

    // Pinned mode (not auto)
    if (this.mode !== 'auto') {
      const { score, reasonCode } = scoreStrategy(this.mode, inputs);
      const decision: PlannerDecision = {
        selected: this.mode,
        reasonCode,
        candidates: [{ strategy: this.mode, score, reasonCode }],
        overrideActive: false,
        timestamp: ts,
        inputs,
      };
      this._appendHistory(decision);
      return decision;
    }

    // Auto: score all concrete strategies
    const candidates: StrategyCandidate[] = (['single', 'cohort', 'background', 'remote'] as const)
      .map((s) => {
        const { score, reasonCode } = scoreStrategy(s, inputs);
        return { strategy: s, score, reasonCode } satisfies StrategyCandidate;
      })
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const decision: PlannerDecision = {
      selected: best.strategy,
      reasonCode: best.reasonCode,
      candidates,
      overrideActive: false,
      timestamp: ts,
      inputs,
    };
    this._appendHistory(decision);
    logger.debug('[AdaptivePlanner] auto-selected', {
      strategy: best.strategy,
      reasonCode: best.reasonCode,
      score: best.score,
    });
    return decision;
  }

  /**
   * Set the operating mode for future calls to `select()`.
   *
   * Setting to `'auto'` clears any pinned mode (but does NOT clear a user
   * override — use `clearOverride()` for that).
   */
  setMode(mode: ExecutionStrategy): void {
    this.mode = mode;
    logger.info('[AdaptivePlanner] mode set', { mode });
  }

  /** Get the current operating mode. */
  getMode(): ExecutionStrategy {
    return this.mode;
  }

  /**
   * Apply an explicit user override. Overrides are stronger than mode: even
   * in `auto` mode the override strategy is always returned until cleared.
   *
   * Returns `false` with reason `INVALID_STRATEGY` if the strategy name is
   * not recognised.
   */
  override(
    strategy: string,
  ): { ok: true; strategy: ExecutionStrategy } | { ok: false; reasonCode: StrategyReasonCode } {
    if (!VALID_STRATEGIES.includes(strategy as ExecutionStrategy)) {
      logger.warn('[AdaptivePlanner] invalid override strategy', { strategy });
      return { ok: false, reasonCode: 'INVALID_STRATEGY' };
    }
    const s = strategy as ExecutionStrategy;
    this.overrideStrategy = s === 'auto' ? null : s;
    logger.info('[AdaptivePlanner] user override applied', { strategy: s });
    return { ok: true, strategy: s };
  }

  /** Clear any active user override. */
  clearOverride(): void {
    this.overrideStrategy = null;
    logger.info('[AdaptivePlanner] user override cleared');
  }

  /** Whether a user override is currently active. */
  hasOverride(): boolean {
    return this.overrideStrategy !== null;
  }

  /** Return the active override strategy, or null. */
  getOverride(): ExecutionStrategy | null {
    return this.overrideStrategy;
  }

  /**
   * Return a human-readable explanation of the most recent decision, or of
   * a specific reason code.
   */
  explain(reasonCode?: StrategyReasonCode): string {
    if (reasonCode) {
      return REASON_EXPLANATIONS[reasonCode] ?? `Unknown reason code: ${reasonCode}`;
    }
    const last = this.history[this.history.length - 1];
    if (!last) return 'No decisions have been made yet.';
    return this._formatDecisionExplanation(last);
  }

  /** Return the full static explanation for a reason code. */
  static explainReasonCode(code: StrategyReasonCode): string {
    return REASON_EXPLANATIONS[code] ?? `Unknown reason code: ${code}`;
  }

  /** Return the N most recent decisions (default: 20). */
  getHistory(limit = 20): PlannerDecision[] {
    return this.history.slice(-limit);
  }

  /** Return the most recent decision, or null. */
  getLatest(): PlannerDecision | null {
    return this.history[this.history.length - 1] ?? null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validate and clamp PlannerInputs to safe ranges.
   * Logs a debug warning if any value is out of range.
   */
  private _validateInputs(inputs: PlannerInputs): PlannerInputs {
    const out = { ...inputs };
    if (isNaN(out.riskScore) || out.riskScore < 0 || out.riskScore > 1) {
      logger.debug('[AdaptivePlanner] riskScore out of range, clamping', { riskScore: out.riskScore });
      out.riskScore = isNaN(out.riskScore) ? 0 : Math.max(0, Math.min(1, out.riskScore));
    }
    if (out.latencyBudgetMs < 0) {
      logger.debug('[AdaptivePlanner] latencyBudgetMs negative, clamping to 0', { latencyBudgetMs: out.latencyBudgetMs });
      out.latencyBudgetMs = 0;
    }
    return out;
  }

  private _appendHistory(decision: PlannerDecision): void {
    this.history.push(decision);
    if (this.history.length > AdaptivePlanner.MAX_HISTORY) {
      this.history.shift();
    }
  }

  private _formatDecisionExplanation(decision: PlannerDecision): string {
    const ts = new Date(decision.timestamp).toISOString();
    const override = decision.overrideActive ? ' [USER OVERRIDE]' : '';
    const lines = [
      `Strategy: ${decision.selected.toUpperCase()}${override}`,
      `Reason:   ${decision.reasonCode}`,
      `          ${REASON_EXPLANATIONS[decision.reasonCode]}`,
      `At:       ${ts}`,
      '',
      'Candidate rankings:',
      ...decision.candidates.map(
        (c) => `  ${String(c.score).padStart(3)}  ${c.strategy.padEnd(12)} ${c.reasonCode}`,
      ),
    ];
    const inputs = decision.inputs;
    lines.push(
      '',
      'Inputs:',
      `  riskScore:         ${inputs.riskScore.toFixed(2)}`,
      `  latencyBudgetMs:   ${inputs.latencyBudgetMs === Infinity ? '∞' : inputs.latencyBudgetMs}`,
      `  isMultiStep:       ${inputs.isMultiStep}`,
      `  remoteAvailable:   ${inputs.remoteAvailable}`,
      `  backgroundEligible: ${inputs.backgroundEligible}`,
    );
    if (inputs.taskDescription) {
      lines.push(`  task:              ${inputs.taskDescription.slice(0, 80)}`);
    }
    return lines.join('\n');
  }
}
