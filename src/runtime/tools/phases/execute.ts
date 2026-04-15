import type { Tool, ToolCall, ToolResult } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ToolRuntimeContext } from '../context.ts';
import type { ExecutorConfig, PhaseResult, ToolExecutionRecord } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

/** Default per-call execution timeout (30 seconds). */
const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;

/**
 * execute — Phase 4 of the tool execution pipeline.
 *
 * Calls `tool.execute(args)` and injects the callId into the result.
 * Respects the phase timeout and the budget.maxMs constraint.
 * Caught errors produce a failed PhaseResult (not thrown) so the
 * executor can record the failure trace cleanly.
 *
 * The resolved args honour any prehook-modified input stored as
 * `_updatedArgs` on the record.
 */
export async function executePhase(
  call: ToolCall,
  tool: Tool,
  context: ToolRuntimeContext,
  record: ToolExecutionRecord,
  config?: ExecutorConfig,
): Promise<PhaseResult & { toolResult?: ToolResult }> {
  const start = performance.now();

  const effectiveArgs = record._updatedArgs ?? call.arguments;

  // Resolve timeout: per-phase override → budget → default
  const timeoutMs =
    config?.phaseTimeouts?.['executing'] ?? context.budget?.maxMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Race between the tool and a timeout; clear the timer regardless of outcome
    const rawResult = await Promise.race([
      tool.execute(effectiveArgs),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Tool '${call.name}' timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    clearTimeout(timer);

    const toolResult: ToolResult = { ...rawResult, callId: call.id };

    return {
      phase: 'executing',
      success: true,
      durationMs: performance.now() - start,
      toolResult,
    };
  } catch (err) {
    clearTimeout(timer);
    const message = summarizeError(err);
    return {
      phase: 'executing',
      success: false,
      durationMs: performance.now() - start,
      error: message,
      abort: true,
    };
  }
}
