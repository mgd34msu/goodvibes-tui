import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { CreateAutomationJobInput, UpdateAutomationJobInput } from '@pellux/goodvibes-sdk/platform/automation/manager-runtime-helpers';
import {
  buildDefaultDelivery,
  buildDefaultExecution,
  buildDefaultFailurePolicy,
  buildDefaultSource,
  computeNextRun,
  normalizeProviderRoutingPolicy,
  normalizeOptionalString,
  normalizeStringList,
} from '@pellux/goodvibes-sdk/platform/automation/manager-runtime-helpers';

interface AutomationJobMutationContext {
  readonly configManager: ConfigManager;
  readonly jobs: Map<string, AutomationJob>;
  readonly saveJobs: () => Promise<void>;
  readonly scheduleJob: (job: AutomationJob) => void;
  readonly syncJobToRuntime: (job: AutomationJob, source: string) => void;
  readonly emitJobCreated: (job: AutomationJob) => void;
  readonly emitJobUpdated: (job: AutomationJob, changedFields: string[]) => void;
}

export async function createAutomationJobRecord(
  context: AutomationJobMutationContext,
  input: CreateAutomationJobInput,
): Promise<AutomationJob> {
  const now = Date.now();
  const enabled = input.enabled ?? true;
  const jobId = `auto-${randomUUID().slice(0, 8)}`;
  const job: AutomationJob = {
    id: jobId,
    labels: [],
    createdAt: now,
    updatedAt: now,
    createdBy: 'automation-manager',
    updatedBy: 'automation-manager',
    name: input.name.trim() || input.prompt.slice(0, 40),
    description: input.description ?? input.prompt,
    status: enabled ? 'enabled' : 'paused',
    enabled,
    schedule: input.schedule,
    execution: buildDefaultExecution(input, context.configManager),
    delivery: buildDefaultDelivery(input.delivery),
    failure: buildDefaultFailurePolicy(context.configManager, input.failure),
    source: buildDefaultSource(enabled, now),
    nextRunAt: enabled ? computeNextRun(input.schedule, now, jobId) : undefined,
    lastRunAt: undefined,
    lastRunId: undefined,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    pausedReason: enabled ? undefined : 'created-disabled',
    deleteAfterRun: input.deleteAfterRun ?? Boolean(context.configManager.get('automation.deleteAfterRun')),
    archivedAt: undefined,
  };
  context.jobs.set(job.id, job);
  await context.saveJobs();
  context.scheduleJob(job);
  context.syncJobToRuntime(job, 'automation.create');
  context.emitJobCreated(job);
  return job;
}

export async function toggleAutomationJobEnabled(
  context: AutomationJobMutationContext,
  jobId: string,
  enabled: boolean,
): Promise<AutomationJob | null> {
  const job = context.jobs.get(jobId);
  if (!job) return null;
  const updated: AutomationJob = {
    ...job,
    enabled,
    status: enabled ? 'enabled' : 'paused',
    pausedReason: enabled ? undefined : 'operator-disabled',
    updatedAt: Date.now(),
    nextRunAt: enabled ? computeNextRun(job.schedule, Date.now(), job.id) : undefined,
    source: {
      ...job.source,
      enabled,
      updatedAt: Date.now(),
    },
  };
  context.jobs.set(jobId, updated);
  await context.saveJobs();
  context.scheduleJob(updated);
  context.syncJobToRuntime(updated, 'automation.toggle');
  context.emitJobUpdated(updated, ['enabled', 'status', 'pausedReason', 'nextRunAt']);
  return updated;
}

export async function updateAutomationJobRecord(
  context: AutomationJobMutationContext,
  jobId: string,
  patch: UpdateAutomationJobInput,
): Promise<AutomationJob | null> {
  const job = context.jobs.get(jobId);
  if (!job) return null;

  const nextEnabled = patch.enabled ?? job.enabled;
  const prompt = patch.prompt ?? job.execution.prompt ?? job.description ?? job.name;
  const updatedAt = Date.now();
  const fallbackModelsPatch = patch.fallbackModels !== undefined || patch.fallbacks !== undefined
    ? normalizeStringList(patch.fallbackModels ?? patch.fallbacks)
    : undefined;
  const thinkingPatch = normalizeOptionalString(patch.thinking);
  const nextSchedule = patch.schedule ?? job.schedule;
  const nextModelProvider = patch.provider ?? job.execution.modelProvider;
  const nextFallbackModels = fallbackModelsPatch
    ?? normalizeStringList(patch.routing?.fallbackModels)
    ?? job.execution.fallbackModels
    ?? job.execution.routing?.fallbackModels;
  const updated: AutomationJob = {
    ...job,
    name: patch.name ?? job.name,
    description: patch.description ?? (patch.prompt ? patch.prompt : job.description),
    enabled: nextEnabled,
    status: nextEnabled ? 'enabled' : 'paused',
    schedule: nextSchedule,
    execution: {
      ...job.execution,
      prompt,
      template: patch.template ?? job.execution.template,
      target: patch.target ?? job.execution.target,
      modelId: patch.model ?? job.execution.modelId,
      modelProvider: nextModelProvider,
      fallbackModels: nextFallbackModels,
      routing: normalizeProviderRoutingPolicy({
        modelProvider: nextModelProvider,
        fallbackModels: nextFallbackModels,
        routing: patch.routing ?? job.execution.routing,
      }),
      reasoningEffort: patch.reasoningEffort ?? job.execution.reasoningEffort,
      thinking: thinkingPatch ?? job.execution.thinking,
      wakeMode: patch.wakeMode ?? job.execution.wakeMode,
      timeoutMs: patch.timeoutMs ?? job.execution.timeoutMs ?? (Number(context.configManager.get('automation.defaultTimeoutMs') ?? 0) || undefined),
      toolAllowlist: patch.toolAllowlist ?? job.execution.toolAllowlist,
      autoApprove: patch.autoApprove ?? job.execution.autoApprove,
      allowUnsafeExternalContent: patch.allowUnsafeExternalContent ?? job.execution.allowUnsafeExternalContent,
      externalContentSource: patch.externalContentSource ?? job.execution.externalContentSource,
      lightContext: patch.lightContext ?? job.execution.lightContext,
    },
    delivery: buildDefaultDelivery({
      ...job.delivery,
      ...(patch.delivery ?? {}),
    }),
    failure: buildDefaultFailurePolicy(context.configManager, {
      ...job.failure,
      ...(patch.failure ?? {}),
      retryPolicy: {
        ...job.failure.retryPolicy,
        ...(patch.failure?.retryPolicy ?? {}),
      },
    }),
    deleteAfterRun: patch.deleteAfterRun ?? job.deleteAfterRun,
    pausedReason: nextEnabled ? undefined : job.pausedReason ?? 'operator-disabled',
    nextRunAt: nextEnabled ? computeNextRun(nextSchedule, updatedAt, job.id) : undefined,
    updatedAt,
    source: {
      ...job.source,
      enabled: nextEnabled,
      updatedAt,
    },
  };

  context.jobs.set(jobId, updated);
  await context.saveJobs();
  context.scheduleJob(updated);
  context.syncJobToRuntime(updated, 'automation.update');
  context.emitJobUpdated(updated, ['name', 'description', 'schedule', 'execution', 'delivery', 'failure', 'enabled']);
  return updated;
}
