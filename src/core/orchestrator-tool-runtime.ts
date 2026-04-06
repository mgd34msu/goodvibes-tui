import { ToolError, PermissionError } from '../types/errors.ts';
import type { HookEvent, HookEventPath, HookResult } from '../hooks/types.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { PermissionManager } from '../permissions/manager.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitOrchestrationGraphCreated,
  emitOrchestrationNodeAdded,
  emitOrchestrationNodeStarted,
  emitOrchestrationRecursionGuardTriggered,
  emitToolExecuting,
  emitToolFailed,
  emitToolPermissioned,
  emitToolReconciled,
  emitToolReceived,
  emitToolSucceeded,
} from '../runtime/emitters/index.ts';
import { buildSyntheticResult, detectUnresolvedToolCalls, type ReconciliationReason } from './tool-reconciliation.ts';
import { logger } from '../utils/logger.ts';
import { configManager, DEFAULT_CONFIG } from '../config/index.ts';
import { AgentManager } from '../tools/agent/index.ts';
import type { AgentInput } from '../tools/agent/schema.ts';
import type { ExecutionPlan, PlanItem } from './execution-plan.ts';
import { planManager } from './plan-manager-instance.ts';
import { providerRegistry } from '../providers/registry.ts';
import { evaluateOrchestrationSpawn } from '../runtime/orchestration/spawn-policy.ts';

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.ts').EmitterContext;

export type ToolExecutionDeps = {
  toolRegistry: ToolRegistry;
  permissionManager: PermissionManager;
  hookDispatcher: HookDispatcherLike | null;
  runtimeBus: RuntimeEventBus | null;
  sessionId: string;
  emitterContext: EmitterContextFactory;
};

