import type { Tool, ToolCall } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ToolRuntimeContext } from '@pellux/goodvibes-sdk/platform/runtime/tools/context';
import type { PhaseResult, ToolExecutionRecord } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';

/**
 * validate — Phase 1 of the tool execution pipeline.
 *
 * Performs lightweight pre-flight checks:
 * - The call has a non-empty id
 * - The call has a non-empty tool name
 * - Args is a plain object (not null)
 * - The tool object is present
 *
 * Heavy schema validation (JSON Schema against parameters) is intentionally
 * left to a future tier — this phase acts as a guard against programmer
 * errors and malformed LLM payloads.
 */
export async function validatePhase(
  call: ToolCall,
  tool: Tool,
  _context: ToolRuntimeContext,
  _record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  if (!call.id || call.id.trim().length === 0) {
    return result(start, false, 'Tool call is missing a valid id');
  }

  if (!call.name || call.name.trim().length === 0) {
    return result(start, false, 'Tool call is missing a tool name');
  }

  if (call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
    return result(start, false, `Tool call args must be a plain object, got: ${typeof call.arguments}`);
  }

  if (!tool || typeof tool.execute !== 'function') {
    return result(start, false, `Tool '${call.name}' is not a valid tool implementation`);
  }

  return result(start, true);
}

function result(start: number, success: boolean, error?: string): PhaseResult {
  return {
    phase: 'validated',
    success,
    durationMs: performance.now() - start,
    error,
    abort: success ? undefined : true,
  };
}
