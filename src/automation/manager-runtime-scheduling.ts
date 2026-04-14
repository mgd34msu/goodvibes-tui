import { logger } from '../utils/logger.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { AutomationJob } from './jobs.ts';
import type { AutomationRun } from './runs.ts';
import type { AutomationRunTrigger } from './types.ts';
import { computeNextRun } from './manager-runtime-helpers.ts';
import { summarizeError } from '../utils/error-display.ts';

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface AutomationHeartbeatWake {
  readonly jobId: string;
  readonly jobName: string;
  readonly trigger: AutomationRunTrigger;
  readonly dueRun: boolean;
  readonly attempt: number;
  readonly queuedAt: number;
  readonly reason: string;
}

interface AutomationSchedulingContext {
  readonly configManager: ConfigManager;
  readonly jobs: Map<string, AutomationJob>;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
  readonly heartbeatWakes: Map<string, AutomationHeartbeatWake>;
  readonly running: () => boolean;
  readonly saveJobs: () => Promise<void>;
  readonly activeRunCount: () => number;
  readonly maxConcurrentRuns: () => number;
  readonly executeJob: (job: AutomationJob, trigger: AutomationRunTrigger, dueRun: boolean, attempt?: number) => Promise<AutomationRun>;
}

export function scheduleAutomationJob(context: AutomationSchedulingContext, job: AutomationJob): void {
  cancelAutomationTimer(context.timers, job.id);
  if (!context.running() || !job.enabled) return;

  const catchUpWindowMs = Number(context.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000;
  const nextRunAtCandidate = job.nextRunAt ?? computeNextRun(job.schedule, Date.now(), job.id);
  const nextRunAt = nextRunAtCandidate !== undefined && nextRunAtCandidate < (Date.now() - catchUpWindowMs)
    ? computeNextRun(job.schedule, Date.now(), job.id)
    : nextRunAtCandidate;
  if (nextRunAt === undefined) return;

  const refreshed: AutomationJob = {
    ...job,
    nextRunAt,
  };
  context.jobs.set(job.id, refreshed);
  void context.saveJobs();

  const delayMs = Math.max(0, nextRunAt - Date.now());
  if (delayMs > MAX_TIMEOUT_MS) {
    const timer = setTimeout(() => scheduleAutomationJob(context, refreshed), MAX_TIMEOUT_MS);
    context.timers.set(job.id, timer);
    return;
  }

  const timer = setTimeout(() => {
    const latest = context.jobs.get(job.id);
    if (!latest?.enabled) return;
    if (latest.execution.wakeMode === 'next-heartbeat') {
      queueHeartbeatWake(context.heartbeatWakes, latest, 'scheduled', true, 1, 'scheduled-due');
      return;
    }
    if (context.activeRunCount() >= context.maxConcurrentRuns()) {
      const deferred: AutomationJob = {
        ...latest,
        nextRunAt: Date.now() + 15_000,
        updatedAt: Date.now(),
      };
      context.jobs.set(latest.id, deferred);
      void context.saveJobs();
      scheduleAutomationJob(context, deferred);
      return;
    }
    void context.executeJob(latest, 'scheduled', true)
      .catch((error) => {
        logger.error('AutomationManager: scheduled execution failed', {
          jobId: latest.id,
          error: summarizeError(error),
        });
      })
      .finally(() => {
        const current = context.jobs.get(job.id);
        if (!current?.enabled) return;
        const next = computeNextRun(current.schedule, Date.now(), current.id);
        if (next !== undefined) {
          const updated: AutomationJob = {
            ...current,
            nextRunAt: next,
            updatedAt: Date.now(),
          };
          context.jobs.set(current.id, updated);
          void context.saveJobs();
          scheduleAutomationJob(context, updated);
          return;
        }
        const completedOneShot: AutomationJob = {
          ...current,
          enabled: false,
          status: 'paused',
          pausedReason: 'one-shot-complete',
          nextRunAt: undefined,
          updatedAt: Date.now(),
        };
        context.jobs.set(current.id, completedOneShot);
        cancelAutomationTimer(context.timers, current.id);
        void context.saveJobs();
      });
  }, delayMs);
  context.timers.set(job.id, timer);
}

export function cancelAutomationTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  jobId: string,
): void {
  const timer = timers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(jobId);
  }
}

export function queueDueHeartbeatAutomationJobs(
  jobs: Iterable<AutomationJob>,
  heartbeatWakes: Map<string, AutomationHeartbeatWake>,
  reason: string,
): void {
  const now = Date.now();
  for (const job of jobs) {
    if (!job.enabled || job.execution.wakeMode !== 'next-heartbeat') continue;
    if (job.nextRunAt === undefined || job.nextRunAt > now) continue;
    queueHeartbeatWake(heartbeatWakes, job, 'scheduled', true, 1, reason);
  }
}

export function queueHeartbeatWake(
  heartbeatWakes: Map<string, AutomationHeartbeatWake>,
  job: AutomationJob,
  trigger: AutomationRunTrigger,
  dueRun: boolean,
  attempt: number,
  reason: string,
): void {
  if (heartbeatWakes.has(job.id)) return;
  heartbeatWakes.set(job.id, {
    jobId: job.id,
    jobName: job.name,
    trigger,
    dueRun,
    attempt,
    queuedAt: Date.now(),
    reason,
  });
}

export function advanceScheduledHeartbeatAutomationJob(
  context: Pick<AutomationSchedulingContext, 'jobs' | 'saveJobs'>,
  timers: Map<string, ReturnType<typeof setTimeout>>,
  jobId: string,
  reschedule: (job: AutomationJob) => void,
): void {
  const current = context.jobs.get(jobId);
  if (!current?.enabled) return;
  const next = computeNextRun(current.schedule, Date.now(), current.id);
  if (next !== undefined) {
    const updated: AutomationJob = {
      ...current,
      nextRunAt: next,
      updatedAt: Date.now(),
    };
    context.jobs.set(current.id, updated);
    void context.saveJobs();
    reschedule(updated);
    return;
  }
  const completedOneShot: AutomationJob = {
    ...current,
    enabled: false,
    status: 'paused',
    pausedReason: 'one-shot-complete',
    nextRunAt: undefined,
    updatedAt: Date.now(),
  };
  context.jobs.set(current.id, completedOneShot);
  cancelAutomationTimer(timers, current.id);
  void context.saveJobs();
}
