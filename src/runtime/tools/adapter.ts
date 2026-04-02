import type { Tool, ToolResult } from '../../types/tools.ts';

/**
 * Execution phases for the phased tool executor.
 * Tools move through these phases in order; some tools may skip certain phases.
 */
export type ToolExecutionPhase =
  | 'prehook'    // Pre-execution hooks (permissions, logging, validation)
  | 'executing'  // The actual tool execution
  | 'posthook';  // Post-execution hooks (audit trail, side effects)

/**
 * A PhasedTool wraps a legacy Tool with metadata the phased executor uses
 * to configure routing, phase skipping, timeouts, and cancellation.
 *
 * All existing Tool implementations remain valid; PhasedTool is purely additive.
 * The `execute` contract is unchanged — callers that use the legacy ToolRegistry
 * path continue working without modification.
 */
export interface PhasedTool extends Tool {
  /**
   * Tool category for permission classification and audit.
   *
   * - `read`     — reads data without side effects (files, network GETs)
   * - `write`    — creates or modifies persistent state (files, database)
   * - `execute`  — runs arbitrary code or shell commands
   * - `delegate` — spawns sub-agents or recursive tool calls
   * - `network`  — performs network I/O beyond simple reads
   */
  category: 'read' | 'write' | 'execute' | 'delegate' | 'network';

  /**
   * Phases to skip for this tool.
   * For example, low-risk read tools may skip `prehook` and `posthook`
   * to avoid unnecessary permission checks and audit overhead.
   */
  skipPhases?: ToolExecutionPhase[];

  /**
   * Per-phase timeout overrides in milliseconds.
   * If not set, the phased executor's global defaults apply.
   * Only meaningful for `executing` in most cases; hook phases are fast.
   */
  phaseTimeouts?: Partial<Record<ToolExecutionPhase, number>>;

  /**
   * Whether this tool supports cooperative cancellation via AbortSignal.
   * If `true`, the phased executor passes `context.signal` and may abort
   * the `executing` phase early. Non-cancellable tools ignore the signal.
   */
  cancellable: boolean;
}

/**
 * Wraps a legacy Tool in a PhasedTool by merging the phased metadata.
 * Use this in `createPhasedExecTool` / `createPhasedReadTool` factories
 * to avoid duplicating the underlying tool's `definition` and `execute`.
 *
 * @param tool     - The existing Tool implementation to wrap.
 * @param options  - Phased execution metadata to attach.
 * @returns A PhasedTool that delegates execution to the original tool.
 */
export function asPhasedTool(
  tool: Tool,
  options: {
    category: PhasedTool['category'];
    cancellable: boolean;
    skipPhases?: ToolExecutionPhase[];
    phaseTimeouts?: Partial<Record<ToolExecutionPhase, number>>;
  },
): PhasedTool {
  return {
    definition: tool.definition,
    execute: tool.execute.bind(tool),
    category: options.category,
    cancellable: options.cancellable,
    skipPhases: options.skipPhases,
    phaseTimeouts: options.phaseTimeouts,
  };
}