export async function executeToolCalls(
  deps: ToolExecutionDeps,
  turnId: string,
  calls: ToolCall[],
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const call of calls) {
    if (deps.runtimeBus) {
      emitToolReceived(deps.runtimeBus, deps.emitterContext(turnId), {
        callId: call.id,
        turnId,
        tool: call.name,
        args: call.arguments,
      });
    }

    const approved = await deps.permissionManager.check(call.name, call.arguments);
    if (deps.runtimeBus) {
      emitToolPermissioned(deps.runtimeBus, deps.emitterContext(turnId), {
        callId: call.id,
        turnId,
        tool: call.name,
        approved,
      });
    }
    if (!approved) {
      const err = new PermissionError(`Permission denied for tool '${call.name}'`);
      const deniedResult = {
        callId: call.id,
        success: false,
        error: err.message,
      };
      results.push(deniedResult);
      if (deps.runtimeBus) {
        emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          error: err.message,
          durationMs: 0,
          result: deniedResult,
        });
      }
      continue;
    }

    const startedAt = Date.now();
    if (deps.runtimeBus) {
      emitToolExecuting(deps.runtimeBus, deps.emitterContext(turnId), {
        callId: call.id,
        turnId,
        tool: call.name,
        startedAt,
      });
    }

    if (deps.hookDispatcher) {
      try {
        const preEvent: HookEvent = {
          path: `Pre:tool:${call.name}`,
          phase: 'Pre',
          category: 'tool',
          specific: call.name,
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { callId: call.id, tool: call.name, args: call.arguments },
        };
        const preResult = await deps.hookDispatcher.fire(preEvent);
        if (preResult.decision === 'deny') {
          const deniedResult: ToolResult = {
            callId: call.id,
            success: false,
            error: preResult.reason ?? `Tool '${call.name}' denied by hook`,
          };
          if (deps.runtimeBus) {
            emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
              callId: call.id,
              turnId,
              tool: call.name,
              error: deniedResult.error ?? `Tool '${call.name}' denied by hook`,
              durationMs: Date.now() - startedAt,
              result: deniedResult,
            });
          }
          results.push(deniedResult);
          continue;
        }
      } catch (hookErr) {
        logger.error('Orchestrator: Pre hook error', {
          tool: call.name,
          error: hookErr instanceof Error ? hookErr.message : String(hookErr),
        });
      }
    }

    let result: ToolResult;
    try {
      result = await deps.toolRegistry.execute(call.id, call.name, call.arguments);
    } catch (err) {
      const message =
        err instanceof ToolError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      result = {
        callId: call.id,
        success: false,
        error: message,
      };

      if (deps.hookDispatcher) {
        try {
          const failEvent: HookEvent = {
            path: `Fail:tool:${call.name}`,
            phase: 'Fail',
            category: 'tool',
            specific: call.name,
            sessionId: deps.sessionId,
            timestamp: Date.now(),
            payload: { callId: call.id, tool: call.name, error: message },
          };
          await deps.hookDispatcher.fire(failEvent);
        } catch (hookErr) {
          logger.error('Orchestrator: Fail hook error', {
            tool: call.name,
            error: hookErr instanceof Error ? hookErr.message : String(hookErr),
          });
        }
      }
    }

    if (deps.hookDispatcher && result.success === true) {
      try {
        const postEvent: HookEvent = {
          path: `Post:tool:${call.name}`,
          phase: 'Post',
          category: 'tool',
          specific: call.name,
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { callId: call.id, tool: call.name, result },
        };
        await deps.hookDispatcher.fire(postEvent);
      } catch (hookErr) {
        logger.error('Orchestrator: Post hook error', {
          tool: call.name,
          error: hookErr instanceof Error ? hookErr.message : String(hookErr),
        });
      }
    }

    if (deps.runtimeBus) {
      if (result.success) {
        emitToolSucceeded(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          durationMs: Date.now() - startedAt,
          result,
        });
      } else {
        emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          error: result.error ?? 'unknown tool failure',
          durationMs: Date.now() - startedAt,
          result,
        });
      }
    }

    if (deps.hookDispatcher && (call.name === 'write' || call.name === 'edit')) {
      const filePath = typeof call.arguments['path'] === 'string' ? call.arguments['path'] :
        (Array.isArray(call.arguments['files']) ? JSON.stringify(call.arguments['files']) : '');
      if (result.success) {
        deps.hookDispatcher.fire({
          path: `Post:file:${call.name}` as HookEventPath,
          phase: 'Post',
          category: 'file',
          specific: call.name,
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { tool: call.name, path: filePath, callId: call.id },
        }).catch((err: unknown) => { logger.debug(`Post:file:${call.name} hook error`, { error: String(err) }); });
      } else {
        deps.hookDispatcher.fire({
          path: `Fail:file:${call.name}` as HookEventPath,
          phase: 'Fail',
          category: 'file',
          specific: call.name,
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { tool: call.name, path: filePath, callId: call.id, error: result.error },
        }).catch((err: unknown) => { logger.debug(`Fail:file:${call.name} hook error`, { error: String(err) }); });
      }
    }

    if (result.success && result.output && call.name === 'read') {
      try {
        const parsed = JSON.parse(result.output) as Record<string, unknown>;
        if (Array.isArray(parsed['images']) && (parsed['images'] as unknown[]).length > 0) {
          const images = parsed['images'] as Array<{ path: string; base64: string; mediaType: string; description: string }>;
          delete parsed['images'];
          if (parsed['files'] && typeof parsed['files'] === 'object') {
            for (const key of Object.keys(parsed['files'] as Record<string, unknown>)) {
              const f = (parsed['files'] as Record<string, unknown>)[key];
              if (f && typeof f === 'object') {
                delete (f as Record<string, unknown>)['imageData'];
              }
            }
          }
          result.output = JSON.stringify(parsed);
          (result as ToolResult & { _images?: typeof images })._images = images;
        }
      } catch {
        // leave result as-is
      }
    }

    results.push(result);
  }

  return results;
}

export type ReconciliationDeps = {
  conversation: { addToolResults: (results: ToolResult[]) => void; addSystemMessage: (message: string) => void };
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  isReconciliationEnabled: () => boolean;
  currentSubmissionKey: string | null;
  pendingToolCalls: ToolCall[];
  setPendingToolCalls: (calls: ToolCall[]) => void;
};

