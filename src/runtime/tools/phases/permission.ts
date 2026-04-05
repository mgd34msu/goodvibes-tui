import type { Tool, ToolCall } from '../../../types/tools.ts';
import type { ToolRuntimeContext } from '../context.ts';
import type { PhaseResult, ToolExecutionRecord } from '../types.ts';
import {
  emitPermissionDecision,
  emitPermissionRequested,
} from '../../emitters/permissions.ts';

/**
 * permission — Phase 3 of the tool execution pipeline.
 *
 * Delegates to PermissionManager.check(). If permission is denied,
 * the phase aborts and no further phases are run.
 *
 * The resolved args used here account for any input updates from the
 * prehook phase (stored as `_updatedArgs` on the record).
 */
export async function permissionPhase(
  call: ToolCall,
  _tool: Tool,
  context: ToolRuntimeContext,
  record: ToolExecutionRecord,
): Promise<PhaseResult> {
  const start = performance.now();

  // Use updated args from prehook if present
  const effectiveArgs = record._updatedArgs ?? call.arguments;

  try {
    if (context.runtimeBus) {
      emitPermissionRequested(context.runtimeBus, {
        sessionId: context.ids.sessionId,
        traceId: context.ids.traceId,
        source: 'permission-phase',
      }, {
        callId: call.id,
        tool: call.name,
        args: effectiveArgs,
        category: context.permissionManager.getCategory(call.name),
      });
    }

    const approved = await context.permissionManager.check(call.name, effectiveArgs);

    if (context.runtimeBus) {
      emitPermissionDecision(context.runtimeBus, {
        sessionId: context.ids.sessionId,
        traceId: context.ids.traceId,
        source: 'permission-phase',
      }, {
        callId: call.id,
        tool: call.name,
        approved,
        source: 'permission-manager',
      });
    }

    if (!approved) {
      return {
        phase: 'permissioned',
        success: false,
        durationMs: performance.now() - start,
        error: `Permission denied for tool '${call.name}'`,
        abort: true,
      };
    }

    return {
      phase: 'permissioned',
      success: true,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      phase: 'permissioned',
      success: false,
      durationMs: performance.now() - start,
      error: `Permission check threw: ${message}`,
      abort: true,
    };
  }
}
