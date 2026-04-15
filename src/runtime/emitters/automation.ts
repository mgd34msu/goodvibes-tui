/**
 * Automation emitters — typed wrappers for AutomationEvent domain.
 */

import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { AutomationEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/automation';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';

function automationEvent<T extends AutomationEvent['type']>(
  type: T,
  data: Omit<Extract<AutomationEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<AutomationEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<AutomationEvent, { type: T }>, ctx);
}

export function emitAutomationJobCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; name: string; scheduleKind: 'at' | 'every' | 'cron'; enabled: boolean },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_JOB_CREATED', data, ctx));
}

export function emitAutomationJobUpdated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; changedFields: string[] },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_JOB_UPDATED', data, ctx));
}

export function emitAutomationJobEnabled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_JOB_ENABLED', data, ctx));
}

export function emitAutomationJobDisabled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; reason: string },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_JOB_DISABLED', data, ctx));
}

export function emitAutomationRunQueued(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; runId: string; scheduledAt: number; forced: boolean },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_RUN_QUEUED', data, ctx));
}

export function emitAutomationRunStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; runId: string; startedAt: number; attempt: number },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_RUN_STARTED', data, ctx));
}

export function emitAutomationRunCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    jobId: string;
    runId: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    outcome: 'success' | 'partial' | 'failed' | 'cancelled';
  },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_RUN_COMPLETED', data, ctx));
}

export function emitAutomationRunFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; runId: string; startedAt: number; failedAt: number; error: string; retryable: boolean },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_RUN_FAILED', data, ctx));
}

export function emitAutomationRunCancelled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; runId: string; cancelledAt: number; reason: string },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_RUN_CANCELLED', data, ctx));
}

export function emitAutomationScheduleError(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; scheduleText: string; error: string },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_SCHEDULE_ERROR', data, ctx));
}

export function emitAutomationJobAutoDisabled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; reason: string; consecutiveFailures: number },
): void {
  bus.emit('automation', automationEvent('AUTOMATION_JOB_AUTO_DISABLED', data, ctx));
}
