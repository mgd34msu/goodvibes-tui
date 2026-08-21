/**
 * turn-budget-outcome.ts, render a turn-budget exhaustion as an honest budget
 * line, distinct from an infrastructure failure.
 *
 * When a member agent spends its whole turn budget the SDK stamps a typed
 * outcome, failureKind 'max_turns' with the ceiling that applied and which
 * input set it, instead of leaving consumers to regex a prose message. This
 * renders that typed outcome in plain language: a budget was reached (not a
 * crash), with the number and where the number came from.
 */
export type TurnBudgetSource = 'default' | 'spawn-override' | 'policy-bound';

/** Plain-language provenance for a turn ceiling. */
export function describeTurnBudgetSource(source: TurnBudgetSource | undefined): string {
  switch (source) {
    case 'spawn-override':
      return 'a per-spawn override';
    case 'policy-bound':
      return 'the policy cap (agents.maxTurnsCap)';
    case 'default':
      return 'the default limit (agents.maxTurns)';
    default:
      return 'the configured turn limit';
  }
}

export interface TurnBudgetOutcome {
  readonly limit?: number | undefined;
  readonly source?: TurnBudgetSource | undefined;
}

/**
 * A short budget line: "reached its turn budget, 50 turns (the default limit
 * (agents.maxTurns))". Honest about the fact that the run stopped because it hit
 * a ceiling, not because something broke.
 */
export function formatTurnBudgetOutcome(outcome: TurnBudgetOutcome): string {
  const source = describeTurnBudgetSource(outcome.source);
  return outcome.limit !== undefined
    ? `reached its turn budget: ${outcome.limit} turn${outcome.limit === 1 ? '' : 's'} (${source})`
    : `reached its turn budget (${source})`;
}

/** The machine-readable failure reason the SDK stamps on a turn-budget exhaustion. */
export const TURN_BUDGET_FAILURE_REASON = 'max_turns';

export function isTurnBudgetReason(reason: string | null | undefined): boolean {
  return reason === TURN_BUDGET_FAILURE_REASON;
}

/**
 * Render a failure-reason string for a surface that only has the reason (not the
 * typed limit/source event fields), mapping the machine-readable 'max_turns' to
 * a plain budget phrase distinct from an infrastructure failure. Any other
 * reason passes through unchanged.
 */
export function describeFailureReason(reason: string | null | undefined): string {
  if (!reason) return '';
  return isTurnBudgetReason(reason) ? 'reached its turn budget' : reason;
}
