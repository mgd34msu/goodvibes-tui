import type { Tool, ToolCall } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ToolRuntimeContext } from '@pellux/goodvibes-sdk/platform/runtime/tools/context';
import type { PhaseResult, ToolExecutionRecord } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';

/**
 * prehook — Phase 2 of the tool execution pipeline.
 *
 * Fires `Pre:tool:<toolName>` hook via the HookDispatcher.
 * If the hook returns a `deny` decision, execution is aborted.
 * If the hook returns `updatedInput`, the record's args are updated
 * in-place so subsequent phases see the modified arguments.
 *
 * Hook failures (network, timeout, etc.) are treated as allow to avoid
 * blocking tool execution on non-critical infrastructure errors.
 */
export async function prehookPhase(
  call: ToolCall,
  _tool: Tool,
  context: ToolRuntimeContext,
  record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  try {
    const hookResult = await context.hookDispatcher.fire({
      path: `Pre:tool:${call.name}`,
      phase: 'Pre',
      category: 'tool',
      specific: call.name,
      sessionId: context.ids.sessionId,
      timestamp: Date.now(),
      payload: {
        callId: call.id,
        toolName: call.name,
        args: call.arguments,
      },
      agentId: context.agent?.agentId,
    });

    if (hookResult.decision === 'deny') {
      return {
        phase: 'prehooked',
        success: false,
        durationMs: performance.now() - start,
        error: hookResult.reason ?? 'Pre-hook denied tool execution',
        abort: true,
      };
    }

    // Allow hooks to modify input arguments for subsequent phases
    if (hookResult.updatedInput) {
      record._updatedArgs = hookResult.updatedInput;
    }

    return {
      phase: 'prehooked',
      success: true,
      durationMs: performance.now() - start,
    };
  } catch (_err) {
    // Hook infrastructure failure — allow execution to proceed
    return {
      phase: 'prehooked',
      success: true,
      durationMs: performance.now() - start,
    };
  }
}
