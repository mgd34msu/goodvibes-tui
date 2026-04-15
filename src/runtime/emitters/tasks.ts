/**
 * Task emitters — typed emission wrappers for TaskEvent domain.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.ts';
import type { EmitterContext } from './index.ts';

/** Emit TASK_CREATED when a new task enters the queue. */
export function emitTaskCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; agentId?: string; description: string; priority: number }
): void {
  bus.emit('tasks', createEventEnvelope('TASK_CREATED', { type: 'TASK_CREATED', ...data }, ctx));
}

/** Emit TASK_STARTED when task execution begins. */
export function emitTaskStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; agentId?: string }
): void {
  bus.emit('tasks', createEventEnvelope('TASK_STARTED', { type: 'TASK_STARTED', ...data }, ctx));
}

/** Emit TASK_BLOCKED when a task is waiting on a dependency. */
export function emitTaskBlocked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; agentId?: string; reason: string }
): void {
  bus.emit('tasks', createEventEnvelope('TASK_BLOCKED', { type: 'TASK_BLOCKED', ...data }, ctx));
}

/** Emit TASK_PROGRESS when a task makes measurable progress. */
export function emitTaskProgress(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; agentId?: string; progress: number; message?: string }
): void {
  bus.emit('tasks', createEventEnvelope('TASK_PROGRESS', { type: 'TASK_PROGRESS', ...data }, ctx));
}

/** Emit TASK_COMPLETED when a task finishes successfully. */
export function emitTaskCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; agentId?: string; durationMs: number }
): void {
  bus.emit('tasks', createEventEnvelope('TASK_COMPLETED', { type: 'TASK_COMPLETED', ...data }, ctx));
}

/** Emit TASK_FAILED when a task fails. */
export function emitTaskFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; agentId?: string; error: string; durationMs: number }
): void {
  bus.emit('tasks', createEventEnvelope('TASK_FAILED', { type: 'TASK_FAILED', ...data }, ctx));
}

/** Emit TASK_CANCELLED when a task is cancelled. */
export function emitTaskCancelled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { taskId: string; agentId?: string; reason?: string }
): void {
  bus.emit('tasks', createEventEnvelope('TASK_CANCELLED', { type: 'TASK_CANCELLED', ...data }, ctx));
}
