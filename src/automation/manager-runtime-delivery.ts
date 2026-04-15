import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { AutomationDeliveryManager } from './delivery-manager.ts';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation/runs';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

interface AutomationFailureFollowUpContext {
  readonly jobs: Map<string, AutomationJob>;
  readonly retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly deliveryManager: AutomationDeliveryManager | null;
  readonly activeRunCount: () => number;
  readonly maxConcurrentRuns: () => number;
  readonly executeJob: (job: AutomationJob, trigger: 'scheduled', dueRun: boolean, attempt?: number) => Promise<AutomationRun>;
  readonly saveJobs: () => Promise<void>;
  readonly scheduleJob: (job: AutomationJob) => void;
}

interface AutomationRunDeliveryContext {
  readonly runs: Map<string, AutomationRun>;
  readonly deliveryInFlight: Set<string>;
  readonly deliveryManager: AutomationDeliveryManager | null;
  readonly syncRunToRuntime: (run: AutomationRun, source: string) => void;
  readonly saveRuns: () => Promise<void>;
}

export function scheduleAutomationFailureFollowUp(
  context: AutomationFailureFollowUpContext,
  maybeDeliverFailureNotice: (job: AutomationJob, run: AutomationRun) => void,
  job: AutomationJob,
  run: AutomationRun,
): void {
  maybeDeliverFailureNotice(job, run);
  if (!job.enabled) return;

  if (job.failure.action === 'cooldown') {
    const cooled: AutomationJob = {
      ...job,
      nextRunAt: Date.now() + Math.max(1_000, job.failure.cooldownMs),
      updatedAt: Date.now(),
    };
    context.jobs.set(job.id, cooled);
    context.scheduleJob(cooled);
    void context.saveJobs();
    return;
  }

  const maxAttempts = Math.max(1, job.execution.maxAttempts ?? 1);
  if (job.failure.action !== 'retry' || run.attempt >= maxAttempts) {
    return;
  }
  const retryKey = `${job.id}:${run.id}`;
  const existing = context.retryTimers.get(retryKey);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    context.retryTimers.delete(retryKey);
    const latestJob = context.jobs.get(job.id);
    if (!latestJob?.enabled) return;
    if (context.activeRunCount() >= context.maxConcurrentRuns()) {
      scheduleAutomationFailureFollowUp(context, maybeDeliverFailureNotice, latestJob, run);
      return;
    }
    void context.executeJob(latestJob, 'scheduled', false, run.attempt + 1).catch((error) => {
      logger.warn('AutomationManager: retry execution failed', {
        jobId: latestJob.id,
        runId: run.id,
        attempt: run.attempt + 1,
        error: summarizeError(error),
      });
    });
  }, Math.max(1_000, job.failure.cooldownMs));
  context.retryTimers.set(retryKey, timer);
}

export function maybeDeliverAutomationFailureNotice(
  deliveryManager: AutomationDeliveryManager | null,
  job: AutomationJob,
  run: AutomationRun,
): void {
  if (!deliveryManager) return;
  const routeIds = [job.failure.notifyRouteId, job.failure.deadLetterRouteId].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (routeIds.length === 0) return;
  const targets = routeIds.map((routeId) => ({
    kind: 'surface',
    routeId,
  } as const));
  const message = [
    `Automation failure: ${job.name}`,
    `Run: ${run.id}`,
    `Status: ${run.status}`,
    run.error ? `Error: ${run.error}` : null,
    run.cancelledReason ? `Cancelled: ${run.cancelledReason}` : null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n');
  void deliveryManager.deliverText(job, run, message, targets).catch((error) => {
    logger.warn('AutomationManager: failure notice delivery failed', {
      jobId: job.id,
      runId: run.id,
      error: summarizeError(error),
    });
  });
}

export function maybeDeliverAutomationRun(
  context: AutomationRunDeliveryContext,
  job: AutomationJob,
  run: AutomationRun,
): void {
  if (!context.deliveryManager) return;
  if (job.delivery.mode === 'none') return;
  if (context.deliveryInFlight.has(run.id)) return;
  if (run.deliveryIds.length > 0) return;
  context.deliveryInFlight.add(run.id);
  void context.deliveryManager.deliverJobRun(job, run)
    .then(async (deliveryAttempts) => {
      if (deliveryAttempts.length === 0) return;
      const latest = context.runs.get(run.id);
      if (!latest) return;
      const updated: AutomationRun = {
        ...latest,
        deliveryIds: deliveryAttempts.map((attempt) => attempt.id),
        deliveryAttempts,
        updatedAt: Date.now(),
      };
      context.runs.set(updated.id, updated);
      context.syncRunToRuntime(updated, 'automation.delivery');
      await context.saveRuns();
    })
    .catch((error) => {
      logger.warn('AutomationManager: delivery failed', {
        runId: run.id,
        jobId: job.id,
        error: summarizeError(error),
      });
    })
    .finally(() => {
      context.deliveryInFlight.delete(run.id);
    });
}
