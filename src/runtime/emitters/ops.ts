/**
 * Ops emitters — typed emission wrappers for the OpsEvent domain.
 *
 * Every intervention emits both a specific action event AND an OPS_AUDIT
 * entry with the reason code, as required by the Operator Control Plane spec.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.ts';
import type { EmitterContext } from './index.ts';
import type { OpsInterventionReason } from '@pellux/goodvibes-sdk/platform/runtime/events/ops';

/** Emit OPS_CONTEXT_WARNING when context usage crosses a warning threshold. */
export function emitOpsContextWarning(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { usage: number; threshold: number }
): void {
  bus.emit('ops', createEventEnvelope('OPS_CONTEXT_WARNING', {
    type: 'OPS_CONTEXT_WARNING',
    usage: data.usage,
    threshold: data.threshold,
  }, ctx));
}

/** Emit OPS_CACHE_METRICS for cache hit-rate and token accounting snapshots. */
export function emitOpsCacheMetrics(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    hitRate: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalInputTokens: number;
    turns: number;
  }
): void {
  bus.emit('ops', createEventEnvelope('OPS_CACHE_METRICS', {
    type: 'OPS_CACHE_METRICS',
    ...data,
  }, ctx));
}

/** Emit OPS_HELPER_USAGE for cumulative helper-model token/call snapshots. */
export function emitOpsHelperUsage(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { inputTokens: number; outputTokens: number; calls: number }
): void {
  bus.emit('ops', createEventEnvelope('OPS_HELPER_USAGE', {
    type: 'OPS_HELPER_USAGE',
    ...data,
  }, ctx));
}

// ── Generic helper ───────────────────────────────────────────────────────────

type OpsAuditData = {
  action: string;
  targetId: string;
  targetKind: 'task' | 'agent';
  reason: OpsInterventionReason;
  note?: string;
  outcome: 'success' | 'rejected' | 'error';
  errorMessage?: string;
  taskId?: string;
  agentId?: string;
};

function emitOpsAudit(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: OpsAuditData
): void {
  bus.emit('ops', createEventEnvelope('OPS_AUDIT', {
    type: 'OPS_AUDIT',
    action: data.action,
    targetId: data.targetId,
    targetKind: data.targetKind,
    reason: data.reason,
    note: data.note,
    outcome: data.outcome,
    errorMessage: data.errorMessage,
  }, { ...ctx, ...(data.taskId !== undefined ? { taskId: data.taskId } : {}), ...(data.agentId !== undefined ? { agentId: data.agentId } : {}) }));
}

// ── Task emitters ─────────────────────────────────────────────────────────────

/** Emit OPS_TASK_CANCELLED and a paired OPS_AUDIT event. */
export function emitOpsTaskCancelled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; reason: OpsInterventionReason; note?: string; outcome: 'success' | 'rejected' | 'error'; errorMessage?: string }
): void {
  bus.emit('ops', createEventEnvelope('OPS_TASK_CANCELLED', {
    type: 'OPS_TASK_CANCELLED',
    taskId: data.taskId,
    reason: data.reason,
    note: data.note,
  }, { ...ctx, taskId: data.taskId }));
  emitOpsAudit(bus, ctx, { action: 'task.cancel', targetId: data.taskId, targetKind: 'task', ...data });
}

/** Emit OPS_TASK_PAUSED and a paired OPS_AUDIT event. */
export function emitOpsTaskPaused(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; reason: OpsInterventionReason; note?: string; outcome: 'success' | 'rejected' | 'error'; errorMessage?: string }
): void {
  bus.emit('ops', createEventEnvelope('OPS_TASK_PAUSED', {
    type: 'OPS_TASK_PAUSED',
    taskId: data.taskId,
    reason: data.reason,
    note: data.note,
  }, { ...ctx, taskId: data.taskId }));
  emitOpsAudit(bus, ctx, { action: 'task.pause', targetId: data.taskId, targetKind: 'task', ...data });
}

/** Emit OPS_TASK_RESUMED and a paired OPS_AUDIT event. */
export function emitOpsTaskResumed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; reason: OpsInterventionReason; note?: string; outcome: 'success' | 'rejected' | 'error'; errorMessage?: string }
): void {
  bus.emit('ops', createEventEnvelope('OPS_TASK_RESUMED', {
    type: 'OPS_TASK_RESUMED',
    taskId: data.taskId,
    reason: data.reason,
    note: data.note,
  }, { ...ctx, taskId: data.taskId }));
  emitOpsAudit(bus, ctx, { action: 'task.resume', targetId: data.taskId, targetKind: 'task', ...data });
}

/** Emit OPS_TASK_RETRIED and a paired OPS_AUDIT event. */
export function emitOpsTaskRetried(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; reason: OpsInterventionReason; note?: string; outcome: 'success' | 'rejected' | 'error'; errorMessage?: string }
): void {
  bus.emit('ops', createEventEnvelope('OPS_TASK_RETRIED', {
    type: 'OPS_TASK_RETRIED',
    taskId: data.taskId,
    reason: data.reason,
    note: data.note,
  }, { ...ctx, taskId: data.taskId }));
  emitOpsAudit(bus, ctx, { action: 'task.retry', targetId: data.taskId, targetKind: 'task', ...data });
}

// ── Agent emitters ────────────────────────────────────────────────────────────

/** Emit OPS_AGENT_CANCELLED and a paired OPS_AUDIT event. */
export function emitOpsAgentCancelled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; reason: OpsInterventionReason; note?: string; outcome: 'success' | 'rejected' | 'error'; errorMessage?: string }
): void {
  bus.emit('ops', createEventEnvelope('OPS_AGENT_CANCELLED', {
    type: 'OPS_AGENT_CANCELLED',
    agentId: data.agentId,
    reason: data.reason,
    note: data.note,
  }, { ...ctx, agentId: data.agentId }));
  emitOpsAudit(bus, ctx, { action: 'agent.cancel', targetId: data.agentId, targetKind: 'agent', ...data });
}
