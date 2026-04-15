import type { Tool, ToolCall } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ToolRuntimeContext } from '../context.ts';
import type { PhaseResult, ToolExecutionRecord } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

/**
 * posthook — Phase 6 of the tool execution pipeline.
 *
 * Fires `Post:tool:<toolName>` hook via the HookDispatcher.
 *
 * Post-hooks are non-blocking in the following sense: a hook failure does
 * NOT fail the tool call. The phase always returns success=true so the
 * executor can proceed to `succeeded`. Hook errors are captured in the
 * PhaseResult.error field for observability without aborting the call.
 */
export async function posthookPhase(
  call: ToolCall,
  _tool: Tool,
  context: ToolRuntimeContext,
  record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  try {
    await context.hookDispatcher.fire({
      path: `Post:tool:${call.name}`,
      phase: 'Post',
      category: 'tool',
      specific: call.name,
      sessionId: context.ids.sessionId,
      timestamp: Date.now(),
      payload: {
        callId: call.id,
        toolName: call.name,
        args: record._updatedArgs ?? call.arguments,
        result: record.result,
        success: record.result?.success ?? false,
      },
      agentId: context.agent?.agentId,
    });

    return {
      phase: 'posthooked',
      success: true,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    // Post-hook failure must not fail the tool call
    const message = summarizeError(err);
    return {
      phase: 'posthooked',
      success: true,
      durationMs: performance.now() - start,
      error: `Post-hook threw (non-fatal): ${message}`,
    };
  }
}
