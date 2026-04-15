import type { Tool, ToolCall } from '@pellux/goodvibes-sdk/platform/types/tools';
import { repairToolCall } from '@pellux/goodvibes-sdk/platform/tools/auto-repair';
import type { ToolRuntimeContext } from '../context.ts';
import type { PhaseResult, ToolExecutionRecord } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';
import type { PhasedTool } from '@pellux/goodvibes-sdk/platform/runtime/tools/adapter';
import type { ToolClass } from '@pellux/goodvibes-sdk/platform/runtime/tools/output-policy';
import { applyOutputPolicy, getPolicy } from '@pellux/goodvibes-sdk/platform/runtime/tools/output-policy';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

/**
 * mapOutput — Phase 5 of the tool execution pipeline.
 *
 * Transforms/annotates the raw tool result before it reaches the LLM:
 *
 * 1. Applies auto-repair annotation: if args were repaired during
 *    execution, prepends a `[Auto-repaired: ...]` note to the output
 *    so the LLM knows what was corrected.
 * 2. Applies output policy enforcement: byte limits, truncation, and spill
 *    handling are applied per tool class via `applyOutputPolicy`.
 * 3. No-ops cleanly when there is no result to map (defensive guard).
 */
/** Type guard — true when `tool` carries phased execution metadata. */
function isPhasedTool(tool: Tool): tool is PhasedTool {
  return 'category' in tool && typeof (tool as PhasedTool).category === 'string';
}

/**
 * Maps a PhasedTool category to the ToolClass used by output-policy.
 * `delegate` has no direct output-policy class; treat as `analyze`.
 */
function resolveToolClass(tool: Tool): ToolClass {
  if (!isPhasedTool(tool)) return 'read';
  switch (tool.category) {
    case 'read':     return 'read';
    case 'write':    return 'write';
    case 'execute':  return 'execute';
    case 'network':  return 'network';
    case 'delegate': return 'analyze';
    default:         return 'read';
  }
}

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

    // Apply output policy enforcement after auto-repair annotation
    const toolClass = resolveToolClass(tool);
    const policy = getPolicy(toolClass);
    const auditedResult = applyOutputPolicy(record.result, policy, _context.overflowHandler!);
    record.result = auditedResult.result;

    // Surface spill backend in phase metadata when overflow occurred
    const spillBackend = auditedResult.audit.spillBackend;
    return {
      phase: 'mapped',
      success: true,
      durationMs: performance.now() - start,
      ...(spillBackend ? { spillBackend } : {}),
    };
  } catch (err) {
    // Mapping failure is non-fatal — pass through unmapped result
    const message = summarizeError(err);
    return {
      phase: 'mapped',
      success: true,
      durationMs: performance.now() - start,
      error: `Output mapping failed (non-fatal): ${message}`,
    };
  }
}
