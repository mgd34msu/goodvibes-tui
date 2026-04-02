import type { Tool, ToolCall, ToolResult } from '../../../types/tools.ts';
import { repairToolCall } from '../../../tools/auto-repair.ts';
import type { ToolRuntimeContext } from '../context.ts';
import type { PhaseResult, ToolExecutionRecord } from '../types.ts';

/**
 * mapOutput — Phase 5 of the tool execution pipeline.
 *
 * Transforms/annotates the raw tool result before it reaches the LLM:
 *
 * 1. Applies auto-repair annotation: if args were repaired during
 *    execution, prepends a `[Auto-repaired: ...]` note to the output
 *    so the LLM knows what was corrected.
 * 2. No-ops cleanly when there is no result to map (defensive guard).
 *
 * Future extensions (output truncation, content policy filtering, etc.)
 * should be added here.
 */
export async function mapOutputPhase(
  call: ToolCall,
  tool: Tool,
  _context: ToolRuntimeContext,
  record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  if (!record.result) {
    // No result to map — this is a no-op (execute phase may have failed)
    return {
      phase: 'mapped',
      success: true,
      durationMs: performance.now() - start,
    };
  }

  try {
    // Re-run repair check to determine if the original args were patched
    const effectiveArgs = record._updatedArgs ?? call.arguments;
    const repairResult = repairToolCall(call.name, effectiveArgs, tool.definition);

    if (repairResult.repaired) {
      const repairNote = `[Auto-repaired: ${repairResult.repairs.join(', ')}]`;
      if (typeof record.result.output === 'string') {
        record.result.output = `${repairNote}\n${record.result.output}`;
      } else {
        record.result.output = repairNote;
      }
    }

    return {
      phase: 'mapped',
      success: true,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    // Mapping failure is non-fatal — pass through unmapped result
    const message = err instanceof Error ? err.message : String(err);
    return {
      phase: 'mapped',
      success: true,
      durationMs: performance.now() - start,
      error: `Output mapping failed (non-fatal): ${message}`,
    };
  }
}
