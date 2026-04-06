import type { Tool, ToolCall } from '../../../types/tools.ts';
import type { ToolRuntimeContext } from '../context.ts';
import type { PhaseResult, ToolExecutionRecord } from '../types.ts';
import {
  emitPermissionDecision,
  emitPermissionRequested,
} from '../../emitters/permissions.ts';
import type { PermissionCheckResult } from '../../../permissions/types.ts';

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

  const resolvePermissionResult = async (): Promise<PermissionCheckResult> => {
    const manager = context.permissionManager as unknown as {
      checkDetailed?: (toolName: string, args: Record<string, unknown>) => Promise<PermissionCheckResult>;
      check?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
      getCategory: (toolName: string) => string;
    };

    if (typeof manager.checkDetailed === 'function') {
      return manager.checkDetailed(call.name, effectiveArgs);
    }

    if (typeof manager.check === 'function') {
      const approved = await manager.check(call.name, effectiveArgs);
      return {
        approved,
        persisted: false,
        sourceLayer: approved ? 'config_policy' : 'user_prompt',
        reasonCode: approved ? 'config_allow' : 'user_denied',
        analysis: {
          classification: 'generic',
          riskLevel: 'medium',
          summary: `Permission ${approved ? 'approved' : 'denied'} for ${call.name}`,
          reasons: [],
        },
      };
    }

    throw new Error('PermissionManager is missing both checkDetailed() and check()');
  };

  try {
    if (context.runtimeBus) {
      const analysis = await resolvePermissionResult();
      emitPermissionRequested(context.runtimeBus, {
        sessionId: context.ids.sessionId,
        traceId: context.ids.traceId,
        source: 'permission-manager',
      }, {
        callId: call.id,
        tool: call.name,
        args: effectiveArgs,
        category: context.permissionManager.getCategory(call.name),
        classification: analysis.analysis.classification,
        riskLevel: analysis.analysis.riskLevel,
        summary: analysis.analysis.summary,
        reasons: analysis.analysis.reasons,
      });

      emitPermissionDecision(context.runtimeBus, {
        sessionId: context.ids.sessionId,
        traceId: context.ids.traceId,
        source: 'permission-manager',
      }, {
        callId: call.id,
        tool: call.name,
        approved: analysis.approved,
        source: 'permission-manager',
        sourceLayer: analysis.sourceLayer,
        persisted: analysis.persisted,
        reasonCode: analysis.reasonCode,
        classification: analysis.analysis.classification,
        riskLevel: analysis.analysis.riskLevel,
        summary: analysis.analysis.summary,
      });

      if (!analysis.approved) {
        return {
          phase: 'permissioned',
          success: false,
          durationMs: performance.now() - start,
          error: `Permission denied for tool '${call.name}'`,
          abort: true,
        };
      }
    } else {
      const analysis = await resolvePermissionResult();
      if (!analysis.approved) {
        return {
          phase: 'permissioned',
          success: false,
          durationMs: performance.now() - start,
          error: `Permission denied for tool '${call.name}'`,
          abort: true,
        };
      }
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
