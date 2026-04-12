import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { EmitterContext } from '../runtime/emitters/index.ts';
import {
  emitAutomationJobAutoDisabled,
  emitAutomationJobCreated,
  emitAutomationJobDisabled,
  emitAutomationJobEnabled,
  emitAutomationJobUpdated,
  emitAutomationRunCompleted,
  emitAutomationRunFailed,
  emitAutomationRunQueued,
  emitAutomationRunStarted,
} from '../runtime/emitters/index.ts';
import type { AutomationJob } from './jobs.ts';
import type { AutomationRun } from './runs.ts';

function automationEmitterContext(traceId: string, sessionId?: string): EmitterContext {
  return {
    sessionId: sessionId ?? 'automation',
    source: 'automation-manager',
    traceId,
  };
}

export function emitAutomationManagerJobCreated(runtimeBus: RuntimeEventBus | null, job: AutomationJob): void {
  if (!runtimeBus) return;
  emitAutomationJobCreated(runtimeBus, automationEmitterContext(job.id, job.execution.target.sessionId), {
    jobId: job.id,
    name: job.name,
    scheduleKind: job.schedule.kind,
    enabled: job.enabled,
  });
}

export function emitAutomationManagerJobUpdated(
  runtimeBus: RuntimeEventBus | null,
  job: AutomationJob,
  changedFields: string[],
): void {
  if (!runtimeBus) return;
  emitAutomationJobUpdated(runtimeBus, automationEmitterContext(job.id, job.execution.target.sessionId), {
    jobId: job.id,
    changedFields,
  });
  if (job.enabled) {
    emitAutomationJobEnabled(runtimeBus, automationEmitterContext(job.id, job.execution.target.sessionId), {
      jobId: job.id,
    });
  } else {
    emitAutomationJobDisabled(runtimeBus, automationEmitterContext(job.id, job.execution.target.sessionId), {
      jobId: job.id,
      reason: job.pausedReason ?? 'disabled',
    });
  }
}

export function emitAutomationManagerJobAutoDisabled(
  runtimeBus: RuntimeEventBus | null,
  job: AutomationJob,
  reason: string,
): void {
  if (!runtimeBus) return;
  emitAutomationJobAutoDisabled(runtimeBus, automationEmitterContext(job.id, job.execution.target.sessionId), {
    jobId: job.id,
    reason,
    consecutiveFailures: job.failureCount,
  });
}

export function emitAutomationManagerRunQueued(
  runtimeBus: RuntimeEventBus | null,
  job: AutomationJob,
  run: AutomationRun,
): void {
  if (!runtimeBus) return;
  emitAutomationRunQueued(runtimeBus, automationEmitterContext(run.id, job.execution.target.sessionId), {
    jobId: job.id,
    runId: run.id,
    scheduledAt: run.queuedAt,
    forced: run.forceRun,
  });
}

export function emitAutomationManagerRunStarted(
  runtimeBus: RuntimeEventBus | null,
  job: AutomationJob,
  run: AutomationRun,
): void {
  if (!runtimeBus || run.startedAt === undefined) return;
  emitAutomationRunStarted(runtimeBus, automationEmitterContext(run.id, job.execution.target.sessionId), {
    jobId: job.id,
    runId: run.id,
    startedAt: run.startedAt,
    attempt: run.attempt,
  });
}

export function emitAutomationManagerRunCompleted(
  runtimeBus: RuntimeEventBus | null,
  job: AutomationJob,
  run: AutomationRun,
  outcome: 'success' | 'partial' | 'failed' | 'cancelled',
): void {
  if (!runtimeBus || run.startedAt === undefined || run.endedAt === undefined) return;
  emitAutomationRunCompleted(runtimeBus, automationEmitterContext(run.id, job.execution.target.sessionId), {
    jobId: job.id,
    runId: run.id,
    startedAt: run.startedAt,
    completedAt: run.endedAt,
    durationMs: run.durationMs ?? Math.max(0, run.endedAt - run.startedAt),
    outcome,
  });
}

export function emitAutomationManagerRunFailed(
  runtimeBus: RuntimeEventBus | null,
  job: AutomationJob,
  run: AutomationRun,
  error: string,
  retryable: boolean,
): void {
  if (!runtimeBus || run.startedAt === undefined || run.endedAt === undefined) return;
  emitAutomationRunFailed(runtimeBus, automationEmitterContext(run.id, job.execution.target.sessionId), {
    jobId: job.id,
    runId: run.id,
    startedAt: run.startedAt,
    failedAt: run.endedAt,
    error,
    retryable,
  });
}
