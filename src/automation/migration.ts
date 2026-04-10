import type { ScheduledTask, TaskRunRecord } from '../scheduler/scheduler.ts';
import type { AutomationDeliveryPolicy } from './delivery.ts';
import type { AutomationFailurePolicy } from './failures.ts';
import type { AutomationJob } from './jobs.ts';
import { getNextAutomationOccurrence, normalizeCronSchedule } from './schedules.ts';
import type { AutomationRun } from './runs.ts';
import type { AutomationExecutionPolicy } from './session-targets.ts';
import type { AutomationSourceRecord } from './sources.ts';

export interface LegacySchedulerSnapshot extends Record<string, unknown> {
  tasks?: ScheduledTask[];
  history?: TaskRunRecord[];
}

function buildLegacySource(task: ScheduledTask): AutomationSourceRecord {
  return {
    id: `legacy-source:${task.id}`,
    kind: 'schedule',
    label: `Legacy scheduler:${task.name}`,
    enabled: task.enabled,
    createdAt: task.createdAt,
    updatedAt: task.lastRun ?? task.createdAt,
    ...(task.lastRun ? { lastSeenAt: task.lastRun } : {}),
    metadata: {
      migratedFrom: 'scheduler',
      legacyTaskId: task.id,
    },
  };
}

function buildExecution(task: ScheduledTask): AutomationExecutionPolicy {
  return {
    prompt: task.prompt,
    ...(task.template ? { template: task.template } : {}),
    target: {
      kind: 'isolated',
      createIfMissing: true,
    },
    ...(task.model ? { modelId: task.model } : {}),
    sandboxMode: 'inherit',
  };
}

function buildDelivery(): AutomationDeliveryPolicy {
  return {
    mode: 'none',
    targets: [],
    fallbackTargets: [],
    includeSummary: true,
    includeTranscript: false,
    includeLinks: true,
  };
}

function buildFailure(task: ScheduledTask): AutomationFailurePolicy {
  return {
    action: 'retry',
    maxConsecutiveFailures: Math.max(1, task.missedRuns || 1),
    cooldownMs: 30_000,
    retryPolicy: {
      maxAttempts: 3,
      delayMs: 5_000,
      strategy: 'exponential',
      maxDelayMs: 60_000,
      jitterMs: 500,
    },
    disableAfterFailures: false,
  };
}

function migrateTask(task: ScheduledTask): AutomationJob {
  const schedule = normalizeCronSchedule(task.cron, task.timezone);
  const source = buildLegacySource(task);
  return {
    id: task.id,
    labels: ['legacy', 'scheduler'],
    createdAt: task.createdAt,
    updatedAt: task.lastRun ?? task.createdAt,
    createdBy: 'legacy-scheduler',
    updatedBy: 'legacy-scheduler',
    notes: 'Migrated from TaskScheduler',
    name: task.name,
    description: task.prompt.length > 240 ? `${task.prompt.slice(0, 237)}...` : task.prompt,
    status: task.enabled ? 'enabled' : 'paused',
    enabled: task.enabled,
    schedule,
    execution: buildExecution(task),
    delivery: buildDelivery(),
    failure: buildFailure(task),
    source,
    nextRunAt: task.enabled ? task.nextRun ?? getNextAutomationOccurrence(schedule) : task.nextRun,
    ...(task.lastRun ? { lastRunAt: task.lastRun } : {}),
    runCount: task.runCount,
    successCount: task.runCount,
    failureCount: 0,
    deleteAfterRun: false,
  };
}

function migrateRun(record: TaskRunRecord): AutomationRun {
  const source: AutomationSourceRecord = {
    id: `legacy-run-source:${record.taskId}`,
    kind: 'migration',
    label: 'Legacy scheduler migration',
    enabled: true,
    createdAt: record.startedAt,
    updatedAt: record.startedAt,
    lastSeenAt: record.startedAt,
    metadata: {
      migratedFrom: 'scheduler',
      legacyTaskId: record.taskId,
    },
  };
  return {
    id: `autorun-${record.taskId}-${record.startedAt}-${record.agentId || 'none'}`,
    labels: ['legacy', 'scheduler'],
    createdAt: record.startedAt,
    updatedAt: record.startedAt,
    createdBy: 'legacy-scheduler',
    updatedBy: 'legacy-scheduler',
    notes: 'Migrated scheduler run',
    jobId: record.taskId,
    status: record.status,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    triggeredBy: source,
    target: {
      kind: 'isolated',
      createIfMissing: true,
    },
    execution: {
      prompt: 'Migrated scheduler run',
      target: {
        kind: 'isolated',
        createIfMissing: true,
      },
      sandboxMode: 'inherit',
    },
    scheduleKind: 'cron',
    queuedAt: record.startedAt,
    startedAt: record.startedAt,
    ...(record.status !== 'running' ? { endedAt: record.startedAt, durationMs: 0 } : {}),
    forceRun: false,
    dueRun: true,
    attempt: 1,
    deliveryIds: [],
    ...(record.error ? { error: record.error } : {}),
  };
}

export function migrateLegacySchedules(snapshot: LegacySchedulerSnapshot): {
  jobs: AutomationJob[];
  runs: AutomationRun[];
} {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  return {
    jobs: tasks.map(migrateTask),
    runs: history.map(migrateRun),
  };
}