export function reconcileUnresolvedToolCalls(
  deps: ReconciliationDeps,
  resolvedResults: ToolResult[],
  reason: ReconciliationReason,
): void {
  const pending = deps.pendingToolCalls;
  if (pending.length === 0) return;

  const unresolved = detectUnresolvedToolCalls(pending, resolvedResults);
  if (unresolved.length === 0) {
    deps.setPendingToolCalls([]);
    return;
  }

  if (!deps.isReconciliationEnabled()) {
    logger.warn(
      'Orchestrator: unresolved tool calls detected but reconciliation is disabled. ' +
      'Enable the tool-result-reconciliation flag to suppress this.',
      { count: unresolved.length, callIds: unresolved.map((c) => c.id), reason },
    );
    deps.setPendingToolCalls([]);
    return;
  }

  const syntheticResults = unresolved.map((call) => buildSyntheticResult(call, reason));
  deps.conversation.addToolResults(syntheticResults);

  const turnId = deps.currentSubmissionKey ?? `reconciled:${Date.now()}`;

  for (const sr of syntheticResults) {
    if (deps.runtimeBus) {
      emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
        callId: sr.callId,
        turnId,
        tool: unresolved.find((call) => call.id === sr.callId)?.name ?? 'unknown',
        error: sr.error ?? 'synthetic tool reconciliation failure',
        durationMs: 0,
        result: sr,
      });
    }
  }

  deps.conversation.addSystemMessage(
    `[Tool Reconciliation] ${unresolved.length} tool call(s) (${unresolved.map((c) => `'${c.name}'`).join(', ')}) were not executed before ` +
    `the turn ended. Synthetic error results have been injected. ` +
    `Review the situation and avoid repeating the same tool calls if the root cause has not changed.`,
  );

  if (deps.runtimeBus) {
    emitToolReconciled(deps.runtimeBus, deps.emitterContext(turnId), {
      turnId,
      count: unresolved.length,
      callIds: unresolved.map((c) => c.id),
      toolNames: unresolved.map((c) => c.name),
      reason,
      timestamp: Date.now(),
    });
  }

  logger.warn('Orchestrator: reconciled unresolved tool calls', {
    count: unresolved.length,
    callIds: unresolved.map((c) => c.id),
    reason,
  });

  deps.setPendingToolCalls([]);
}

export function autoSpawnPendingItems(
  conversation: { addSystemMessage: (message: string) => void },
  plan: ExecutionPlan,
  items: PlanItem[],
  runtimeBus: RuntimeEventBus | null = null,
  emitterContext: import('../runtime/emitters/index.ts').EmitterContext | null = null,
): string[] {
  const agentManager = AgentManager.getInstance();
  const currentModel = providerRegistry.getCurrentModel();
  const graphId = `plan:${plan.id}`;
  const ctx = runtimeBus && emitterContext
    ? {
        ...emitterContext,
        traceId: `${emitterContext.traceId}:${graphId}`,
      }
    : null;

  if (runtimeBus && ctx) {
    emitOrchestrationGraphCreated(runtimeBus, ctx, {
      graphId,
      title: plan.title,
      mode: 'graph-execute',
    });
  }

  let running = agentManager.list().filter(a => a.status === 'running' || a.status === 'pending').length;
  const spawnDecision = evaluateOrchestrationSpawn({
    mode: 'plan-auto',
    activeAgents: running,
    requestedDepth: 1,
  });

  if (!spawnDecision.allowed) {
    if (runtimeBus && ctx) {
      emitOrchestrationRecursionGuardTriggered(runtimeBus, ctx, {
        graphId,
        depth: 1,
        activeAgents: running,
        reason: spawnDecision.reason ?? 'plan auto-spawn is currently blocked',
      });
    }
    return [];
  }

  const spawned: string[] = [];

  for (const item of items) {
    if (runtimeBus && ctx) {
      emitOrchestrationNodeAdded(runtimeBus, ctx, {
        graphId,
        nodeId: item.id,
        title: item.description,
        role: 'engineer',
        dependsOn: item.dependencies ?? [],
        taskId: item.id,
      });
    }

    const decision = evaluateOrchestrationSpawn({
      mode: 'plan-auto',
      activeAgents: running,
      requestedDepth: 1,
    });
    if (!decision.allowed) {
      if (runtimeBus && ctx) {
        emitOrchestrationRecursionGuardTriggered(runtimeBus, ctx, {
          graphId,
          nodeId: item.id,
          depth: 1,
          activeAgents: running,
          reason: decision.reason ?? 'plan auto-spawn is currently blocked',
        });
      }
      conversation.addSystemMessage(
        `[Plan] ${decision.reason ?? `Agent limit reached (${running}/${decision.maxAgents}). Remaining items will be spawned as agents complete.`}`
      );
      break;
    }

    try {
      const spawnInput: AgentInput = {
        mode: 'spawn',
        task: item.description,
        template: 'engineer',
        model: currentModel.id,
      };
      const agentRecord = agentManager.spawn(spawnInput);
      if (runtimeBus && ctx) {
        emitOrchestrationNodeStarted(runtimeBus, ctx, {
          graphId,
          nodeId: item.id,
          taskId: item.id,
          agentId: agentRecord.id,
        });
      }
      planManager.updateItem(plan.id, item.id, 'in_progress', agentRecord.id);
      spawned.push(item.description);
      running++;
      logger.info('Orchestrator: Auto-spawned agent for plan item', {
        agentId: agentRecord.id,
        planItemId: item.id,
        description: item.description,
      });
    } catch (spawnErr) {
      logger.error('Orchestrator: Failed to auto-spawn agent for plan item', {
        planItemId: item.id,
        error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
      });
    }
  }

  return spawned;
}
