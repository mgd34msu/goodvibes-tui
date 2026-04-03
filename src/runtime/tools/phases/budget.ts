import type { Tool, ToolCall } from '../../../types/tools.ts';
import type { ToolRuntimeContext } from '../context.ts';
import type { BudgetExceedReason, PhaseResult, ToolExecutionPhase, ToolExecutionRecord } from '../types.ts';

/**
 * budget — Budget enforcement phase for the tool execution pipeline.
 *
 * This phase is inserted at two points:
 *  - "entry": just before execute (checks elapsed wall-clock time).
 *  - "exit": just after mapOutput (checks token and cost budgets).
 *
 * When a hard budget is exceeded the phase returns `abort: true` with a
 * typed `budgetExceedReason` so the executor can surface a diagnostic
 * event before terminating the pipeline.
 *
 * All budget fields are optional in ToolRuntimeContext.budget — an absent
 * field means "unlimited" and the corresponding check is skipped.
 */

/** The point in the pipeline at which the budget check fires. */
export type BudgetCheckPoint = 'entry' | 'exit';

export async function budgetPhase(
  _call: ToolCall,
  _tool: Tool,
  context: ToolRuntimeContext,
  record: ToolExecutionRecord,
  checkpoint: BudgetCheckPoint,
): Promise<PhaseResult> {
  const start = performance.now();
  const phaseName = checkpoint === 'entry' ? 'budget-entry' : 'budget-exit';

  const budget = context.budget;

  // No budget constraints — fast path
  if (!budget) {
    return ok(start, phaseName);
  }

  const elapsedMs = performance.now() - record.startedAt;

  // ── Time budget (checked at both entry and exit) ────────────────────────
  // All budget comparisons use strict > so that a value exactly at the limit is
  // still allowed — enforcement fires only when the limit is truly exceeded.
  if (budget.maxMs !== undefined && elapsedMs > budget.maxMs) {
    return exceed(start, phaseName, 'BUDGET_EXCEEDED_MS', {
      limitMs: budget.maxMs,
      elapsedMs,
    });
  }

  // ── Token and cost budgets (only meaningful at exit after execute ran) ──
  if (checkpoint === 'exit') {
    // Token budget: the tool result may carry a `tokenCount` annotation.
    // We check it if present; if absent we skip (cannot enforce unknown usage).
    const tokenCount = getTokenCount(record);
    if (budget.maxTokens !== undefined && tokenCount !== undefined && tokenCount > budget.maxTokens) {
      return exceed(start, phaseName, 'BUDGET_EXCEEDED_TOKENS', {
        limitTokens: budget.maxTokens,
        usedTokens: tokenCount,
      });
    }

    // Cost budget: same — only enforce when the tool result carries a cost.
    const costUsd = getCostUsd(record);
    if (budget.maxCostUsd !== undefined && costUsd !== undefined && costUsd > budget.maxCostUsd) {
      return exceed(start, phaseName, 'BUDGET_EXCEEDED_COST', {
        limitCostUsd: budget.maxCostUsd,
        usedCostUsd: costUsd,
      });
    }
  }

  return ok(start, phaseName);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(start: number, phase: ToolExecutionPhase): PhaseResult {
  return {
    phase,
    success: true,
    durationMs: performance.now() - start,
  };
}

function exceed(
  start: number,
  phase: ToolExecutionPhase,
  reason: BudgetExceedReason,
  meta: Record<string, number>,
): PhaseResult {
  const parts = Object.entries(meta)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return {
    phase,
    success: false,
    durationMs: performance.now() - start,
    error: `Budget exceeded [${reason}]: ${parts}`,
    abort: true,
    budgetExceedReason: reason,
    budgetMeta: meta,
  };
}

/**
 * Extracts a token count from the tool execution record result, if available.
 * Tools may annotate their result with `tokenCount` as a numeric field.
 */
function getTokenCount(record: ToolExecutionRecord): number | undefined {
  if (!record.result) return undefined;
  // Double cast needed: ToolResult has no index signature, but tool implementations
  // may annotate results with extra numeric fields like `tokenCount`.
  const raw = (record.result as unknown as Record<string, unknown>)['tokenCount'];
  return typeof raw === 'number' ? raw : undefined;
}

/**
 * Extracts a cost annotation from the tool execution record result, if available.
 * Tools may annotate their result with `costUsd` as a numeric field.
 */
function getCostUsd(record: ToolExecutionRecord): number | undefined {
  if (!record.result) return undefined;
  // Double cast needed: same reason as getTokenCount above.
  const raw = (record.result as unknown as Record<string, unknown>)['costUsd'];
  return typeof raw === 'number' ? raw : undefined;
}
