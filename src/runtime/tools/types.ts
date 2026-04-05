import type { ToolResult } from '../../types/tools.ts';

/**
 * BudgetExceedReason — typed discriminant for budget breach events.
 *
 * Emitted as part of PhaseResult.budgetExceedReason when a budget phase
 * terminates the pipeline due to a hard budget violation.
 */
export type BudgetExceedReason =
  | 'BUDGET_EXCEEDED_MS'
  | 'BUDGET_EXCEEDED_TOKENS'
  | 'BUDGET_EXCEEDED_COST';

/**
 * ToolExecutionPhase — all states in the tool execution machine.
 *
 * Transitions:
 *   received → validated → prehooked → permissioned → executing → mapped → posthooked
 *   Any phase → failed | cancelled
 *   posthooked → succeeded
 */
export type ToolExecutionPhase =
  | 'received'
  | 'validated'
  | 'prehooked'
  | 'permissioned'
  | 'executing'
  | 'mapped'
  | 'posthooked'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget-entry'
  | 'budget-exit';

/**
 * PhaseResult — outcome of a single pipeline phase.
 */
export interface PhaseResult {
  /** The phase that produced this result. */
  phase: ToolExecutionPhase;
  /** Whether the phase completed without error. */
  success: boolean;
  /** Wall-clock duration of this phase in milliseconds. */
  durationMs: number;
  /** Human-readable error message if the phase failed. */
  error?: string;
  /**
   * If true, the executor will skip all remaining phases and return
   * the current result immediately (e.g. permission denied).
   */
  abort?: boolean;
  /**
   * When a budget phase aborts the pipeline, this carries the typed reason
   * so the executor can emit a diagnostic event with the correct discriminant.
   */
  budgetExceedReason?: BudgetExceedReason;
  /**
   * Additional numeric metadata about the budget breach (e.g. limit and actual values).
   * Surfaced in the BUDGET_EXCEEDED_* event payload for diagnostics.
   */
  budgetMeta?: Record<string, number>;
  /**
   * When the map-output phase spilled overflow content, this carries the
   * backend type used (`file`, `ledger`, or `diagnostics`).
   * Surfaced in phase metadata for operator diagnostics.
   */
  spillBackend?: import('../../tools/shared/overflow.ts').SpillBackendType;
}

/**
 * ToolExecutionRecord — full trace of a tool call through the pipeline.
 * Persists in the executor until explicitly cleared.
 */
export interface ToolExecutionRecord {
  /** Unique tool call identifier (matches ToolCall.id). */
  callId: string;
  /** Name of the tool being executed. */
  toolName: string;
  /** Ordered list of phase results accumulated during execution. */
  phases: PhaseResult[];
  /** The phase currently being executed (or terminal phase on completion). */
  currentPhase: ToolExecutionPhase;
  /** Monotonic timestamp (ms) from performance.now() when execution began. Used for elapsed-time budget checks. */
  startedAt: number;
  /** Wall-clock timestamp (ms) from Date.now() when execution began. Used for display/logging. */
  wallStartedAt?: number;
  /** Unix timestamp (ms) when execution completed (success, failure, or cancel). */
  completedAt?: number;
  /** Final tool result (set on success). */
  result?: ToolResult;
  /** Whether this execution was cancelled. */
  cancelled: boolean;
  /** Human-readable cancellation reason if cancelled. */
  cancelledReason?: string;
  /**
   * Args updated by the prehook phase.
   * Subsequent phases (permission, execute, map-output) use these instead of
   * the original call.arguments when present.
   */
  _updatedArgs?: Record<string, unknown>;
}

/**
 * ExecutorConfig — controls which pipeline features are active.
 */
export interface ExecutorConfig {
  /**
   * Per-phase timeout overrides in milliseconds.
   * Phases without an entry use the phase's own default.
   */
  phaseTimeouts?: Partial<Record<ToolExecutionPhase, number>>;
  /** Whether to fire pre/post hooks via HookDispatcher. */
  enableHooks: boolean;
  /** Whether to check permissions via PermissionManager before execution. */
  enablePermissions: boolean;
  /** Whether to emit RuntimeEventBus events at each phase transition. */
  enableEvents: boolean;
  /**
   * Whether to enforce runtime budget limits (time, tokens, cost) at phase
   * entry and exit. When disabled, budget fields on ToolRuntimeContext are
   * ignored. Controlled by the `runtime-tools-budget-enforcement` feature flag.
   */
  enableBudgetEnforcement?: boolean;
  /**
   * Optional idempotency store.
   *
   * When provided, the executor checks each tool call against the store before
   * entering the pipeline phase:
   * - `'new'`        → proceed normally.
   * - `'in-flight'`  → reject immediately with an error result.
   * - `'duplicate'`  → return the cached result without re-executing.
   *
   * Omit to disable idempotency checking (default behaviour).
   */
  idempotencyStore?: import('../idempotency/index.ts').IdempotencyStore;
}
