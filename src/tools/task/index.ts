import type { Tool } from '../../types/tools.ts';
import { getSessionOrchestration } from '../../sessions/orchestration/index.ts';
import { TASK_TOOL_SCHEMA, type TaskToolInput } from './schema.ts';

const DEFAULT_SESSION_ID = 'local';

export const taskTool: Tool = {
  definition: {
    name: 'task',
    description: 'Manage durable cross-session task refs, dependencies, cancellations, and handoffs.',
    parameters: TASK_TOOL_SCHEMA as unknown as Record<string, unknown>,
    sideEffects: ['workflow', 'state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as TaskToolInput;
    const registry = getSessionOrchestration();
    const sessionId = input.sessionId?.trim() || DEFAULT_SESSION_ID;

    if (input.mode === 'create') {
      if (!input.taskId || !input.title) {
        return { success: false, error: 'create requires taskId and title.' };
      }
      const now = Date.now();
      const result = registry.linkTask({
        sessionId,
        taskId: input.taskId,
        title: input.title,
        status: input.status ?? 'queued',
        createdAt: now,
        updatedAt: now,
        ...(input.label ? { label: input.label } : {}),
      });
      if (!result.ok) return { success: false, error: result.error ?? 'task link failed' };
      return { success: true, output: JSON.stringify(registry.getRef(sessionId, input.taskId)) };
    }

    if (input.mode === 'list') {
      const refs = registry.getRefsBySession(sessionId);
      return { success: true, output: JSON.stringify({ sessionId, count: refs.length, refs }) };
    }

    if (input.mode === 'show') {
      if (!input.taskId) return { success: false, error: 'show requires taskId.' };
      const ref = registry.getRef(sessionId, input.taskId);
      if (!ref) return { success: false, error: `Unknown task ref: ${sessionId}:${input.taskId}` };
      return {
        success: true,
        output: JSON.stringify({
          ref,
          dependencies: registry.getDependencies(sessionId, input.taskId),
          dependents: registry.getDependents(sessionId, input.taskId),
        }),
      };
    }

    if (input.mode === 'status') {
      if (!input.taskId || !input.status) return { success: false, error: 'status requires taskId and status.' };
      const changed = registry.propagateStatus(sessionId, input.taskId, input.status);
      if (!changed) return { success: false, error: `Task ref not updated: ${sessionId}:${input.taskId}` };
      return { success: true, output: JSON.stringify(registry.getRef(sessionId, input.taskId)) };
    }

    if (input.mode === 'depend') {
      if (!input.taskId || !input.dependsOnTaskId) {
        return { success: false, error: 'depend requires taskId and dependsOnTaskId.' };
      }
      const ref = registry.getRef(sessionId, input.taskId);
      if (!ref) return { success: false, error: `Unknown task ref: ${sessionId}:${input.taskId}` };
      const result = registry.linkTask(
        ref,
        {
          sessionId: input.dependsOnSessionId?.trim() || sessionId,
          taskId: input.dependsOnTaskId,
        },
        input.reason,
      );
      if (!result.ok) return { success: false, error: result.error ?? 'dependency link failed' };
      return {
        success: true,
        output: JSON.stringify({
          ref,
          dependencies: registry.getDependencies(sessionId, input.taskId),
        }),
      };
    }

    if (input.mode === 'cancel') {
      const result = registry.cancel({
        sessionId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        scope: input.scope ?? 'task',
        requestedAt: Date.now(),
        ...(input.reason ? { reason: input.reason } : {}),
      });
      if (!result.ok) return { success: false, error: result.error ?? 'cancel failed' };
      return { success: true, output: JSON.stringify(result) };
    }

    if (input.mode === 'handoff') {
      if (!input.taskId || !input.toSessionId) {
        return { success: false, error: 'handoff requires taskId and toSessionId.' };
      }
      const result = registry.initiateHandoff(
        { sessionId, taskId: input.taskId },
        sessionId,
        input.toSessionId,
        input.reason,
      );
      if (!result.ok) return { success: false, error: result.error ?? 'handoff failed' };
      return { success: true, output: JSON.stringify({ handoffId: result.handoffId }) };
    }

    if (input.mode === 'handoffs') {
      return { success: true, output: JSON.stringify({ handoffs: registry.getHandoffs() }) };
    }

    return { success: false, error: `Unknown mode: ${input.mode}` };
  },
};
