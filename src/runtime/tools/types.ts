import type { ToolResult } from '../../types/tools.ts';

/**
 * ToolExecutionPhase — all states in the tool execution machine (v3 Section 4.2).
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
  | 'cancelled';

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
  /** Unix timestamp (ms) when execution began. */
  startedAt: number;
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
